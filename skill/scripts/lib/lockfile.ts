/**
 * Чтение `bun.lock` — текстового lockfile Bun (JSONC).
 *
 * Тот же источник правды, что у `bun pm ls --all` и `bun why`, но со структурой: путь установки,
 * точный родитель и его диапазон, какая копия кому досталась. Ни подпроцессов, ни разбора
 * ASCII-дерева, ни ANSI-кодов — и не нужно гадать, какая из напечатанных подряд копий «та самая».
 *
 * Формат `packages`:
 *   "<путь>": ["<имя>@<версия>", "<registry>", { dependencies, peerDependencies, ... }, "<sha512>"]
 *   "<имя>":  ["<имя>@workspace:<путь>"]                      — ссылка на воркспейс
 * Ключ — путь установки в node_modules: `axios/https-proxy-agent` = копия под axios.
 */

import { type Version, parseVersion } from './semver.ts';

/** `@scope/pkg` — один сегмент, а не два: путь режем с учётом скоупов. */
export function splitPkgPath(key: string): string[] {
  const parts = key.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.startsWith('@') && i + 1 < parts.length) out.push(`${parts[i]}/${parts[++i]}`);
    else out.push(parts[i]!);
  }
  return out;
}

/** `@scope/pkg@1.2.3` → [`@scope/pkg`, `1.2.3`]; хвостом может быть и `workspace:...`, и `npm:...`. */
export function splitSpec(spec: string): { name: string; rest: string } {
  const at = spec.indexOf('@', 1);
  return at === -1 ? { name: spec, rest: '' } : { name: spec.slice(0, at), rest: spec.slice(at + 1) };
}

export type LockPkg = {
  /** Ключ в `packages`: путь установки (`axios/https-proxy-agent`). */
  path: string;
  segments: string[];
  name: string;
  version: Version | null;
  /** Хвост спецификации, если это не обычная версия из registry (`workspace:apps/x`, `npm:y@1`). */
  resolution: string | null;
  workspace: boolean;
  deps: Record<string, string>;
  peers: Record<string, string>;
  optional: Record<string, string>;
};

export type Requirement = {
  owner: string;
  ownerVersion: string | null;
  ownerPath: string;
  range: string;
  kind: 'dependencies' | 'peerDependencies' | 'optionalDependencies';
  fromWorkspace: boolean;
  /** Какая копия реально досталась этому потребителю. */
  resolved: LockPkg | null;
};

export type LockTree = {
  present: boolean;
  note: string | null;
  byPath: Map<string, LockPkg>;
  byName: Map<string, LockPkg[]>;
  requiredBy: Map<string, Requirement[]>;
  /** Уже нормализованные Bun overrides: вложенные формы сведены к объектной. */
  overrides: Record<string, unknown>;
  trustedDependencies: string[];
};

export function emptyLock(note: string | null = null): LockTree {
  return {
    present: false,
    note,
    byPath: new Map(),
    byName: new Map(),
    requiredBy: new Map(),
    overrides: {},
    trustedDependencies: [],
  };
}

export function parseLock(text: string, rootName = '<root>'): LockTree {
  let raw: any;
  try {
    raw = Bun.JSONC.parse(text);
  } catch (e) {
    return emptyLock(`bun.lock не разобран: ${(e as Error).message}`);
  }

  const byPath = new Map<string, LockPkg>();
  const byName = new Map<string, LockPkg[]>();

  const remember = (pkg: LockPkg) => {
    byPath.set(pkg.path, pkg);
    const list = byName.get(pkg.name) ?? [];
    list.push(pkg);
    byName.set(pkg.name, list);
  };

  for (const [path, entry] of Object.entries<any>(raw?.packages ?? {})) {
    const spec: string = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== 'string') continue;
    const { name, rest } = splitSpec(spec);
    const version = parseVersion(rest);
    const meta = Array.isArray(entry) && typeof entry[2] === 'object' && entry[2] ? entry[2] : {};
    remember({
      path,
      segments: splitPkgPath(path),
      name,
      version,
      resolution: version ? null : rest || null,
      workspace: rest.startsWith('workspace:'),
      deps: meta.dependencies ?? {},
      peers: meta.peerDependencies ?? {},
      optional: meta.optionalDependencies ?? {},
    });
  }

  // Воркспейсы объявляют свои зависимости отдельным блоком: в `packages` у них только ссылка.
  for (const [wsPath, ws] of Object.entries<any>(raw?.workspaces ?? {})) {
    const name: string = ws?.name ?? (wsPath || rootName);
    const path = wsPath === '' ? '' : name;
    const existing = byPath.get(path);
    const pkg: LockPkg = existing ?? {
      path,
      segments: path ? splitPkgPath(path) : [],
      name,
      version: ws?.version ? parseVersion(ws.version) : null,
      resolution: `workspace:${wsPath || '.'}`,
      workspace: true,
      deps: {},
      peers: {},
      optional: {},
    };
    pkg.workspace = true;
    pkg.deps = { ...(ws?.dependencies ?? {}), ...(ws?.devDependencies ?? {}) };
    pkg.peers = { ...(ws?.peerDependencies ?? {}) };
    pkg.optional = { ...(ws?.optionalDependencies ?? {}) };
    if (!existing) remember(pkg);
  }

  /** Разрешение как в node_modules: ближайший каталог вверх по цепочке путей. */
  const resolveFrom = (segments: string[], name: string): LockPkg | null => {
    for (let depth = segments.length; depth >= 0; depth--) {
      const hit = byPath.get([...segments.slice(0, depth), name].join('/'));
      if (hit) return hit;
    }
    return null;
  };

  const requiredBy = new Map<string, Requirement[]>();
  for (const pkg of byPath.values()) {
    const fields: [Requirement['kind'], Record<string, string>][] = [
      ['dependencies', pkg.deps],
      ['peerDependencies', pkg.peers],
      ['optionalDependencies', pkg.optional],
    ];
    for (const [kind, block] of fields) {
      for (const [child, range] of Object.entries(block)) {
        const list = requiredBy.get(child) ?? [];
        list.push({
          owner: pkg.name,
          ownerVersion: pkg.version ? pkg.version.raw : null,
          ownerPath: pkg.path,
          range,
          kind,
          fromWorkspace: pkg.workspace,
          resolved: resolveFrom(pkg.segments, child),
        });
        requiredBy.set(child, list);
      }
    }
  }

  return {
    present: true,
    note: null,
    byPath,
    byName,
    requiredBy,
    overrides: raw?.overrides ?? {},
    trustedDependencies: Array.isArray(raw?.trustedDependencies) ? raw.trustedDependencies : [],
  };
}

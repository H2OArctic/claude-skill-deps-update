#!/usr/bin/env bun
/**
 * deps-scan — инвентаризация зависимостей Bun-воркспейса.
 *
 * Только чтение: не правит package.json, не ставит пакеты, не трогает lockfile.
 *
 * Usage:
 *   bun deps-scan.ts [--cwd <path>] [--json] [--no-net] [--no-why]
 *
 *   --no-net   не ходить в registry (только расхождения версий, пиннинг, overrides)
 *   --no-why   не читать установленное дерево (`bun pm ls --all`) и не запускать `bun why`
 *              для overrides: быстрее, но без вердиктов и без фактических версий
 *   --decisions <path>  журнал отложенных решений (по умолчанию <root>/.claude/deps-update.json)
 */

type SemVer = { major: number; minor: number; patch: number; pre: string | null };

type Spec =
  | { kind: 'caret' | 'tilde' | 'exact'; base: SemVer; raw: string }
  | { kind: 'any'; raw: string }
  | { kind: 'complex'; raw: string }
  | { kind: 'internal'; raw: string };

type DepRef = { workspace: string; field: string; raw: string };

type RegistryInfo = {
  latest: SemVer | null;
  latestRaw: string | null;
  versions: SemVer[];
  deprecatedLatest: string | null;
  error: string | null;
};

const RANGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** peerDependencies намеренно широкие (`*`, `>=10`) — это не расхождение версий. */
const ALIGNABLE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const INTERNAL_PREFIXES = ['workspace:', 'link:', 'file:', 'git+', 'github:', 'npm:', 'portal:', 'catalog:'];
const CONCURRENCY = 12;

// Пакеты без общего скоупа, которые всё равно обязаны обновляться одной группой.
// Скоуп (@scope/*) определяется автоматически, здесь — только связки «ядро ↔ его скоуп».
const FAMILY_ALIASES: Record<string, string> = {
  react: 'react-core',
  'react-dom': 'react-core',
  '@types/react': 'react-core',
  '@types/react-dom': 'react-core',
  vue: '@vue',
  nuxt: '@nuxt',
  svelte: '@sveltejs',
  eslint: '@eslint',
  storybook: '@storybook',
  jest: '@jest',
  tailwindcss: 'tailwind',
  '@tailwindcss/postcss': 'tailwind',
};

const args = Bun.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const root = opt('cwd') ?? process.cwd();
const asJson = flag('json');
const useNet = !flag('no-net');
const useWhy = !flag('no-why');

// ─── semver ───────────────────────────────────────────────────────────────────

function parseVersion(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null };
}

function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1; // release старше любого prerelease
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

const fmt = (v: SemVer) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}`;

function parseSpec(raw: string): Spec {
  const s = raw.trim();
  if (INTERNAL_PREFIXES.some((p) => s.startsWith(p))) return { kind: 'internal', raw: s };
  if (s === '' || s === '*' || s === 'x' || s === 'latest') return { kind: 'any', raw: s };

  const exact = parseVersion(s);
  if (exact) return { kind: 'exact', base: exact, raw: s };

  const ranged = /^([\^~])\s*(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (ranged) {
    return {
      kind: ranged[1] === '^' ? 'caret' : 'tilde',
      base: { major: +ranged[2]!, minor: +ranged[3]!, patch: +(ranged[4] ?? 0), pre: ranged[5] ?? null },
      raw: s,
    };
  }
  // `^1.3`, `1.x`, `>=2 <3`, `a || b` — не угадываем, отдаём человеку
  return { kind: 'complex', raw: s };
}

/** Верхняя граница (исключительная) для caret/tilde. */
function upperBound(spec: Spec): SemVer | null {
  if (spec.kind === 'tilde') return { major: spec.base.major, minor: spec.base.minor + 1, patch: 0, pre: null };
  if (spec.kind !== 'caret') return null;
  const { major, minor, patch } = spec.base;
  if (major > 0) return { major: major + 1, minor: 0, patch: 0, pre: null };
  if (minor > 0) return { major: 0, minor: minor + 1, patch: 0, pre: null };
  return { major: 0, minor: 0, patch: patch + 1, pre: null };
}

function allows(spec: Spec, v: SemVer): boolean {
  if (spec.kind === 'any') return v.pre === null;
  if (spec.kind === 'exact') return compare(spec.base, v) === 0;
  if (spec.kind === 'internal' || spec.kind === 'complex') return false;
  if (v.pre !== null) return false; // prerelease не попадает в ^/~ без явного указания
  const upper = upperBound(spec)!;
  return compare(v, spec.base) >= 0 && compare(v, upper) < 0;
}

/** Максимум из versions, удовлетворяющий spec. */
function maxSatisfying(versions: SemVer[], spec: Spec): SemVer | null {
  let best: SemVer | null = null;
  for (const v of versions) if (allows(spec, v) && (!best || compare(v, best) > 0)) best = v;
  return best;
}

type Risk = 'up-to-date' | 'patch' | 'minor' | 'major' | 'zero-minor-breaking' | 'zero-patch-breaking' | 'prerelease';

/**
 * Класс риска перехода from → to.
 * Ключевой нюанс: при major === 0 semver-гарантий нет, минор = мажор
 * (смена минора ломает так же, как 1.x → 2.0), а при 0.0.x ломает даже патч.
 */
function riskClass(from: SemVer, to: SemVer): Risk {
  const c = compare(from, to);
  if (c >= 0) return 'up-to-date';
  if (to.pre !== null) return 'prerelease';
  if (from.major !== to.major) return 'major';
  if (from.major === 0) {
    if (from.minor !== to.minor) return 'zero-minor-breaking';
    if (from.minor === 0) return 'zero-patch-breaking';
    return 'patch';
  }
  if (from.minor !== to.minor) return 'minor';
  return 'patch';
}

/** Чем меньше число, тем серьёзнее риск. */
const RISK_ORDER: Record<string, number> = {
  'zero-patch-breaking': 0,
  'zero-minor-breaking': 1,
  major: 2,
  minor: 3,
  patch: 4,
  prerelease: 5,
  unknown: 6,
  'up-to-date': 7,
};

const RISK_LABEL: Record<string, string> = {
  patch: 'PATCH — безопасно',
  minor: 'MINOR — обычно безопасно',
  major: 'MAJOR — вручную, читать changelog',
  'zero-minor-breaking': '0.x MINOR — ЛОМАЮЩЕЕ (semver-гарантий нет)',
  'zero-patch-breaking': '0.0.x PATCH — ЛОМАЮЩЕЕ',
  prerelease: 'PRERELEASE — latest нестабильный',
  'up-to-date': 'в пределах требований родителя',
  unknown: 'НЕИЗВЕСТНО',
};

function family(name: string): string | null {
  if (FAMILY_ALIASES[name]) return FAMILY_ALIASES[name]!;
  if (!name.startsWith('@')) return null;
  const scope = name.slice(0, name.indexOf('/'));
  return scope === '@types' ? null : scope; // @types/* живут своей жизнью, это не семейство
}

// ─── чтение воркспейса ────────────────────────────────────────────────────────

async function readJson(path: string): Promise<any | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch (e) {
    throw new Error(`не удалось разобрать ${path}: ${(e as Error).message}`);
  }
}

const rootPkg = await readJson(`${root}/package.json`);
if (!rootPkg) {
  console.error(`package.json не найден в ${root} — укажи корень через --cwd`);
  process.exit(1);
}

const wsField = rootPkg.workspaces;
const wsPatterns: string[] = Array.isArray(wsField) ? wsField : (wsField?.packages ?? []);
const catalog: Record<string, string> = {
  ...(wsField?.catalog ?? {}),
  ...Object.values<Record<string, string>>(wsField?.catalogs ?? {}).reduce((a, c) => ({ ...a, ...c }), {}),
};

const pkgPaths = new Set<string>([`${root}/package.json`]);
for (const pattern of wsPatterns) {
  for await (const hit of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root, onlyFiles: true })) {
    pkgPaths.add(`${root}/${hit}`);
  }
}

/** name → все места, где он объявлен */
const deps = new Map<string, DepRef[]>();
const localNames = new Set<string>();

for (const path of [...pkgPaths].sort()) {
  const pkg = await readJson(path);
  if (!pkg) continue;
  if (pkg.name) localNames.add(pkg.name);
  const label = path === `${root}/package.json` ? '<root>' : (pkg.name ?? path.replace(`${root}/`, ''));

  for (const field of RANGE_FIELDS) {
    for (const [name, rawSpec] of Object.entries<string>(pkg[field] ?? {})) {
      const raw = rawSpec.startsWith('catalog:')
        ? (catalog[rawSpec.slice('catalog:'.length).trim() || name] ?? rawSpec)
        : rawSpec;
      const list = deps.get(name) ?? [];
      list.push({ workspace: label, field, raw });
      deps.set(name, list);
    }
  }
}

const overrides: Record<string, string> = { ...(rootPkg.overrides ?? {}), ...(rootPkg.resolutions ?? {}) };

// ─── журнал отложенных решений ────────────────────────────────────────────────

type Decision = {
  package: string;
  declinedVersion: string;
  installedAtDecision?: string;
  reason: string;
  decidedAt: string;
  revisit: { whenBlockerAllows?: string[]; whenMajorAbove?: number; after?: string };
};

const journalPath = opt('decisions') ?? `${root}/.claude/deps-update.json`;
const journalFile = Bun.file(journalPath);
const decisions = new Map<string, Decision>();
if (await journalFile.exists()) {
  for (const d of (await journalFile.json())?.deferred ?? []) decisions.set(d.package, d);
}

// ─── registry ─────────────────────────────────────────────────────────────────

const external = [...deps.keys()].filter((name) => {
  if (localNames.has(name)) return false;
  return deps.get(name)!.some((r) => parseSpec(r.raw).kind !== 'internal');
});

const registry = new Map<string, RegistryInfo>();

async function fetchInfo(name: string): Promise<RegistryInfo> {
  const base = (process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) {
      return { latest: null, latestRaw: null, versions: [], deprecatedLatest: null, error: `HTTP ${res.status}` };
    }
    const body: any = await res.json();
    const latestRaw: string | null = body['dist-tags']?.latest ?? null;
    const versions = Object.keys(body.versions ?? {})
      .map(parseVersion)
      .filter((v): v is SemVer => v !== null);
    return {
      latest: latestRaw ? parseVersion(latestRaw) : null,
      latestRaw,
      versions,
      deprecatedLatest: latestRaw ? (body.versions?.[latestRaw]?.deprecated ?? null) : null,
      error: null,
    };
  } catch (e) {
    return { latest: null, latestRaw: null, versions: [], deprecatedLatest: null, error: (e as Error).message };
  }
}

if (useNet) {
  const queue = [...external];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let name = queue.pop(); name; name = queue.pop()) registry.set(name, await fetchInfo(name));
    }),
  );
}

// ─── анализ ───────────────────────────────────────────────────────────────────

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Все установленные копии каждого пакета из `bun pm ls --all` — один вызов на весь скан.
 *
 * Копий может быть несколько: одна ветка дерева тянет 1.x, другая 5.x. Спрашивать версию
 * у `bun why` нельзя — он печатает копии подряд, и любой «первый матч» врёт про остальные.
 */
async function installedTree(): Promise<Map<string, string[]>> {
  const proc = Bun.spawn(['bun', 'pm', 'ls', '--all'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const out = stripAnsi(await new Response(proc.stdout).text());
  await proc.exited;

  const found = new Map<string, Set<string>>();
  for (const raw of out.split('\n')) {
    const line = raw.replace(/^[\s│├└─]+/, '').trim();
    // Жадная первая группа отдаёт последний `@`, поэтому `@scope/pkg@1.2.3` режется верно.
    const m = /^(.+)@([0-9][^@\s]*)$/.exec(line);
    if (!m) continue;
    const versions = found.get(m[1]!) ?? new Set<string>();
    versions.add(m[2]!);
    found.set(m[1]!, versions);
  }

  const sortVersions = (a: string, b: string) => {
    const [pa, pb] = [parseVersion(a), parseVersion(b)];
    return pa && pb ? compare(pa, pb) : a.localeCompare(b);
  };
  return new Map([...found].map(([name, versions]) => [name, [...versions].sort(sortVersions)]));
}

/** Диапазоны родителей из `bun why <pkg> --top`. */
async function parentRanges(name: string): Promise<string[]> {
  return [...new Set((await parentRequirements(name)).map((r) => r.range))];
}

/**
 * Требования родителей с пометкой, чьи они.
 *
 * `bun why` печатает и наши воркспейсы (`backend@workspace (requires ^5.11.1)`) — для вопроса
 * «отпустил ли блокер» они не считаются: это ровно тот диапазон, который мы и собираемся менять.
 */
async function parentRequirements(name: string): Promise<{ owner: string; range: string; fromWorkspace: boolean }[]> {
  const proc = Bun.spawn(['bun', 'why', name, '--top'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const out = stripAnsi(await new Response(proc.stdout).text());
  await proc.exited;

  const seen = new Set<string>();
  const result: { owner: string; range: string; fromWorkspace: boolean }[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/^[\s│├└─]+/, '').trim();
    const m = /^(?:optional )?(?:peer )?(\S+) \(requires ([^)]+)\)/.exec(line);
    if (!m) continue;
    const [owner, range] = [m[1]!, m[2]!.trim()];
    const key = `${owner}|${range}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ owner, range, fromWorkspace: owner.endsWith('@workspace') });
  }
  return result;
}

/** Диапазон целиком разобран (каждая альтернатива — ^/~/точная/любая), значит по нему можно судить. */
const rangeUnderstood = (range: string) =>
  range.split('||').every((alt) => ['caret', 'tilde', 'exact', 'any'].includes(parseSpec(alt).kind));

const installed = useWhy ? await installedTree() : new Map<string, string[]>();
const copiesOf = (name: string) => installed.get(name) ?? [];
const maxInstalled = (name: string): SemVer | null => {
  const parsed = copiesOf(name)
    .map(parseVersion)
    .filter((v): v is SemVer => v !== null);
  return parsed.length ? parsed.reduce((a, b) => (compare(a, b) > 0 ? a : b)) : null;
};

type OverrideVerdict = {
  name: string;
  spec: string;
  copies: string[];
  verdict: 'REDUNDANT_NOW' | 'RAISES_FLOOR' | 'BREAKS_CEILING' | 'NOT_APPLIED' | 'UNKNOWN';
  gap: Risk | null;
  parents: string[];
  alsoDirect: boolean;
};

/** Допускает ли диапазон родителя (возможно, с `||`) версию v. */
const rangeAllows = (range: string, v: SemVer) => range.split('||').some((alt) => allows(parseSpec(alt), v));

/** Минимальная версия, требуемая диапазоном родителя. */
function rangeFloor(range: string): SemVer | null {
  let floor: SemVer | null = null;
  for (const alt of range.split('||')) {
    const spec = parseSpec(alt);
    if (spec.kind !== 'caret' && spec.kind !== 'tilde' && spec.kind !== 'exact') continue;
    if (!floor || compare(spec.base, floor) < 0) floor = spec.base;
  }
  return floor;
}

const overrideReport: OverrideVerdict[] = [];

for (const [name, spec] of Object.entries(overrides)) {
  const parsed = parseSpec(spec);
  const overrideFloor = parsed.kind === 'caret' || parsed.kind === 'tilde' || parsed.kind === 'exact' ? parsed.base : null;
  const alsoDirect = deps.has(name);

  if (!useWhy || !overrideFloor) {
    overrideReport.push({ name, spec, copies: copiesOf(name), verdict: 'UNKNOWN', gap: null, parents: [], alsoDirect });
    continue;
  }

  const ranges = await parentRanges(name);
  const copies = copiesOf(name);
  const installedVer = maxInstalled(name);
  // Разрыв мерим до фактически стоящей версии: именно её родитель и не заказывал.
  const target = installedVer && compare(installedVer, overrideFloor) > 0 ? installedVer : overrideFloor;
  // Ни одна копия не удовлетворяет override — он не доехал до дерева (устаревший lockfile
  // либо ветки, которые Bun не переопределил). Диапазонные вердикты тут бессмысленны.
  const notApplied = copies.length > 0 && !copies.some((v) => {
    const parsedCopy = parseVersion(v);
    return parsedCopy !== null && allows(parsed, parsedCopy);
  });
  let ceilingBroken = false;
  let floorRaised = false;
  let gap: Risk | null = null;

  for (const range of ranges) {
    const floor = rangeFloor(range);
    if (!rangeAllows(range, overrideFloor)) {
      ceilingBroken = true;
      if (floor) {
        const cls = riskClass(floor, target);
        if (!gap || RISK_ORDER[cls]! < RISK_ORDER[gap]!) gap = cls;
      }
    }
    if (floor && compare(floor, overrideFloor) < 0) floorRaised = true;
  }

  overrideReport.push({
    name,
    spec,
    copies,
    verdict: notApplied
      ? 'NOT_APPLIED'
      : ranges.length === 0
        ? 'UNKNOWN'
        : ceilingBroken
          ? 'BREAKS_CEILING'
          : floorRaised
            ? 'RAISES_FLOOR'
            : 'REDUNDANT_NOW',
    gap,
    parents: ranges,
    alsoDirect,
  });
}

type Row = {
  name: string;
  specs: string[];
  mismatch: boolean;
  pinned: boolean;
  floor: string | null;
  copies: string[];
  atLatest: boolean;
  inRangeMax: string | null;
  latest: string | null;
  risk: Risk | 'unknown';
  deprecated: string | null;
  workspaces: string[];
  family: string | null;
  inOverrides: string | null;
  note: string | null;
  peerSpecs: string[];
  deferred: Decision | null;
  /** Почему пора вернуться к отложенному вопросу; null — решение ещё в силе. */
  revisit: string | null;
  /** Внешние родители, которые всё ещё держат пакет на месте. */
  heldBy: string[];
};

/**
 * Отложенное решение живо, пока держится причина отказа. Вернуться к вопросу нужно, когда
 * блокер отпустил пакет, вышел следующий мажор, истёк срок или проект уже ушёл вперёд сам.
 */
async function deferredStatus(
  decision: Decision,
  row: Omit<Row, 'deferred' | 'revisit' | 'heldBy'>,
): Promise<{ revisit: string | null; heldBy: string[] }> {
  const declined = parseVersion(decision.declinedVersion);
  const latest = row.latest ? parseVersion(row.latest) : null;
  const floor = row.floor ? parseVersion(row.floor) : null;
  const held: string[] = [];

  if (declined && floor && compare(floor, declined) >= 0) {
    return {
      revisit: `проект уже на ${row.floor} — решение устарело, убрать из журнала (\`decisions.ts resume ${row.name}\`)`,
      heldBy: held,
    };
  }
  if (decision.revisit.after && decision.revisit.after <= new Date().toISOString().slice(0, 10)) {
    return { revisit: `истёк срок отсрочки (${decision.revisit.after})`, heldBy: held };
  }
  // Мажор отклонённой версии — нижняя граница: журнал с меньшим значением иначе срабатывал бы сразу.
  const majorAbove = Math.max(decision.revisit.whenMajorAbove ?? -Infinity, declined?.major ?? -Infinity);
  if (Number.isFinite(majorAbove) && latest && latest.major > majorAbove) {
    return {
      revisit: `вышел мажор ${latest.major}.x, отклоняли ${decision.declinedVersion} — это уже другое обновление`,
      heldBy: held,
    };
  }
  const named = decision.revisit.whenBlockerAllows ?? [];
  if (named.length && latest && useWhy && row.copies.length > 0) {
    const external = (await parentRequirements(row.name)).filter((r) => !r.fromWorkspace);
    const blocking = external.filter((r) => rangeUnderstood(r.range) && !rangeAllows(r.range, latest));
    held.push(...blocking.map((r) => `${r.owner} requires ${r.range}`));

    // Судим только по блокерам, которые названы в решении: у листового пакета внешних родителей
    // нет вовсе, и «никто не ограничивает» срабатывало бы каждый прогон.
    const ownerName = (owner: string) => owner.replace(/@[^@]+$/, '');
    const stillBlocking = blocking.filter((r) => named.includes(ownerName(r.owner)));
    if (stillBlocking.length === 0) {
      const gone = named.filter((n) => !external.some((r) => ownerName(r.owner) === n));
      const reason = gone.length === named.length
        ? `названный блокер (${named.join(', ')}) больше не тянет этот пакет`
        : `блокер отпустил: ${named.join(', ')} больше не ограничивает ${row.latest}`;
      return { revisit: reason, heldBy: held };
    }
  }
  return { revisit: null, heldBy: held };
}

const rows: Row[] = [];
const isAlignable = (field: string) => (ALIGNABLE_FIELDS as readonly string[]).includes(field);

for (const name of external) {
  const all = deps.get(name)!.filter((r) => parseSpec(r.raw).kind !== 'internal');
  // Анализируем только runtime/dev/optional: peer-диапазоны намеренно широкие.
  const refs = all.filter((r) => isAlignable(r.field));
  if (refs.length === 0) continue;

  const specs = [...new Set(refs.map((r) => r.raw))];
  const parsedSpecs = specs.map(parseSpec);
  const pinned = parsedSpecs.every((s) => s.kind === 'exact');
  const floors = parsedSpecs
    .map((s) => (s.kind === 'caret' || s.kind === 'tilde' || s.kind === 'exact' ? s.base : null))
    .filter((v): v is SemVer => v !== null);
  const floor = floors.length ? floors.reduce((a, b) => (compare(a, b) < 0 ? a : b)) : null;

  const info = registry.get(name);
  const widest = parsedSpecs.reduce<Spec | null>((best, s) => {
    if (s.kind === 'complex' || s.kind === 'internal') return best;
    if (!best) return s;
    const a = upperBound(s);
    const b = upperBound(best);
    if (!a || !b) return best;
    return compare(a, b) > 0 ? s : best;
  }, null);

  const inRangeMax = info && widest ? maxSatisfying(info.versions, widest) : null;
  const installedMax = maxInstalled(name);

  const base = {
    name,
    specs,
    mismatch: specs.length > 1,
    pinned,
    floor: floor ? fmt(floor) : null,
    copies: copiesOf(name),
    atLatest: !!(installedMax && info?.latest && compare(installedMax, info.latest) >= 0),
    inRangeMax: inRangeMax ? fmt(inRangeMax) : null,
    latest: info?.latestRaw ?? null,
    risk: floor && info?.latest ? riskClass(floor, info.latest) : ('unknown' as const),
    deprecated: info?.deprecatedLatest ?? null,
    workspaces: [...new Set(refs.map((r) => r.workspace))],
    family: family(name),
    inOverrides: overrides[name] ?? null,
    note: info?.error ? `registry: ${info.error}` : parsedSpecs.some((s) => s.kind === 'complex') ? 'сложный диапазон — проверить вручную' : null,
    peerSpecs: [...new Set(all.filter((r) => !isAlignable(r.field)).map((r) => `${r.raw} (${r.workspace})`))],
  };

  const decision = decisions.get(name) ?? null;
  const status = decision ? await deferredStatus(decision, base) : { revisit: null, heldBy: [] };
  rows.push({ ...base, deferred: decision, ...status });
}

rows.sort((a, b) => a.name.localeCompare(b.name));

// ─── вывод ────────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify({ root, workspaces: pkgPaths.size, rows, overrides: overrideReport }, null, 2));
  process.exit(0);
}

const line = (s = '') => console.log(s);

line(`# deps-scan: ${rootPkg.name ?? root}`);
line();
line(`- корень: \`${root}\``);
line(`- package.json просканировано: ${pkgPaths.size} (воркспейсов: ${pkgPaths.size - 1})`);
line(`- внешних зависимостей: ${external.length}, overrides/resolutions: ${Object.keys(overrides).length}`);
if (!useNet) line('- **--no-net**: latest не запрашивался, риск-классы недоступны');
if (!useWhy) line('- **--no-why**: установленное дерево не читалось, колонки «Установлено»/«Копии» пустые');
line();

const mismatches = rows.filter((r) => r.mismatch);
line(`## 1. Расхождения версий одной библиотеки (${mismatches.length})`);
line();
if (mismatches.length === 0) {
  line('Нет — одна версия во всех воркспейсах.');
} else {
  line('Выровнять до максимальной ДО обновления: разные диапазоны = разные копии в дереве.');
  line();
  for (const r of mismatches) {
    line(`- **${r.name}**: ${r.specs.map((s) => `\`${s}\``).join(' vs ')}`);
    for (const spec of r.specs) {
      const where = deps
        .get(r.name)!
        .filter((d) => d.raw === spec && isAlignable(d.field))
        .map((d) => d.workspace);
      line(`    - \`${spec}\` → ${where.join(', ')}`);
    }
    if (r.peerSpecs.length) line(`    - peer (не выравнивать): ${r.peerSpecs.map((p) => `\`${p}\``).join(', ')}`);
  }
}
line();

const declaredDupes = rows.filter((r) => r.copies.length > 1);
const transitiveDupes = [...installed].filter(
  ([name, versions]) => versions.length > 1 && !rows.some((r) => r.name === name) && !overrides[name],
).length;

line(`## 2. Дубли в дереве (${declaredDupes.length})`);
line();
if (!useWhy) {
  line('Дерево не читалось (`--no-why`) — дубли не проверялись.');
} else if (declaredDupes.length === 0) {
  line('Нет: у объявленных зависимостей по одной копии.');
} else {
  line('Объявленный пакет стоит в дереве в нескольких версиях — обычно из-за расхождения диапазонов');
  line('или чужого exact-требования. Это лишний вес, а для рантайм-библиотек (синглтоны, инстансы,');
  line('`instanceof`) — источник багов.');
  line();
  for (const r of declaredDupes) line(`- **${r.name}**: ${r.copies.join(' + ')} — объявлено ${r.specs.map((s) => `\`${s}\``).join(', ')}`);
}
if (transitiveDupes > 0) {
  line();
  line(`Транзитивных пакетов с несколькими копиями: ${transitiveDupes} — обычно норма, смотреть точечно (\`bun why <pkg>\`).`);
}
line();

const updatable = rows
  .filter((r) => r.risk !== 'up-to-date' && r.risk !== 'unknown')
  .sort((a, b) => (RISK_ORDER[a.risk]! - RISK_ORDER[b.risk]!) || a.name.localeCompare(b.name));

// Отложенные вопросы не показываем как кандидатов — иначе скилл спросит то же самое в каждый прогон.
const candidates = updatable.filter((r) => !r.deferred);
// Разбираем ВСЕ решения, а не только те, что ещё числятся кандидатами: запись про пакет, который
// тем временем обновился сам, иначе тихо жила бы в журнале вечно.
const deferredRows = rows.filter((r) => r.deferred);
const revisit = deferredRows.filter((r) => r.revisit);
const asleep = deferredRows.filter((r) => !r.revisit);
const orphaned = [...decisions.keys()].filter((name) => !rows.some((r) => r.name === name));

line(`## 3. Кандидаты на обновление (${candidates.length})`);
line();
if (candidates.length === 0) {
  line('Нет: всё на latest.');
} else {
  line('| Пакет | Диапазон | Установлено | Макс. в диапазоне | Latest | Класс | Семейство | В overrides | Воркспейсы |');
  line('|---|---|---|---|---|---|---|---|---|');
  for (const r of candidates) {
    const inRange = r.inRangeMax && r.inRangeMax !== r.floor ? `**${r.inRangeMax}**` : (r.inRangeMax ?? '—');
    const copies = r.copies.length ? r.copies.join(' + ') + (r.copies.length > 1 ? ' ⚠' : '') : '—';
    line(
      `| ${r.name}${r.pinned ? ' 📌' : ''} | ${r.specs.join(', ')} | ${copies} | ${inRange} | ${r.latest ?? '—'} | ${RISK_LABEL[r.risk]}${r.atLatest ? ' *(latest уже стоит)*' : ''} | ${r.family ?? '—'} | ${r.inOverrides ? `\`${r.inOverrides}\`` : '—'} | ${r.workspaces.join(', ')} |`,
    );
  }
  line();
  line('📌 — точный пиннинг (без `^`): сделано намеренно, диапазон не расширять.');
  line('«Диапазон» — то, что записано в package.json; «Установлено» — что реально в дереве (`bun pm ls --all`).');
  line('*(latest уже стоит)* — обновлять нечего, правка диапазона лишь приводит запись в соответствие факту.');
  line('⚠ — в дереве несколько копий пакета: разные ветки тянут разные версии.');
  line('Жирный «макс. в диапазоне» — подтянется само при пересборке lockfile, даже без правки package.json.');
}
line();
if (decisions.size) {
  line(`Отложенных решений в журнале: ${decisions.size} (\`${journalPath}\`) — см. разделы 3a и 3b.`);
  line();
}

line(`## 3a. Пора вернуться к отложенному (${revisit.length + orphaned.length})`);
line();
if (orphaned.length) {
  line(`Пакета больше нет в зависимостях, запись мертва: ${orphaned.join(', ')} — почистить \`decisions.ts prune\`.`);
  line();
}
if (revisit.length === 0) {
  line('Нечего поднимать: у отложенных решений причина отказа не изменилась.');
} else {
  line('Причина прежнего отказа изменилась — эти вопросы стоит задать снова:');
  line();
  for (const r of revisit) {
    line(`- **${r.name}**: отклоняли ${r.deferred!.declinedVersion} (${r.deferred!.decidedAt}, ${r.deferred!.reason})`);
    line(`    - сейчас latest ${r.latest ?? '—'}, объявлено ${r.specs.map((s) => `\`${s}\``).join(', ')}`);
    line(`    - **${r.revisit}**`);
  }
}
line();

line(`## 3b. Отложено — не спрашивать (${asleep.length})`);
line();
if (asleep.length === 0) {
  line('Пусто.');
} else {
  line('Решение в силе: причина отказа держится. Поднимать вопрос заново не нужно.');
  line();
  for (const r of asleep) {
    const when = [
      r.deferred!.revisit.whenBlockerAllows?.length ? `отпустит ${r.deferred!.revisit.whenBlockerAllows.join(', ')}` : null,
      r.deferred!.revisit.whenMajorAbove !== undefined ? `выйдет мажор выше ${r.deferred!.revisit.whenMajorAbove}` : null,
      r.deferred!.revisit.after ? `наступит ${r.deferred!.revisit.after}` : null,
    ].filter(Boolean);
    line(
      `- **${r.name}** ≠> ${r.deferred!.declinedVersion} (${r.deferred!.decidedAt}): ${r.deferred!.reason}` +
        ` — вернуться, когда ${when.length ? when.join(' / ') : 'решит человек (`decisions.ts resume`)'}`,
    );
    if (r.heldBy.length) line(`    - держит: ${r.heldBy.join('; ')}`);
  }
}
line();

const families = new Map<string, Row[]>();
for (const r of rows) {
  if (!r.family) continue;
  const list = families.get(r.family) ?? [];
  list.push(r);
  families.set(r.family, list);
}
const groups = [...families.entries()].filter(([, list]) => list.length > 1 && list.some((r) => candidates.includes(r)));

line(`## 4. Семейства — обновлять только целиком (${groups.length})`);
line();
if (groups.length === 0) {
  line('Нет затронутых семейств.');
} else {
  for (const [name, list] of groups) {
    const pinnedMark = list.every((r) => r.pinned) ? ' (всё запиннено точно)' : '';
    line(`- **${name}**${pinnedMark}: ${list.map((r) => `${r.name}@${r.specs.join('/')}`).join(', ')}`);
  }
}
line();

line(`## 5. Overrides / resolutions (${overrideReport.length})`);
line();
if (overrideReport.length === 0) {
  line('Нет.');
} else {
  line('| Пакет | Override | Копии в дереве | Вердикт | Разрыв с родителем | Прямая зависимость тоже |');
  line('|---|---|---|---|---|---|');
  for (const o of overrideReport) {
    const copies = o.copies.length ? o.copies.join(' + ') + (o.copies.length > 1 ? ' ⚠' : '') : '—';
    line(
      `| ${o.name} | \`${o.spec}\` | ${copies} | ${o.verdict} | ${o.gap ? RISK_LABEL[o.gap] : '—'} | ${o.alsoDirect ? '**да, синхронизировать**' : 'нет'} |`,
    );
  }
  line();
  line('**Вердикты ниже — гипотезы по диапазонам, а не факт.** Диапазоны родителей не говорят, что');
  line('override реально делает с деревом: Bun переопределяет не все ветки. Решает эксперимент —');
  line('снять все overrides разом, пересобрать, сравнить `bun audit` и копии (процедура в SKILL.md).');
  line();
  line('- `REDUNDANT_NOW` — родители сами требуют не меньше: кандидат на удаление.');
  line('- `RAISES_FLOOR` — поднимает минимум внутри допустимого родителями диапазона: похоже на security-override.');
  line('- `BREAKS_CEILING` — форсит версию выше той, что родитель считает совместимой. Часто фикция: если рядом');
  line('  стоит ⚠, старая копия всё равно осталась в дереве — потолок не сломан, override до неё не достал.');
  line('- `NOT_APPLIED` — ни одна установленная копия не попадает в override: lockfile разошёлся с package.json');
  line('  (нужен `bun install`) либо Bun эту ветку не переопределил. Вердикт по диапазонам тут не считается.');
  line('- `UNKNOWN` — диапазон не разобран или `bun why` без родителей.');
  line('- ⚠ — копий несколько: override не схлопнул дерево, часть веток живёт на своей версии.');
  line();
  for (const o of overrideReport.filter((x) => x.parents.length)) {
    line(`- ${o.name}: родители требуют ${o.parents.map((p) => `\`${p}\``).join(', ')}`);
  }
}
line();

const deprecated = rows.filter((r) => r.deprecated);
if (deprecated.length) {
  line(`## 6. Deprecated latest (${deprecated.length})`);
  line();
  for (const r of deprecated) line(`- **${r.name}**: ${r.deprecated}`);
  line();
}

const notes = rows.filter((r) => r.note);
if (notes.length) {
  line(`## 7. Требует ручной проверки (${notes.length})`);
  line();
  for (const r of notes) line(`- **${r.name}** (${r.specs.join(', ')}): ${r.note}`);
  line();
}

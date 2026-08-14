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
 *   --no-why   не запускать `bun why` для overrides (быстрее, но без вердиктов)
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
  prisma: '@prisma',
  payload: '@payloadcms',
  elysia: '@elysiajs',
  eslint: '@eslint',
  storybook: '@storybook',
  tailwindcss: 'tailwind',
  '@tailwindcss/postcss': 'tailwind',
  typechain: 'typechain',
  '@typechain/ethers-v6': 'typechain',
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
 * (0.35.x → 0.36.0 ломает так же, как 1.x → 2.0), а при 0.0.x ломает даже патч.
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

/** Диапазоны родителей из `bun why <pkg> --top`. */
async function parentRanges(name: string): Promise<{ installed: string | null; ranges: string[] }> {
  const proc = Bun.spawn(['bun', 'why', name, '--top'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const out = stripAnsi(await new Response(proc.stdout).text());
  await proc.exited;
  const installed = /^\s*\S+@(\S+)\s*$/m.exec(out)?.[1] ?? null;
  const ranges = [...out.matchAll(/\(requires ([^)]+)\)/g)].map((m) => m[1]!.trim());
  return { installed, ranges: [...new Set(ranges)] };
}

type OverrideVerdict = {
  name: string;
  spec: string;
  installed: string | null;
  verdict: 'REDUNDANT_NOW' | 'RAISES_FLOOR' | 'BREAKS_CEILING' | 'UNKNOWN';
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
    overrideReport.push({ name, spec, installed: null, verdict: 'UNKNOWN', gap: null, parents: [], alsoDirect });
    continue;
  }

  const { installed, ranges } = await parentRanges(name);
  const installedVer = installed ? parseVersion(installed) : null;
  // Разрыв мерим до фактически стоящей версии: именно её родитель и не заказывал.
  const target = installedVer && compare(installedVer, overrideFloor) > 0 ? installedVer : overrideFloor;
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
    installed,
    verdict: ranges.length === 0 ? 'UNKNOWN' : ceilingBroken ? 'BREAKS_CEILING' : floorRaised ? 'RAISES_FLOOR' : 'REDUNDANT_NOW',
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
  inRangeMax: string | null;
  latest: string | null;
  risk: Risk | 'unknown';
  deprecated: string | null;
  workspaces: string[];
  family: string | null;
  inOverrides: string | null;
  note: string | null;
  peerSpecs: string[];
};

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

  rows.push({
    name,
    specs,
    mismatch: specs.length > 1,
    pinned,
    floor: floor ? fmt(floor) : null,
    inRangeMax: inRangeMax ? fmt(inRangeMax) : null,
    latest: info?.latestRaw ?? null,
    risk: floor && info?.latest ? riskClass(floor, info.latest) : 'unknown',
    deprecated: info?.deprecatedLatest ?? null,
    workspaces: [...new Set(refs.map((r) => r.workspace))],
    family: family(name),
    inOverrides: overrides[name] ?? null,
    note: info?.error ? `registry: ${info.error}` : parsedSpecs.some((s) => s.kind === 'complex') ? 'сложный диапазон — проверить вручную' : null,
    peerSpecs: [...new Set(all.filter((r) => !isAlignable(r.field)).map((r) => `${r.raw} (${r.workspace})`))],
  });
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

const candidates = rows
  .filter((r) => r.risk !== 'up-to-date' && r.risk !== 'unknown')
  .sort((a, b) => (RISK_ORDER[a.risk]! - RISK_ORDER[b.risk]!) || a.name.localeCompare(b.name));

line(`## 2. Кандидаты на обновление (${candidates.length})`);
line();
if (candidates.length === 0) {
  line('Нет: всё на latest.');
} else {
  line('| Пакет | Сейчас | Макс. в диапазоне | Latest | Класс | Семейство | В overrides | Воркспейсы |');
  line('|---|---|---|---|---|---|---|---|');
  for (const r of candidates) {
    const inRange = r.inRangeMax && r.inRangeMax !== r.floor ? `**${r.inRangeMax}**` : (r.inRangeMax ?? '—');
    line(
      `| ${r.name}${r.pinned ? ' 📌' : ''} | ${r.specs.join(', ')} | ${inRange} | ${r.latest ?? '—'} | ${RISK_LABEL[r.risk]} | ${r.family ?? '—'} | ${r.inOverrides ? `\`${r.inOverrides}\`` : '—'} | ${r.workspaces.join(', ')} |`,
    );
  }
  line();
  line('📌 — точный пиннинг (без `^`): сделано намеренно, диапазон не расширять.');
  line('Жирный «макс. в диапазоне» — подтянется само при пересборке lockfile, даже без правки package.json.');
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

line(`## 3. Семейства — обновлять только целиком (${groups.length})`);
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

line(`## 4. Overrides / resolutions (${overrideReport.length})`);
line();
if (overrideReport.length === 0) {
  line('Нет.');
} else {
  line('| Пакет | Override | Установлено | Вердикт | Разрыв с родителем | Прямая зависимость тоже |');
  line('|---|---|---|---|---|---|');
  for (const o of overrideReport) {
    line(
      `| ${o.name} | \`${o.spec}\` | ${o.installed ?? '—'} | ${o.verdict} | ${o.gap ? RISK_LABEL[o.gap] : '—'} | ${o.alsoDirect ? '**да, синхронизировать**' : 'нет'} |`,
    );
  }
  line();
  line('- `REDUNDANT_NOW` — родители сами требуют не меньше: кандидат на удаление (проверить `bun audit` после).');
  line('- `RAISES_FLOOR` — поднимает минимум внутри допустимого родителями диапазона: обычный security-override, держать.');
  line('- `BREAKS_CEILING` — форсит версию выше той, что родитель считает совместимой: держать, но это риск API. Разрыв в мажор — красный флаг.');
  line('- `UNKNOWN` — диапазон не разобран или `bun why` без родителей.');
  line();
  for (const o of overrideReport.filter((x) => x.parents.length)) {
    line(`- ${o.name}: родители требуют ${o.parents.map((p) => `\`${p}\``).join(', ')}`);
  }
}
line();

const deprecated = rows.filter((r) => r.deprecated);
if (deprecated.length) {
  line(`## 5. Deprecated latest (${deprecated.length})`);
  line();
  for (const r of deprecated) line(`- **${r.name}**: ${r.deprecated}`);
  line();
}

const notes = rows.filter((r) => r.note);
if (notes.length) {
  line(`## 6. Требует ручной проверки (${notes.length})`);
  line();
  for (const r of notes) line(`- **${r.name}** (${r.specs.join(', ')}): ${r.note}`);
  line();
}

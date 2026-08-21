#!/usr/bin/env bun
/**
 * deps-scan — инвентаризация зависимостей Bun-воркспейса. Требует Bun >= 1.4.
 *
 * Только чтение: не правит package.json, не ставит пакеты, не трогает lockfile.
 * Внешние вызовы тоже read-only: `bun audit`, `bun audit fix --dry-run`, `bun dedupe --dry-run`.
 *
 * Дерево берётся из `bun.lock` (`Bun.JSONC.parse`), а не из вывода `bun pm ls`/`bun why`:
 * это тот же источник правды, но со структурой — путь установки, точный родитель и его диапазон.
 *
 * Usage:
 *   bun deps-scan.ts [--cwd <path>] [--json] [--no-net] [--no-tree] [--min-age <days>]
 *
 *   --no-net           не ходить в registry и не запускать `bun audit`: остаются расхождения,
 *                      пиннинг, overrides и дубли
 *   --no-tree          не читать bun.lock: быстрее, но без установленных версий, вердиктов и дублей
 *                      (алиас: --no-why)
 *   --min-age <days>   помечать версии, опубликованные меньше N дней назад. По умолчанию берётся
 *                      из bunfig.toml `install.minimumReleaseAge`; без него проверка выключена
 *   --decisions <path> журнал отложенных решений (по умолчанию <root>/.claude/deps-update.json)
 */

import {
  type Risk,
  type Spec,
  type Version,
  RISK_LABEL,
  RISK_ORDER,
  allows,
  cmp,
  family,
  fmt,
  isRange,
  maxSatisfying,
  parseSpec,
  parseVersion,
  rangeAllows,
  rangeFloor,
  riskClass,
} from './lib/semver.ts';
import { type LockTree, type Requirement, emptyLock, parseLock } from './lib/lockfile.ts';
import { type OverrideRule, flattenOverrides, normalizeOverrides } from './lib/overrides.ts';

// ─── аргументы ────────────────────────────────────────────────────────────────

const args = Bun.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const root = opt('cwd') ?? process.cwd();
const asJson = flag('json');
const useNet = !flag('no-net');
const useTree = !flag('no-tree') && !flag('no-why');
const CONCURRENCY = 12;

if (Bun.semver.order(Bun.version.replace(/-.*$/, ''), '1.4.0') < 0) {
  console.error(`deps-scan требует Bun >= 1.4 (сейчас ${Bun.version}): нужны Bun.JSONC, bun dedupe и bun audit fix.`);
  process.exit(1);
}

// ─── чтение воркспейса ────────────────────────────────────────────────────────

const RANGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** peerDependencies намеренно широкие (`*`, `>=10`) — это не расхождение версий. */
const ALIGNABLE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const isAlignable = (field: string) => (ALIGNABLE_FIELDS as readonly string[]).includes(field);

type DepRef = { workspace: string; field: string; raw: string; fromCatalog: string | null };

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
/**
 * Каталоги — единственная запись версии на весь монорепозиторий (`"catalog:"` в воркспейсах).
 * Bun принимает их и внутри `workspaces`, и на верхнем уровне package.json.
 */
const catalogs: Record<string, Record<string, string>> = { default: { ...rootPkg.catalog, ...wsField?.catalog } };
for (const named of [rootPkg.catalogs, wsField?.catalogs]) {
  for (const [name, entries] of Object.entries<Record<string, string>>(named ?? {})) {
    catalogs[name] = { ...catalogs[name], ...entries };
  }
}
const catalogLookup = (ref: string, name: string): { spec: string; catalog: string } | null => {
  const which = ref.slice('catalog:'.length).trim() || 'default';
  const spec = catalogs[which]?.[name];
  return spec ? { spec, catalog: which } : null;
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
      const viaCatalog = rawSpec.startsWith('catalog:') ? catalogLookup(rawSpec, name) : null;
      const list = deps.get(name) ?? [];
      list.push({ workspace: label, field, raw: viaCatalog?.spec ?? rawSpec, fromCatalog: viaCatalog?.catalog ?? null });
      deps.set(name, list);
    }
  }
}

// ─── bunfig.toml: политика проекта ────────────────────────────────────────────

type Policy = {
  path: string | null;
  /** Секунды. Bun сам откажется ставить релиз моложе этого возраста. */
  minimumReleaseAge: number | null;
  minimumReleaseAgeExcludes: string[];
  linker: string | null;
  scanner: string | null;
  error: string | null;
};

async function readPolicy(): Promise<Policy> {
  const empty: Policy = {
    path: null,
    minimumReleaseAge: null,
    minimumReleaseAgeExcludes: [],
    linker: null,
    scanner: null,
    error: null,
  };
  const path = `${root}/bunfig.toml`;
  const file = Bun.file(path);
  if (!(await file.exists())) return empty;
  try {
    const cfg: any = Bun.TOML.parse(await file.text());
    const install = cfg?.install ?? {};
    return {
      path,
      minimumReleaseAge: typeof install.minimumReleaseAge === 'number' ? install.minimumReleaseAge : null,
      minimumReleaseAgeExcludes: Array.isArray(install.minimumReleaseAgeExcludes) ? install.minimumReleaseAgeExcludes : [],
      linker: typeof install.linker === 'string' ? install.linker : null,
      scanner: typeof install.security?.scanner === 'string' ? install.security.scanner : null,
      error: null,
    };
  } catch (e) {
    return { ...empty, path, error: (e as Error).message };
  }
}

const policy = await readPolicy();

const minAgeDays = (() => {
  const explicit = opt('min-age');
  if (explicit !== undefined) {
    const n = Number(explicit);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return policy.minimumReleaseAge ? policy.minimumReleaseAge / 86_400 : null;
})();

// ─── bun.lock: установленное дерево ───────────────────────────────────────────

async function readLock(): Promise<LockTree> {
  if (!useTree) return emptyLock('флаг --no-tree');

  const textLock = Bun.file(`${root}/bun.lock`);
  if (!(await textLock.exists())) {
    return emptyLock(
      (await Bun.file(`${root}/bun.lockb`).exists())
        ? 'найден бинарный bun.lockb — выполни `bun install --save-text-lockfile`, чтобы дерево читалось'
        : 'bun.lock не найден — выполни `bun install`',
    );
  }
  return parseLock(await textLock.text(), rootPkg.name ?? '<root>');
}

const lock = await readLock();
const hasTree = lock.present;

const copiesOf = (name: string): string[] => {
  const versions = new Set<string>();
  for (const pkg of lock.byName.get(name) ?? []) if (pkg.version) versions.add(fmt(pkg.version));
  return [...versions].sort((a, b) => Bun.semver.order(a, b));
};

const maxInstalled = (name: string): Version | null => {
  const parsed = copiesOf(name)
    .map(parseVersion)
    .filter((v): v is Version => v !== null);
  return parsed.length ? parsed.reduce((a, b) => (cmp(a, b) > 0 ? a : b)) : null;
};

const requirementsFor = (name: string): Requirement[] => lock.requiredBy.get(name) ?? [];

// ─── overrides ────────────────────────────────────────────────────────────────

const overrideRules: OverrideRule[] = [
  ...normalizeOverrides(rootPkg.overrides, 'overrides'),
  ...normalizeOverrides(rootPkg.resolutions, 'resolutions'),
];
/** Плоская карта «пакет → диапазон» для колонки «в overrides» у обычных зависимостей. */
const overrideOf = new Map<string, string>();
for (const rule of overrideRules) if (!rule.parent) overrideOf.set(rule.target, rule.spec);

/** Lockfile хранит уже нормализованные overrides — расхождение значит, что он устарел. */
const lockOverridesStale = (() => {
  if (!hasTree) return false;
  const declared = flattenOverrides({ ...(rootPkg.overrides ?? {}), ...(rootPkg.resolutions ?? {}) });
  const inLock = flattenOverrides(lock.overrides);
  return declared.length !== inLock.length || declared.some((x, i) => x !== inLock[i]);
})();

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

type RegistryInfo = {
  latest: Version | null;
  latestRaw: string | null;
  versions: Version[];
  deprecatedLatest: string | null;
  error: string | null;
};

const REGISTRY = (process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');
const encodeName = (name: string) => name.replace('/', '%2F');

const externalNames = [...deps.keys()].filter((name) => {
  if (localNames.has(name)) return false;
  return deps.get(name)!.some((r) => parseSpec(r.raw).kind !== 'internal');
});

const registry = new Map<string, RegistryInfo>();

async function fetchInfo(name: string): Promise<RegistryInfo> {
  try {
    const res = await fetch(`${REGISTRY}/${encodeName(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) {
      return { latest: null, latestRaw: null, versions: [], deprecatedLatest: null, error: `HTTP ${res.status}` };
    }
    const body: any = await res.json();
    const latestRaw: string | null = body['dist-tags']?.latest ?? null;
    const versions = Object.keys(body.versions ?? {})
      .map(parseVersion)
      .filter((v): v is Version => v !== null);
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

/** Пул с ограниченной параллельностью: registry не любит десятки одновременных запросов. */
async function pooled<T>(items: T[], worker: (item: T) => Promise<void>, limit = CONCURRENCY): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.pop(); item !== undefined; item = queue.pop()) await worker(item);
    }),
  );
}

if (useNet) await pooled(externalNames, async (name) => void registry.set(name, await fetchInfo(name)));

/**
 * Даты публикации. Сокращённый манифест их не содержит, поэтому полный запрашивается только
 * там, где ответ реально нужен, — иначе скан выкачивал бы мегабайты на каждую зависимость.
 */
const publishedAt = new Map<string, string>(); // `${name}@${version}` → ISO
const ageErrors = new Map<string, string>();

async function fetchTimes(name: string, wanted: string[]): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY}/${encodeName(name)}`);
    if (!res.ok) {
      ageErrors.set(name, `HTTP ${res.status}`);
      return;
    }
    const time: Record<string, string> = ((await res.json()) as any)?.time ?? {};
    for (const version of wanted) if (time[version]) publishedAt.set(`${name}@${version}`, time[version]!);
  } catch (e) {
    ageErrors.set(name, (e as Error).message);
  }
}

const ageDays = (name: string, version: string | null): number | null => {
  if (!version) return null;
  const iso = publishedAt.get(`${name}@${version}`);
  return iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : null;
};

// ─── read-only команды Bun ────────────────────────────────────────────────────

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ok: code === 0, out: (out + err).replace(/\x1b\[[0-9;]*m/g, '') };
}

/** JSON в выводе Bun идёт после строки версии — берём с первой скобки. */
function parseJsonTail(out: string): any | null {
  const start = out.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return null;
  }
}

type AuditFix = {
  name: string;
  from: string;
  to: string;
  downgrade: boolean;
  newerThanMinimumReleaseAge: boolean;
  packageJson: { file: string; catalog: string | null; key: string; from: string; to: string }[];
};

type AuditPlan = {
  ran: boolean;
  note: string | null;
  vulnerable: { name: string; advisories: { title: string; severity: string; url: string; range: string }[] }[];
  fixed: number;
  remaining: number;
  fixes: AuditFix[];
  blocked: any[];
  unfixable: any[];
};

/**
 * `bun audit` + `bun audit fix --dry-run --json`.
 *
 * Второй вызов — единственный источник, который считает МИНИМАЛЬНО достаточную безопасную версию
 * с учётом диапазонов всех зависимых. Гадать про «подняли бы до latest» больше не нужно.
 */
async function auditPlan(): Promise<AuditPlan> {
  const empty: AuditPlan = { ran: false, note: null, vulnerable: [], fixed: 0, remaining: 0, fixes: [], blocked: [], unfixable: [] };
  if (!useNet) return { ...empty, note: '--no-net: bun audit не запускался' };
  if (!hasTree) return { ...empty, note: 'нет bun.lock: bun audit нечего проверять' };

  const report = await run(['bun', 'audit', '--json']);
  const body = parseJsonTail(report.out) ?? {};
  const vulnerable: AuditPlan['vulnerable'] = Object.entries<any>(body)
    .filter(([, list]) => Array.isArray(list) && list.length)
    .map(([name, list]) => ({
      name,
      advisories: list.map((a: any) => ({
        title: a.title ?? '',
        severity: a.severity ?? 'unknown',
        url: a.url ?? '',
        range: a.vulnerable_versions ?? '',
      })),
    }));

  const plan = parseJsonTail((await run(['bun', 'audit', 'fix', '--dry-run', '--json'])).out);
  if (!plan) return { ...empty, ran: vulnerable.length > 0, vulnerable, note: 'bun audit fix --dry-run не вернул JSON' };

  return {
    ran: true,
    note: null,
    vulnerable,
    fixed: plan.fixed ?? 0,
    remaining: plan.remaining ?? 0,
    fixes: plan.fixes ?? [],
    blocked: plan.blocked ?? [],
    unfixable: plan.unfixable ?? [],
  };
}

type DedupePlan = { ran: boolean; note: string | null; removable: { name: string; from: string; to: string | null }[] };

/** `bun dedupe --dry-run`: какие дубли схлопнутся без единой правки package.json. */
async function dedupePlan(): Promise<DedupePlan> {
  if (!hasTree) return { ran: false, note: 'нет bun.lock', removable: [] };
  const res = await run(['bun', 'dedupe', '--dry-run']);
  const removable: DedupePlan['removable'] = [];
  for (const raw of res.out.split('\n')) {
    const m = /^\s*~\s+(\S+)\s+(\d[^\s]*)(?:\s+->\s+(\d[^\s]*))?\s*$/.exec(raw);
    if (m) removable.push({ name: m[1]!, from: m[2]!, to: m[3] ?? null });
  }
  return { ran: true, note: res.ok ? null : 'bun dedupe --dry-run завершился с ошибкой', removable };
}

const [audit, dedupe] = await Promise.all([auditPlan(), dedupePlan()]);
const dedupable = new Map(dedupe.removable.map((d) => [d.name, d]));

// ─── анализ overrides ─────────────────────────────────────────────────────────

type OverrideVerdict = {
  key: string;
  source: OverrideRule['source'];
  target: string;
  spec: string;
  parent: string | null;
  parentRange: string | null;
  copies: string[];
  verdict: 'REDUNDANT_NOW' | 'RAISES_FLOOR' | 'BREAKS_CEILING' | 'CAPS_BELOW' | 'NOT_APPLIED' | 'NOT_IN_TREE' | 'UNKNOWN';
  /** Сколько потребителей реально получили версию из override. */
  reach: { reached: number; total: number };
  missedBy: string[];
  /** Потребители, которым досталось не то, что они объявили. */
  conflicts: string[];
  gap: Risk | null;
  parents: string[];
  alsoDirect: boolean;
};

const overrideReport: OverrideVerdict[] = [];

for (const rule of overrideRules) {
  const spec: Spec = parseSpec(rule.spec);
  const base = {
    key: rule.key,
    source: rule.source,
    target: rule.target,
    spec: rule.spec,
    parent: rule.parent,
    parentRange: rule.parentRange,
    alsoDirect: deps.has(rule.target),
  };

  if (!hasTree || spec.floor === null) {
    overrideReport.push({
      ...base,
      copies: copiesOf(rule.target),
      verdict: 'UNKNOWN',
      reach: { reached: 0, total: 0 },
      missedBy: [],
      conflicts: [],
      gap: null,
      parents: [],
    });
    continue;
  }

  // Потребители: кто требует этот пакет. Для вложенного правила — только названный родитель.
  const consumers = requirementsFor(rule.target).filter((r) => {
    if (!rule.parent) return true;
    if (r.owner !== rule.parent) return false;
    if (!rule.parentRange || !r.ownerVersion) return true;
    const owner = parseVersion(r.ownerVersion);
    return owner ? rangeAllows(rule.parentRange, owner) : true;
  });

  const reached = consumers.filter((r) => r.resolved?.version && allows(spec, r.resolved.version));
  const missed = consumers.filter((r) => !reached.includes(r));
  const seen = consumers.map((r) => (r.resolved?.version ? fmt(r.resolved.version) : null)).filter((v): v is string => !!v);
  const copies = [...new Set(seen)].sort((a, b) => Bun.semver.order(a, b));
  const effectiveCopies = copies.length ? copies : copiesOf(rule.target);

  const ranges = [...new Set(consumers.map((r) => r.range))];
  let ceilingBroken = false;
  let cappedBelow = false;
  let floorRaised = false;
  let gap: Risk | null = null;
  const conflicts: string[] = [];
  const worsen = (cls: Risk) => {
    if (!gap || RISK_ORDER[cls]! < RISK_ORDER[gap]!) gap = cls;
  };

  /**
   * Судим по каждому потребителю отдельно и по факту, а не по гипотезе: lockfile говорит,
   * какая копия ему реально досталась.
   *
   * Досталось выше объявленного потолка — override форсит; ниже объявленного минимума —
   * наоборот, держит вниз (так тихо режется обновление, если пакет есть и в dependencies,
   * и в overrides). Допустимое, но выше собственного минимума потребителя — поднятый пол.
   * Если минимум потребителя и так не ниже override, правило ему ничего не даёт.
   */
  for (const r of consumers) {
    const floor = rangeFloor(r.range);
    const got = r.resolved?.version ?? spec.floor;

    if (!rangeAllows(r.range, got)) {
      if (floor && cmp(got, floor) < 0) {
        cappedBelow = true;
        worsen(riskClass(got, floor));
      } else {
        ceilingBroken = true;
        if (floor) worsen(riskClass(floor, got));
      }
      conflicts.push(`${r.owner}${r.ownerVersion ? `@${r.ownerVersion}` : ''} требует ${r.range}, получил ${fmt(got)}`);
      continue;
    }
    if (floor && cmp(floor, spec.floor) < 0) floorRaised = true;
  }

  overrideReport.push({
    ...base,
    copies: effectiveCopies,
    verdict:
      consumers.length === 0 && effectiveCopies.length === 0
        ? 'NOT_IN_TREE'
        : consumers.length > 0 && reached.length === 0
          ? 'NOT_APPLIED'
          : ranges.length === 0
            ? 'UNKNOWN'
            : cappedBelow
              ? 'CAPS_BELOW'
              : ceilingBroken
                ? 'BREAKS_CEILING'
                : floorRaised
                  ? 'RAISES_FLOOR'
                  : 'REDUNDANT_NOW',
    reach: { reached: reached.length, total: consumers.length },
    missedBy: [
      ...new Set(
        missed.map((r) => `${r.owner}${r.ownerVersion ? `@${r.ownerVersion}` : ''} → ${r.resolved?.version ? fmt(r.resolved.version) : 'нет копии'}`),
      ),
    ].slice(0, 6),
    conflicts: [...new Set(conflicts)].slice(0, 6),
    gap,
    parents: ranges,
  });
}

// ─── строки отчёта ────────────────────────────────────────────────────────────

type Row = {
  name: string;
  specs: string[];
  catalogs: string[];
  mismatch: boolean;
  pinned: boolean;
  floor: string | null;
  copies: string[];
  atLatest: boolean;
  inRangeMax: string | null;
  latest: string | null;
  risk: Risk | 'unknown';
  /** Сколько дней назад опубликована latest; null — не проверяли. */
  latestAgeDays: number | null;
  tooFresh: boolean;
  deprecated: string | null;
  workspaces: string[];
  family: string | null;
  inOverrides: string | null;
  dedupe: { from: string; to: string | null } | null;
  vulnerable: { severity: string; title: string; url: string }[];
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
function deferredStatus(
  decision: Decision,
  row: Omit<Row, 'deferred' | 'revisit' | 'heldBy'>,
): { revisit: string | null; heldBy: string[] } {
  const declined = parseVersion(decision.declinedVersion);
  const latest = row.latest ? parseVersion(row.latest) : null;
  const floor = row.floor ? parseVersion(row.floor) : null;
  const held: string[] = [];

  if (declined && floor && cmp(floor, declined) >= 0) {
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
  if (named.length && latest && hasTree && row.copies.length > 0) {
    // Свои воркспейсы не блокеры: это ровно тот диапазон, который мы и собираемся менять.
    const outside = requirementsFor(row.name).filter((r) => !r.fromWorkspace);
    const blocking = outside.filter((r) => isRange(r.range) && !rangeAllows(r.range, latest));
    held.push(...new Set(blocking.map((r) => `${r.owner} requires ${r.range}`)));

    // Судим только по блокерам, которые названы в решении: у листового пакета внешних родителей
    // нет вовсе, и «никто не ограничивает» срабатывало бы каждый прогон.
    const stillBlocking = blocking.filter((r) => named.includes(r.owner));
    if (stillBlocking.length === 0) {
      const gone = named.filter((n) => !outside.some((r) => r.owner === n));
      const reason =
        gone.length === named.length
          ? `названный блокер (${named.join(', ')}) больше не тянет этот пакет`
          : `блокер отпустил: ${named.join(', ')} больше не ограничивает ${row.latest}`;
      return { revisit: reason, heldBy: held };
    }
  }
  return { revisit: null, heldBy: held };
}

const preRows: Omit<Row, 'deferred' | 'revisit' | 'heldBy' | 'latestAgeDays' | 'tooFresh'>[] = [];

for (const name of externalNames) {
  const all = deps.get(name)!.filter((r) => parseSpec(r.raw).kind !== 'internal');
  // Анализируем только runtime/dev/optional: peer-диапазоны намеренно широкие.
  const refs = all.filter((r) => isAlignable(r.field));
  if (refs.length === 0) continue;

  const specs = [...new Set(refs.map((r) => r.raw))];
  const parsedSpecs = specs.map(parseSpec);
  const pinned = parsedSpecs.every((s) => s.kind === 'exact');
  const floors = parsedSpecs.map((s) => s.floor).filter((v): v is Version => v !== null);
  const floor = floors.length ? floors.reduce((a, b) => (cmp(a, b) < 0 ? a : b)) : null;

  const info = registry.get(name);
  // Максимум, который вытянет пересборка lockfile хотя бы для одного воркспейса.
  const inRangeMax = info
    ? parsedSpecs.reduce<Version | null>((best, s) => {
        const hit = maxSatisfying(info.versions, s);
        return hit && (!best || cmp(hit, best) > 0) ? hit : best;
      }, null)
    : null;
  const installedMax = maxInstalled(name);
  const advisories = audit.vulnerable.find((v) => v.name === name)?.advisories ?? [];

  preRows.push({
    name,
    specs,
    catalogs: [...new Set(refs.map((r) => r.fromCatalog).filter((c): c is string => !!c))],
    mismatch: specs.length > 1,
    pinned,
    floor: floor ? fmt(floor) : null,
    copies: copiesOf(name),
    atLatest: !!(installedMax && info?.latest && cmp(installedMax, info.latest) >= 0),
    inRangeMax: inRangeMax ? fmt(inRangeMax) : null,
    latest: info?.latestRaw ?? null,
    risk: floor && info?.latest ? riskClass(floor, info.latest) : ('unknown' as const),
    deprecated: info?.deprecatedLatest ?? null,
    workspaces: [...new Set(refs.map((r) => r.workspace))],
    family: family(name),
    inOverrides: overrideOf.get(name) ?? null,
    dedupe: dedupable.get(name) ?? null,
    vulnerable: advisories.map((a) => ({ severity: a.severity, title: a.title, url: a.url })),
    note: info?.error
      ? `registry: ${info.error}`
      : parsedSpecs.some((s) => s.kind === 'unknown')
        ? 'диапазон не разобран — проверить вручную'
        : null,
    peerSpecs: [...new Set(all.filter((r) => !isAlignable(r.field)).map((r) => `${r.raw} (${r.workspace})`))],
  });
}

// Даты публикации — только для тех, у кого вообще есть куда обновляться.
if (minAgeDays !== null && useNet) {
  const wanted = preRows.filter((r) => r.latest && r.risk !== 'up-to-date' && r.risk !== 'unknown');
  await pooled(wanted, (r) => fetchTimes(r.name, [r.latest!, r.inRangeMax].filter((v): v is string => !!v)), 6);
}

const excluded = new Set(policy.minimumReleaseAgeExcludes);
const rows: Row[] = preRows
  .map((base) => {
    const age = ageDays(base.name, base.latest);
    const withAge = {
      ...base,
      latestAgeDays: age,
      tooFresh: minAgeDays !== null && age !== null && age < minAgeDays && !excluded.has(base.name),
    };
    const decision = decisions.get(base.name) ?? null;
    const status = decision ? deferredStatus(decision, withAge) : { revisit: null, heldBy: [] };
    return { ...withAge, deferred: decision, ...status };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// ─── вывод ────────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(
    JSON.stringify(
      {
        root,
        bun: Bun.version,
        workspaces: pkgPaths.size,
        policy,
        lock: { present: hasTree, note: lock.note, overridesStale: lockOverridesStale },
        rows,
        overrides: overrideReport,
        audit,
        dedupe,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const line = (s = '') => console.log(s);
const days = (n: number) => (n < 1 ? `${Math.round(n * 24)} ч` : `${Math.round(n)} дн`);

line(`# deps-scan: ${rootPkg.name ?? root}`);
line();
line(`- корень: \`${root}\`, bun ${Bun.version}`);
line(`- package.json просканировано: ${pkgPaths.size} (воркспейсов: ${pkgPaths.size - 1})`);
line(`- внешних зависимостей: ${externalNames.length}, overrides/resolutions: ${overrideRules.length}`);
if (Object.keys(catalogs.default!).length || Object.keys(catalogs).length > 1) {
  const total = Object.values(catalogs).reduce((n, c) => n + Object.keys(c).length, 0);
  line(`- каталоги: ${Object.keys(catalogs).join(', ')} — записей ${total}`);
}
if (policy.path) {
  const parts = [
    policy.minimumReleaseAge ? `minimumReleaseAge ${days(policy.minimumReleaseAge / 86_400)}` : null,
    policy.linker ? `linker ${policy.linker}` : null,
    policy.scanner ? `security scanner ${policy.scanner}` : null,
  ].filter(Boolean);
  line(`- bunfig.toml: ${parts.length ? parts.join(', ') : 'без install-политик'}${policy.error ? ` (не разобран: ${policy.error})` : ''}`);
}
if (lock.trustedDependencies.length) {
  line(`- trustedDependencies: ${lock.trustedDependencies.join(', ')} — им разрешены install-скрипты`);
}
if (!useNet) line('- **--no-net**: latest не запрашивался, риск-классы и `bun audit` недоступны');
if (!hasTree) line(`- **дерево не читалось**: ${lock.note} — колонки «Установлено»/«Копии» и вердикты пустые`);
if (minAgeDays !== null) {
  line(`- порог свежести: ${days(minAgeDays)}${opt('min-age') === undefined ? ' (из bunfig.toml)' : ''} — версии моложе помечены ⏳`);
} else if (useNet) {
  line('- возраст релизов не проверялся: задай `--min-age <дней>` или `install.minimumReleaseAge` в bunfig.toml');
}
line();

const mismatches = rows.filter((r) => r.mismatch);
line(`## 1. Расхождения версий одной библиотеки (${mismatches.length})`);
line();
if (mismatches.length === 0) {
  line('Нет — одна версия во всех воркспейсах.');
} else {
  line('Выровнять до максимальной ДО обновления: разные диапазоны = разные копии в дереве.');
  line('Долгое решение для монорепозитория — каталог: одна запись версии в корне, `"catalog:"` в воркспейсах.');
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
    if (r.catalogs.length) line(`    - часть записей уже из каталога: ${r.catalogs.join(', ')}`);
    if (r.peerSpecs.length) line(`    - peer (не выравнивать): ${r.peerSpecs.map((p) => `\`${p}\``).join(', ')}`);
  }
}
line();

const declaredDupes = rows.filter((r) => r.copies.length > 1);
const transitiveDupes = [...lock.byName].filter(
  ([name, pkgs]) =>
    new Set(pkgs.map((p) => p.version && fmt(p.version)).filter(Boolean)).size > 1 &&
    !rows.some((r) => r.name === name) &&
    !overrideOf.has(name),
).length;

line(`## 2. Дубли в дереве (${declaredDupes.length})`);
line();
if (!hasTree) {
  line(`Дерево не читалось (${lock.note}) — дубли не проверялись.`);
} else if (declaredDupes.length === 0) {
  line('Нет: у объявленных зависимостей по одной копии.');
} else {
  line('Объявленный пакет стоит в дереве в нескольких версиях — обычно из-за расхождения диапазонов');
  line('или чужого exact-требования. Это лишний вес, а для рантайм-библиотек (синглтоны, инстансы,');
  line('`instanceof`) — источник багов.');
  line();
  for (const r of declaredDupes) {
    const collapse = r.dedupe ? ` — **\`bun dedupe\` схлопнет${r.dedupe.to ? ` до ${r.dedupe.to}` : ''}**` : '';
    line(`- **${r.name}**: ${r.copies.join(' + ')} — объявлено ${r.specs.map((s) => `\`${s}\``).join(', ')}${collapse}`);
  }
}
if (transitiveDupes > 0) {
  line();
  line(`Транзитивных пакетов с несколькими копиями: ${transitiveDupes} — обычно норма, смотреть точечно (\`bun why <pkg>\`).`);
}
if (dedupe.ran && dedupe.removable.length) {
  line();
  line(`\`bun dedupe --dry-run\`: схлопывается ${dedupe.removable.length} дублей без единой правки package.json.`);
  for (const d of dedupe.removable) line(`- ${d.name}: ${d.from}${d.to ? ` → ${d.to}` : ''}`);
  const downgrades = dedupe.removable.filter((d) => d.to && Bun.semver.order(d.to, d.from) < 0);
  if (downgrades.length) {
    line();
    line(`⚠ ${downgrades.length} из них — понижение версии (dedupe переиспользует то, что уже есть в lockfile).`);
    line('После `bun dedupe` обязательно повторить `bun audit`: понижение может вернуть закрытую уязвимость.');
  }
} else if (dedupe.ran) {
  line();
  line('`bun dedupe --dry-run`: схлопывать нечего.');
}
line();

const updatable = rows
  .filter((r) => r.risk !== 'up-to-date' && r.risk !== 'unknown')
  .sort((a, b) => RISK_ORDER[a.risk]! - RISK_ORDER[b.risk]! || a.name.localeCompare(b.name));

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
  const ageCol = minAgeDays !== null ? ' Возраст latest |' : '';
  const ageSep = minAgeDays !== null ? '---|' : '';
  line(`| Пакет | Диапазон | Установлено | Макс. в диапазоне | Latest |${ageCol} Класс | Семейство | В overrides | Воркспейсы |`);
  line(`|---|---|---|---|---|${ageSep}---|---|---|---|`);
  for (const r of candidates) {
    const inRange = r.inRangeMax && r.inRangeMax !== r.floor ? `**${r.inRangeMax}**` : (r.inRangeMax ?? '—');
    const copies = r.copies.length ? r.copies.join(' + ') + (r.copies.length > 1 ? ' ⚠' : '') : '—';
    const age =
      minAgeDays === null ? '' : ` ${r.latestAgeDays === null ? '—' : `${days(r.latestAgeDays)}${r.tooFresh ? ' ⏳' : ''}`} |`;
    const vuln = r.vulnerable.length ? ` 🛡 ${r.vulnerable.length}` : '';
    line(
      `| ${r.name}${r.pinned ? ' 📌' : ''}${vuln} | ${r.specs.join(', ')} | ${copies} | ${inRange} | ${r.latest ?? '—'} |${age} ${RISK_LABEL[r.risk]}${r.atLatest ? ' *(latest уже стоит)*' : ''} | ${r.family ?? '—'} | ${r.inOverrides ? `\`${r.inOverrides}\`` : '—'} | ${r.workspaces.join(', ')} |`,
    );
  }
  line();
  line('📌 — точный пиннинг (без `^`): сделано намеренно, диапазон не расширять.');
  line('«Диапазон» — то, что записано в package.json; «Установлено» — что реально в дереве (bun.lock).');
  line('*(latest уже стоит)* — обновлять нечего, правка диапазона лишь приводит запись в соответствие факту.');
  line('⚠ — в дереве несколько копий пакета: разные ветки тянут разные версии.');
  line('Жирный «макс. в диапазоне» — подтянется само при пересборке lockfile, даже без правки package.json.');
  if (minAgeDays !== null) line('⏳ — релиз моложе порога свежести: подождать или объяснить, почему берём сразу.');
  if (audit.vulnerable.length) line('🛡 — у пакета есть открытые advisory (см. раздел 6).');
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
  if (lockOverridesStale) {
    line('⚠ **overrides в package.json не совпадают с bun.lock** — lockfile устарел. Вердикты ниже описывают');
    line('дерево, собранное по прежним правилам: сначала `bun install`, потом читать таблицу.');
    line();
  }
  line('| Правило | Под кем | Override | Копии в дереве | Достаёт | Вердикт | Разрыв | Прямая зависимость тоже |');
  line('|---|---|---|---|---|---|---|---|');
  for (const o of overrideReport) {
    const copies = o.copies.length ? o.copies.join(' + ') + (o.copies.length > 1 ? ' ⚠' : '') : '—';
    const reach = o.reach.total ? `${o.reach.reached}/${o.reach.total}` : '—';
    const scope = o.parent ? `${o.parent}${o.parentRange ? `@${o.parentRange}` : ''}` : 'везде';
    line(
      `| ${o.target}${o.source === 'resolutions' ? ' *(resolutions)*' : ''} | ${scope} | \`${o.spec}\` | ${copies} | ${reach} | ${o.verdict} | ${o.gap ? RISK_LABEL[o.gap] : '—'} | ${o.alsoDirect ? '**да, синхронизировать**' : 'нет'} |`,
    );
  }
  line();
  line('«Достаёт» — сколько потребителей пакета реально получили версию из override (по путям в bun.lock).');
  line('Вердикт считается по каждому потребителю отдельно: его объявленный диапазон против той копии,');
  line('которая ему фактически досталась. Но и это лишь описание текущего дерева — что override держит,');
  line('показывает только эксперимент: снять все разом, пересобрать, сравнить `bun audit` и копии');
  line('(процедура в SKILL.md).');
  line();
  line('- `REDUNDANT_NOW` — потребители сами требуют не меньше: кандидат на удаление.');
  line('- `RAISES_FLOOR` — поднимает минимум внутри допустимого диапазона: похоже на security-override.');
  line('- `BREAKS_CEILING` — кому-то досталась версия выше объявленного им потолка. Смотри «Достаёт»:');
  line('  если не 100%, часть веток осталась на своей версии и потолок им никто не ломал.');
  line('- `CAPS_BELOW` — **override держит версию НИЖЕ того, что просит потребитель.** Так тихо режется');
  line('  обновление, когда пакет есть и в dependencies, и в overrides: править надо оба места сразу.');
  line('- `NOT_APPLIED` — ни один потребитель не получил версию из override: lockfile разошёлся с package.json');
  line('  (нужен `bun install`) либо Bun эту ветку не переопределил.');
  line('- `NOT_IN_TREE` — пакета в дереве нет вовсе: правило мёртвое, удаляется без эксперимента.');
  line('- `UNKNOWN` — диапазон не разобран.');
  line();
  for (const o of overrideReport) {
    if (o.parents.length) line(`- ${o.target}: потребители требуют ${o.parents.map((p) => `\`${p}\``).join(', ')}`);
    if (o.conflicts.length) line(`    - досталось не то, что объявлено: ${o.conflicts.join('; ')}`);
    if (o.missedBy.length) line(`    - override не достал: ${o.missedBy.join('; ')}`);
  }
  if (overrideReport.every((o) => !o.parent)) {
    line();
    line('Все правила верхнеуровневые — они переписывают версию во всём дереве. Если пакет нужно поднять');
    line('ровно под одним родителем, Bun 1.4 умеет адресные правила: `"parent>child": "^1.2.3"`');
    line('(или `"parent@^4>child"`), и остальное дерево остаётся нетронутым.');
  }
}
line();

line(`## 6. Уязвимости и план \`bun audit fix\` (${audit.vulnerable.length})`);
line();
if (!audit.ran) {
  line(audit.note ?? 'не запускалось.');
} else if (audit.vulnerable.length === 0) {
  line('`bun audit`: чисто.');
} else {
  for (const v of audit.vulnerable) {
    const worst = v.advisories[0];
    line(`- **${v.name}** — ${v.advisories.length} advisory, худшее: ${worst?.severity} «${worst?.title}» (${worst?.url})`);
  }
  line();
  if (audit.fixes.length) {
    line(`\`bun audit fix --dry-run\` закрывает ${audit.fixed} из ${audit.fixed + audit.remaining}, поднимая:`);
    line();
    for (const f of audit.fixes) {
      const marks = [
        f.downgrade ? '**понижение**' : null,
        f.newerThanMinimumReleaseAge ? '⏳ моложе порога свежести' : null,
        f.packageJson?.length ? `правит ${[...new Set(f.packageJson.map((p) => p.file))].join(', ')}` : 'только lockfile',
      ].filter(Boolean);
      line(`- ${f.name}: ${f.from} → ${f.to} — ${marks.join(', ')}`);
    }
    line();
    line('Это МИНИМАЛЬНО достаточные версии с учётом диапазонов всех зависимых — не latest.');
    line('Совпадение с планом из раздела 3 значит, что уязвимость закроется сама, без отдельного шага.');
  }
  if (audit.blocked.length) {
    line();
    line(`Заблокировано чужими диапазонами: ${audit.blocked.length} — сюда нужен override, а не подъём версии.`);
  }
  if (audit.unfixable.length) {
    line();
    line(`Безопасной версии не существует: ${audit.unfixable.length} — только миграция или замена пакета.`);
  }
  if (audit.remaining > 0) {
    line();
    line(`Останется после fix: ${audit.remaining}.`);
  }
}
line();

const fresh = rows.filter((r) => r.tooFresh);
if (fresh.length) {
  line(`## 6a. Слишком свежие релизы (${fresh.length})`);
  line();
  line(`Опубликованы меньше ${days(minAgeDays!)} назад. Скомпрометированные версии обычно снимают в первые сутки,`);
  line('поэтому подъём на такую версию нужно либо отложить, либо обосновать (закрывает известную уязвимость).');
  line();
  for (const r of fresh) line(`- **${r.name}** ${r.latest} — ${days(r.latestAgeDays!)} назад`);
  line();
  line('Постоянное решение — политика проекта, её проверяет сам Bun:');
  line('`bunfig.toml` → `[install] minimumReleaseAge = 604800` (+ `minimumReleaseAgeExcludes` для своих пакетов),');
  line('разово — `bun install --minimum-release-age=604800`.');
  line();
}
if (ageErrors.size) {
  line(`Даты публикации не получены для: ${[...ageErrors].map(([n, e]) => `${n} (${e})`).join(', ')}`);
  line();
}

const deprecated = rows.filter((r) => r.deprecated);
if (deprecated.length) {
  line(`## 7. Deprecated latest (${deprecated.length})`);
  line();
  for (const r of deprecated) line(`- **${r.name}**: ${r.deprecated}`);
  line();
}

const notes = rows.filter((r) => r.note);
if (notes.length) {
  line(`## 8. Требует ручной проверки (${notes.length})`);
  line();
  for (const r of notes) line(`- **${r.name}** (${r.specs.join(', ')}): ${r.note}`);
  line();
}

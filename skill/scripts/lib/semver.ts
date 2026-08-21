/**
 * Версии и диапазоны поверх `Bun.semver` (Bun >= 1.4).
 *
 * Сам `Bun.semver.satisfies` сравнением диапазонов занимается правильно, но на не-диапазоне
 * (`workspace:*`, `latest`, вообще на любой строке) возвращает true — то есть не отличает
 * диапазон от протокола. Поэтому здесь есть свой разбор формы записи, а вычисления отданы Bun.
 */

export type Version = { raw: string; major: number; minor: number; patch: number; pre: string | null };

/** Не semver, а протокол: такой диапазон не сравнивают с версиями из registry. */
export const PROTOCOLS = ['workspace:', 'link:', 'file:', 'git+', 'github:', 'npm:', 'portal:', 'catalog:', 'http:', 'https:'];
export const isProtocol = (raw: string) => PROTOCOLS.some((p) => raw.trim().startsWith(p));

const STRICT_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** Один компаратор диапазона: `^1.2.3`, `>=2`, `1.x`, `=0.1.0-beta`. */
const COMPARATOR = /^(?:[<>]=?|=|\^|~>?)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function makeVersion(major: number, minor: number, patch: number, pre: string | null): Version {
  return { raw: `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`, major, minor, patch, pre };
}

export function parseVersion(raw: string): Version | null {
  const m = STRICT_VERSION.exec(raw.trim());
  return m ? makeVersion(+m[1]!, +m[2]!, +m[3]!, m[4] ?? null) : null;
}

/** `1`, `1.2`, `1.x` → полноценная версия: недостающие разряды считаем нулями. */
export function coerce(raw: string): Version | null {
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  const num = (s?: string) => (s === undefined || s === 'x' || s === 'X' || s === '*' ? 0 : +s);
  return makeVersion(+m[1]!, num(m[2]), num(m[3]), m[4] ?? null);
}

export const cmp = (a: Version, b: Version) => Bun.semver.order(a.raw, b.raw);
export const fmt = (v: Version) => v.raw;

/** Пробел после оператора (`>= 1.2.3`) допустим в npm, но ломает разбиение по токенам. */
export const normalizeRange = (raw: string) => raw.trim().replace(/([<>]=?|=|\^|~>?)\s+/g, '$1');

/** Похоже ли это на semver-диапазон, а не на протокол, dist-tag или мусор. */
export function isRange(raw: string): boolean {
  const s = normalizeRange(raw);
  if (isProtocol(s)) return false;
  if (s === '' || s === '*' || s === 'x' || s === 'X') return true;
  return s.split('||').every((alt) => {
    const part = alt.trim();
    if (part === '' || part === '*') return true;
    return part.split(/\s+/).filter(Boolean).every((tok) => tok === '-' || COMPARATOR.test(tok));
  });
}

export type SpecKind = 'exact' | 'caret' | 'tilde' | 'range' | 'any' | 'internal' | 'unknown';
export type Spec = { kind: SpecKind; raw: string; floor: Version | null };

/**
 * Нижняя граница диапазона: что он требует как минимум.
 *
 * Внутри одной альтернативы условия складываются (берём максимум нижних границ), между
 * альтернативами через `||` — выбирается любая, значит минимум.
 */
export function rangeFloor(raw: string): Version | null {
  const s = normalizeRange(raw);
  if (!isRange(s)) return null;
  let best: Version | null = null;
  for (const alt of s.split('||')) {
    const part = alt.trim();
    if (!part || part === '*' || part === 'x' || part === 'X') return makeVersion(0, 0, 0, null);
    // Дефисный диапазон `1.2.3 - 1.5.0`: нижняя граница — левая часть, правая её не поднимает.
    const hyphen = part.split(/\s+-\s+/);
    const tokens = (hyphen.length > 1 ? hyphen[0]! : part).split(/\s+/).filter(Boolean);
    let altFloor: Version | null = null;
    for (const tok of tokens) {
      const m = /^([<>]=?|=|\^|~>?)?v?(.+)$/.exec(tok);
      if (!m) continue;
      if (m[1] === '<' || m[1] === '<=') continue; // это потолок, не пол
      const v = coerce(m[2]!);
      if (v && (!altFloor || cmp(v, altFloor) > 0)) altFloor = v;
    }
    if (altFloor && (!best || cmp(altFloor, best) < 0)) best = altFloor;
  }
  return best;
}

export function parseSpec(raw: string): Spec {
  const s = raw.trim();
  if (isProtocol(s)) return { kind: 'internal', raw: s, floor: null };
  if (s === '' || s === '*' || s === 'x' || s === 'X' || s === 'latest') return { kind: 'any', raw: s, floor: null };

  const exact = parseVersion(s);
  if (exact) return { kind: 'exact', raw: s, floor: exact };
  if (!isRange(s)) return { kind: 'unknown', raw: s, floor: null };

  const floor = rangeFloor(s);
  const single = /^([\^~])v?(\d+)(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(normalizeRange(s));
  if (single) return { kind: single[1] === '^' ? 'caret' : 'tilde', raw: s, floor };
  return { kind: 'range', raw: s, floor };
}

/** Допускает ли диапазон версию. `any` намеренно не пускает prerelease — как и `^`/`~`. */
export function allows(spec: Spec, v: Version): boolean {
  if (spec.kind === 'internal' || spec.kind === 'unknown') return false;
  if (spec.kind === 'any') return v.pre === null;
  return Bun.semver.satisfies(v.raw, spec.raw);
}

export const rangeAllows = (range: string, v: Version) => allows(parseSpec(range), v);

export function maxSatisfying(versions: Version[], spec: Spec): Version | null {
  let best: Version | null = null;
  for (const v of versions) if (allows(spec, v) && (!best || cmp(v, best) > 0)) best = v;
  return best;
}

export type Risk = 'up-to-date' | 'patch' | 'minor' | 'major' | 'zero-minor-breaking' | 'zero-patch-breaking' | 'prerelease';

/**
 * Класс риска перехода from → to.
 * Ключевой нюанс: при major === 0 semver-гарантий нет, минор = мажор
 * (смена минора ломает так же, как 1.x → 2.0), а при 0.0.x ломает даже патч.
 */
export function riskClass(from: Version, to: Version): Risk {
  const c = cmp(from, to);
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
export const RISK_ORDER: Record<string, number> = {
  'zero-patch-breaking': 0,
  'zero-minor-breaking': 1,
  major: 2,
  minor: 3,
  patch: 4,
  prerelease: 5,
  unknown: 6,
  'up-to-date': 7,
};

export const RISK_LABEL: Record<string, string> = {
  patch: 'PATCH — безопасно',
  minor: 'MINOR — обычно безопасно',
  major: 'MAJOR — вручную, читать changelog',
  'zero-minor-breaking': '0.x MINOR — ЛОМАЮЩЕЕ (semver-гарантий нет)',
  'zero-patch-breaking': '0.0.x PATCH — ЛОМАЮЩЕЕ',
  prerelease: 'PRERELEASE — latest нестабильный',
  'up-to-date': 'в пределах требований потребителя',
  unknown: 'НЕИЗВЕСТНО',
};

// Пакеты без общего скоупа, которые всё равно обязаны обновляться одной группой.
// Скоуп (@scope/*) определяется автоматически, здесь — только связки «ядро ↔ его скоуп».
export const FAMILY_ALIASES: Record<string, string> = {
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

export function family(name: string): string | null {
  if (FAMILY_ALIASES[name]) return FAMILY_ALIASES[name]!;
  if (!name.startsWith('@')) return null;
  const scope = name.slice(0, name.indexOf('/'));
  return scope === '@types' ? null : scope; // @types/* живут своей жизнью, это не семейство
}

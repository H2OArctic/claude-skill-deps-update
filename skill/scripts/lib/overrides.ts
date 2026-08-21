/**
 * Разбор блоков `overrides` / `resolutions`.
 *
 * Bun 1.4 принимает четыре формы записи, и все они сводятся к «кого переопределяем и под кем»:
 *
 *   "pkg": "^1"                            — верхнеуровневое, на всё дерево
 *   "parent>child": "^1"                   — pnpm; "parent@^4>child" — ограничено версией родителя
 *   "parent/child": "^1"                   — yarn resolutions, включая "**\/parent/**\/child"
 *   "parent": { ".": "^4", "child": "^1" } — вложенная форма npm ("." — сам родитель)
 *
 * При совпадении нескольких правил выигрывает самое конкретное: родитель с версией >
 * родитель > верхний уровень.
 *
 * Из цепочки запоминается только ближайший родитель: `a > b > c` разбирается как «c под b».
 * Для вердиктов этого достаточно — они считаются по тому, кто напрямую требует пакет.
 */

import { splitPkgPath } from './lockfile.ts';

export type OverrideRule = {
  /** Как записано в package.json, приведённое к форме `parent>child`. */
  key: string;
  source: 'overrides' | 'resolutions';
  /** Кого переопределяем. */
  target: string;
  spec: string;
  /** Родитель, если правило вложенное. */
  parent: string | null;
  parentRange: string | null;
};

function parentOf(segments: string[]): { parent: string | null; parentRange: string | null; target: string } {
  const clean = segments.filter((s) => s !== '**' && s !== '*');
  const target = clean[clean.length - 1] ?? segments[segments.length - 1] ?? '';
  const rawParent = clean.length > 1 ? clean[clean.length - 2]! : null;
  if (!rawParent) return { parent: null, parentRange: null, target };
  const at = rawParent.indexOf('@', 1);
  return at === -1
    ? { parent: rawParent, parentRange: null, target }
    : { parent: rawParent.slice(0, at), parentRange: rawParent.slice(at + 1), target };
}

export function normalizeOverrides(block: unknown, source: OverrideRule['source']): OverrideRule[] {
  const rules: OverrideRule[] = [];

  const walk = (key: string, value: unknown, chain: string[]) => {
    const segments = key.includes('>') ? key.split('>').flatMap(splitPkgPath) : splitPkgPath(key);
    const here = [...chain, ...segments];

    if (typeof value === 'string') {
      rules.push({ key: here.join('>'), source, spec: value, ...parentOf(here) });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        // `.` в npm-форме означает «сам родитель», а не вложенный пакет.
        if (innerKey === '.') {
          if (typeof innerValue === 'string') {
            rules.push({ key: here.join('>'), source, spec: innerValue, ...parentOf(here) });
          }
          continue;
        }
        walk(innerKey, innerValue, here);
      }
    }
  };

  for (const [key, value] of Object.entries((block ?? {}) as Record<string, unknown>)) walk(key, value, []);
  return rules;
}

/** Плоский отпечаток блока для сравнения package.json с bun.lock. */
export function flattenOverrides(block: unknown, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries((block ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') out.push(`${prefix}${key}=${value}`);
    else if (value && typeof value === 'object') out.push(...flattenOverrides(value, `${prefix}${key}>`));
  }
  return out.sort();
}

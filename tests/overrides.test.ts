import { describe, expect, test } from 'bun:test';
import { flattenOverrides, normalizeOverrides } from '../skill/scripts/lib/overrides.ts';

const rule = (block: unknown) => normalizeOverrides(block, 'overrides');
const brief = (block: unknown) =>
  rule(block).map((r) => [r.target, r.parent, r.parentRange, r.spec] as const);

describe('normalizeOverrides', () => {
  test('верхнеуровневая форма', () => {
    expect(brief({ picomatch: '^2.3.2' })).toEqual([['picomatch', null, null, '^2.3.2']]);
  });

  test('скоуп не путается с вложенностью', () => {
    expect(brief({ '@scope/pkg': '^1.0.0' })).toEqual([['@scope/pkg', null, null, '^1.0.0']]);
  });

  test('pnpm-форма parent>child', () => {
    expect(brief({ 'micromatch>picomatch': '^2.3.2' })).toEqual([['picomatch', 'micromatch', null, '^2.3.2']]);
  });

  test('pnpm-форма с версией родителя', () => {
    expect(brief({ 'micromatch@^4>picomatch': '^2.3.2' })).toEqual([['picomatch', 'micromatch', '^4', '^2.3.2']]);
  });

  test('yarn-форма parent/child', () => {
    expect(brief({ 'micromatch/picomatch': '^2.3.2' })).toEqual([['picomatch', 'micromatch', null, '^2.3.2']]);
  });

  test('yarn-глобы отбрасываются, остаются реальные имена', () => {
    expect(brief({ '**/picomatch': '^2.3.2' })).toEqual([['picomatch', null, null, '^2.3.2']]);
    expect(brief({ 'micromatch/**/picomatch': '^2.3.2' })).toEqual([['picomatch', 'micromatch', null, '^2.3.2']]);
  });

  test('вложенная форма npm', () => {
    expect(brief({ micromatch: { '.': '^4.0.5', picomatch: '^2.3.2' } })).toEqual([
      ['micromatch', null, null, '^4.0.5'], // `.` — это сам родитель, а не вложенный пакет
      ['picomatch', 'micromatch', null, '^2.3.2'],
    ]);
  });

  test('вложенность глубже одного уровня', () => {
    expect(brief({ a: { b: { c: '^1.0.0' } } })).toEqual([['c', 'b', null, '^1.0.0']]);
  });

  test('скоуп внутри вложенной формы', () => {
    expect(brief({ '@scope/parent>@other/child': '^1.0.0' })).toEqual([['@other/child', '@scope/parent', null, '^1.0.0']]);
  });

  test('ключ приводится к канонической форме parent>child', () => {
    expect(rule({ 'micromatch/picomatch': '^2' })[0]!.key).toBe('micromatch>picomatch');
    expect(rule({ micromatch: { picomatch: '^2' } })[0]!.key).toBe('micromatch>picomatch');
  });

  test('источник различается: resolutions помечаются отдельно', () => {
    expect(normalizeOverrides({ a: '^1' }, 'resolutions')[0]!.source).toBe('resolutions');
  });

  test('пустой и отсутствующий блок', () => {
    expect(rule(undefined)).toEqual([]);
    expect(rule({})).toEqual([]);
  });
});

describe('flattenOverrides', () => {
  test('вложенная и плоская записи сравнимы между собой', () => {
    expect(flattenOverrides({ micromatch: { picomatch: '^2.3.2' } })).toEqual(['micromatch>picomatch=^2.3.2']);
    expect(flattenOverrides({ a: '^1', b: '^2' })).toEqual(['a=^1', 'b=^2']);
  });

  test('порядок ключей не влияет на отпечаток', () => {
    expect(flattenOverrides({ b: '^2', a: '^1' })).toEqual(flattenOverrides({ a: '^1', b: '^2' }));
  });
});

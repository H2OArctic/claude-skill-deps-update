import { describe, expect, test } from 'bun:test';
import {
  allows,
  coerce,
  family,
  isProtocol,
  isRange,
  maxSatisfying,
  parseSpec,
  parseVersion,
  rangeAllows,
  rangeFloor,
  riskClass,
} from '../skill/scripts/lib/semver.ts';

const v = (s: string) => parseVersion(s)!;

describe('isRange', () => {
  test('обычные формы записи', () => {
    for (const raw of ['^1.2.3', '~1.2', '1.2.3', '>=2 <3', '1.x', '*', '', '4 || 5', '1.2.3 - 1.5.0', '>= 1.2.3', '^1.2.3-beta.1']) {
      expect(isRange(raw)).toBe(true);
    }
  });

  test('протоколы и мусор диапазонами не считаются', () => {
    // Bun.semver.satisfies на любой из этих строк вернул бы true — ради этого проверка и нужна.
    for (const raw of ['workspace:*', 'catalog:', 'npm:other@^1', 'file:../pkg', 'github:a/b', 'not-a-range', 'нечто']) {
      expect(isRange(raw)).toBe(false);
    }
  });

  test('isProtocol отделяет ссылки от версий', () => {
    expect(isProtocol('workspace:^')).toBe(true);
    expect(isProtocol('^1.0.0')).toBe(false);
  });
});

describe('parseSpec', () => {
  const kinds: [string, string][] = [
    ['1.2.3', 'exact'],
    ['^1.2.3', 'caret'],
    ['~1.2.3', 'tilde'],
    ['^1.2', 'caret'],
    ['>=2 <3', 'range'],
    ['1.x', 'range'],
    ['4 || 5', 'range'],
    ['*', 'any'],
    ['latest', 'any'],
    ['workspace:*', 'internal'],
    ['catalog:', 'internal'],
    ['совсем не версия', 'unknown'],
  ];
  for (const [raw, kind] of kinds) {
    test(`${raw} → ${kind}`, () => expect(parseSpec(raw).kind).toBe(kind as any));
  }
});

describe('allows', () => {
  test('caret и tilde', () => {
    expect(rangeAllows('^1.2.3', v('1.9.0'))).toBe(true);
    expect(rangeAllows('^1.2.3', v('2.0.0'))).toBe(false);
    expect(rangeAllows('~1.2.3', v('1.2.9'))).toBe(true);
    expect(rangeAllows('~1.2.3', v('1.3.0'))).toBe(false);
  });

  test('caret на 0.x держит минор', () => {
    expect(rangeAllows('^0.5.0', v('0.5.9'))).toBe(true);
    expect(rangeAllows('^0.5.0', v('0.6.0'))).toBe(false);
  });

  test('составные диапазоны — то, ради чего взят Bun.semver', () => {
    expect(rangeAllows('>=2 <3', v('2.9.9'))).toBe(true);
    expect(rangeAllows('>=2 <3', v('3.0.0'))).toBe(false);
    expect(rangeAllows('^16.8.0 || ^17.0.0 || ^18.0.0', v('18.3.1'))).toBe(true);
    expect(rangeAllows('^16.8.0 || ^17.0.0', v('18.3.1'))).toBe(false);
    expect(rangeAllows('1.2.3 - 1.5.0', v('1.4.0'))).toBe(true);
    expect(rangeAllows('1.2.3 - 1.5.0', v('1.6.0'))).toBe(false);
  });

  test('prerelease не попадает в диапазон без явного указания', () => {
    expect(rangeAllows('^1.0.0', v('1.2.3-beta.1'))).toBe(false);
    expect(rangeAllows('^1.2.3-alpha', v('1.2.3-beta.1'))).toBe(true);
    expect(rangeAllows('*', v('1.2.3-beta.1'))).toBe(false);
    expect(rangeAllows('*', v('1.2.3'))).toBe(true);
  });

  test('протокол не допускает ничего: сравнивать не с чем', () => {
    expect(rangeAllows('workspace:*', v('1.0.0'))).toBe(false);
    expect(rangeAllows('npm:other@^1', v('1.0.0'))).toBe(false);
  });
});

describe('rangeFloor', () => {
  const cases: [string, string | null][] = [
    ['^1.2.3', '1.2.3'],
    ['~0.4.1', '0.4.1'],
    ['2.0.0', '2.0.0'],
    ['>=2 <3', '2.0.0'],
    ['>=1.2 <2 ', '1.2.0'],
    ['1.x', '1.0.0'],
    ['^2.1.0 || ^3.0.0', '2.1.0'],
    ['^3.0.0 || ^2.1.0', '2.1.0'],
    ['1.2.3 - 1.5.0', '1.2.3'],
    ['*', '0.0.0'],
    ['<3.0.0', null],
    ['workspace:*', null],
  ];
  for (const [raw, expected] of cases) {
    test(`${raw} → ${expected}`, () => expect(rangeFloor(raw)?.raw ?? null).toBe(expected));
  }
});

describe('riskClass', () => {
  test('semver при major >= 1', () => {
    expect(riskClass(v('1.2.3'), v('1.2.4'))).toBe('patch');
    expect(riskClass(v('1.2.3'), v('1.3.0'))).toBe('minor');
    expect(riskClass(v('1.2.3'), v('2.0.0'))).toBe('major');
  });

  test('на 0.x минор ломает так же, как мажор', () => {
    expect(riskClass(v('0.5.1'), v('0.6.0'))).toBe('zero-minor-breaking');
    expect(riskClass(v('0.5.1'), v('0.5.2'))).toBe('patch');
  });

  test('на 0.0.x ломает даже патч', () => {
    expect(riskClass(v('0.0.1'), v('0.0.2'))).toBe('zero-patch-breaking');
  });

  test('prerelease и уже актуальное', () => {
    expect(riskClass(v('1.0.0'), v('2.0.0-rc.1'))).toBe('prerelease');
    expect(riskClass(v('2.0.0'), v('1.0.0'))).toBe('up-to-date');
    expect(riskClass(v('2.0.0'), v('2.0.0'))).toBe('up-to-date');
  });
});

describe('maxSatisfying', () => {
  const versions = ['1.0.0', '1.4.2', '1.9.9', '2.0.0', '2.3.0-rc.1'].map(v);
  test('берёт максимум внутри диапазона', () => {
    expect(maxSatisfying(versions, parseSpec('^1.0.0'))?.raw).toBe('1.9.9');
    expect(maxSatisfying(versions, parseSpec('>=1.4.0'))?.raw).toBe('2.0.0');
    expect(maxSatisfying(versions, parseSpec('^3.0.0'))).toBeNull();
  });
});

describe('вспомогательное', () => {
  test('coerce достраивает недостающие разряды', () => {
    expect(coerce('1')?.raw).toBe('1.0.0');
    expect(coerce('1.2')?.raw).toBe('1.2.0');
    expect(coerce('1.x')?.raw).toBe('1.0.0');
    expect(coerce('нет')).toBeNull();
  });

  test('parseVersion не принимает частичные версии', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('v1.2.3')?.raw).toBe('1.2.3');
    expect(parseVersion('1.2.3+build')?.raw).toBe('1.2.3');
  });

  test('семейства', () => {
    expect(family('react-dom')).toBe('react-core');
    expect(family('@storybook/react')).toBe('@storybook');
    expect(family('@types/react')).toBe('react-core');
    expect(family('@types/node')).toBeNull(); // @types/* живут своей жизнью
    expect(family('lodash')).toBeNull();
  });
});

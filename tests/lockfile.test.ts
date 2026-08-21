import { describe, expect, test } from 'bun:test';
import { emptyLock, parseLock, splitPkgPath, splitSpec } from '../skill/scripts/lib/lockfile.ts';

describe('splitPkgPath', () => {
  test('скоуп — один сегмент, а не два', () => {
    expect(splitPkgPath('@scope/pkg')).toEqual(['@scope/pkg']);
    expect(splitPkgPath('parent/@scope/child')).toEqual(['parent', '@scope/child']);
    expect(splitPkgPath('@scope/top/middle/@other/leaf')).toEqual(['@scope/top', 'middle', '@other/leaf']);
    expect(splitPkgPath('axios/https-proxy-agent')).toEqual(['axios', 'https-proxy-agent']);
  });
});

describe('splitSpec', () => {
  test('имя отделяется по первому @ после нулевой позиции', () => {
    expect(splitSpec('mime-types@3.0.2')).toEqual({ name: 'mime-types', rest: '3.0.2' });
    expect(splitSpec('@types/bun@1.3.14')).toEqual({ name: '@types/bun', rest: '1.3.14' });
    expect(splitSpec('web@workspace:apps/web')).toEqual({ name: 'web', rest: 'workspace:apps/web' });
    // Алиас: наивное «резать по последнему @» дало бы имя `foo@npm:bar`.
    expect(splitSpec('foo@npm:bar@1.2.3')).toEqual({ name: 'foo', rest: 'npm:bar@1.2.3' });
  });
});

const LOCK = JSON.stringify({
  lockfileVersion: 1,
  workspaces: {
    '': { name: 'root-pkg', dependencies: { axios: '^1.0.0' }, devDependencies: { typescript: '^5.0.0' } },
    'apps/web': { name: 'web', version: '0.1.0', dependencies: { axios: '^1.5.0', picomatch: '^2.0.0' } },
  },
  trustedDependencies: ['esbuild'],
  overrides: { micromatch: { picomatch: '^2.3.2' } },
  packages: {
    axios: ['axios@1.9.0', '', { dependencies: { picomatch: '^2.3.0' } }, 'sha512-x'],
    'axios/picomatch': ['picomatch@2.9.0', '', {}, 'sha512-y'],
    picomatch: ['picomatch@2.3.2', '', {}, 'sha512-z'],
    micromatch: ['micromatch@4.0.8', '', { dependencies: { picomatch: '^2.3.1' } }, 'sha512-w'],
    typescript: ['typescript@5.9.0', '', {}, 'sha512-t'],
    web: ['web@workspace:apps/web'],
  },
});

describe('parseLock', () => {
  const lock = parseLock(LOCK, 'root-pkg');

  test('распознаёт установленные версии и все копии', () => {
    expect(lock.present).toBe(true);
    expect(lock.byName.get('picomatch')!.map((p) => p.version!.raw).sort()).toEqual(['2.3.2', '2.9.0']);
    expect(lock.byName.get('axios')![0]!.version!.raw).toBe('1.9.0');
  });

  test('воркспейс не считается установленной версией', () => {
    const web = lock.byPath.get('web')!;
    expect(web.workspace).toBe(true);
    expect(web.version).toBeNull();
    expect(web.deps).toEqual({ axios: '^1.5.0', picomatch: '^2.0.0' });
  });

  test('корневой воркспейс склеивает dependencies и devDependencies', () => {
    expect(lock.byPath.get('')!.deps).toEqual({ axios: '^1.0.0', typescript: '^5.0.0' });
  });

  test('обратный индекс: кто требует пакет и с каким диапазоном', () => {
    const reqs = lock.requiredBy.get('picomatch')!;
    expect(reqs.map((r) => `${r.owner}:${r.range}`).sort()).toEqual(['axios:^2.3.0', 'micromatch:^2.3.1', 'web:^2.0.0']);
  });

  test('разрешение идёт вверх по пути, как в node_modules', () => {
    const byOwner = new Map(lock.requiredBy.get('picomatch')!.map((r) => [r.owner, r]));
    // У axios своя вложенная копия — она и достаётся.
    expect(byOwner.get('axios')!.resolved!.version!.raw).toBe('2.9.0');
    // У micromatch своей нет: поднимается до корневой.
    expect(byOwner.get('micromatch')!.resolved!.version!.raw).toBe('2.3.2');
    // Воркспейс тоже видит корневую.
    expect(byOwner.get('web')!.resolved!.version!.raw).toBe('2.3.2');
  });

  test('воркспейсы помечены, чтобы не считаться внешними блокерами', () => {
    const reqs = lock.requiredBy.get('axios')!;
    expect(reqs.every((r) => r.fromWorkspace)).toBe(true);
  });

  test('overrides и trustedDependencies берутся как есть', () => {
    expect(lock.overrides).toEqual({ micromatch: { picomatch: '^2.3.2' } });
    expect(lock.trustedDependencies).toEqual(['esbuild']);
  });

  test('битый lockfile не роняет скан', () => {
    const broken = parseLock('{ не json', 'x');
    expect(broken.present).toBe(false);
    expect(broken.note).toContain('bun.lock не разобран');
  });

  test('bun.lock — JSONC: висячие запятые допустимы', () => {
    const jsonc = parseLock('{\n // комментарий\n "packages": { "a": ["a@1.0.0", "", {}, "sha512-q"], },\n}', 'x');
    expect(jsonc.present).toBe(true);
    expect(jsonc.byName.get('a')![0]!.version!.raw).toBe('1.0.0');
  });

  test('emptyLock — пустое дерево с причиной', () => {
    const empty = emptyLock('bun.lock не найден');
    expect(empty.present).toBe(false);
    expect(empty.byName.size).toBe(0);
  });
});

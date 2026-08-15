#!/usr/bin/env bun
/**
 * CLI пакета: установка, обновление и снятие скилла deps-update.
 *
 * Установка по умолчанию — симлинк из ~/.claude/skills/deps-update в этот репозиторий,
 * поэтому `git pull` сразу обновляет скилл. `--copy` кладёт независимую копию.
 */

import { chmod, cp, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILL_SRC = join(REPO_ROOT, 'skill');
const SKILL_NAME = 'deps-update';
/** Метка привязана к пути репозитория: две установки не должны глушить проверки друг друга. */
const STAMP = join(
  homedir(),
  '.cache',
  'claude-skill-deps-update',
  `last-selfupdate-${Bun.hash(REPO_ROOT).toString(36)}`,
);

const args = Bun.argv.slice(2);
const command = args[0] ?? 'help';
const has = (flag: string) => args.includes(`--${flag}`);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const skillsDir = value('skills-dir') ?? join(homedir(), '.claude', 'skills');
const target = value('target') ?? join(skillsDir, SKILL_NAME);

type Kind = 'absent' | 'symlink-ours' | 'symlink-foreign' | 'copy-ours' | 'directory-foreign' | 'file';

async function statKind(path: string): Promise<Kind> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) {
    const dest = resolve(dirname(path), await readlink(path));
    return dest === SKILL_SRC ? 'symlink-ours' : 'symlink-foreign';
  }
  if (!stat.isDirectory()) return 'file';
  const marker = Bun.file(join(path, 'SKILL.md'));
  if (await marker.exists()) {
    const head = (await marker.text()).slice(0, 400);
    if (head.includes(`name: ${SKILL_NAME}`)) return 'copy-ours';
  }
  return 'directory-foreign';
}

async function git(...gitArgs: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(['git', '-C', REPO_ROOT, ...gitArgs], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ok: code === 0, out: (out + err).trim() };
}

const pkg = await Bun.file(join(REPO_ROOT, 'package.json')).json();

async function install(): Promise<number> {
  const kind = await statKind(target);
  const copyMode = has('copy');

  if (kind === 'symlink-ours' && !copyMode) {
    console.log(`Уже установлен: ${target} → ${SKILL_SRC}`);
    return 0;
  }
  if (kind !== 'absent' && !has('force') && kind !== 'copy-ours' && kind !== 'symlink-ours') {
    console.error(`${target} уже занят (${kind}). Проверь вручную или повтори с --force.`);
    return 1;
  }
  if (kind !== 'absent') await rm(target, { recursive: true, force: true });

  await mkdir(dirname(target), { recursive: true });
  if (copyMode) {
    await cp(SKILL_SRC, target, { recursive: true });
    console.log(`Скилл скопирован в ${target}`);
    console.log('Копия не обновляется через git pull — для обновления запусти `bun bin/cli.ts install --copy --force`.');
  } else {
    await symlink(SKILL_SRC, target);
    console.log(`Скилл установлен: ${target} → ${SKILL_SRC}`);
    console.log('Обновление: `bun bin/cli.ts update` (git pull, симлинк подхватит изменения сам).');
  }
  console.log('Вызов в Claude Code: /deps-update');
  return 0;
}

async function update(): Promise<number> {
  const isRepo = (await git('rev-parse', '--is-inside-work-tree')).ok;
  if (isRepo) {
    const dirty = await git('status', '--porcelain');
    if (dirty.out) {
      console.error('В репозитории есть незакоммиченные изменения — pull отменён:');
      console.error(dirty.out);
      return 1;
    }
    const hasRemote = (await git('remote')).out.length > 0;
    if (hasRemote) {
      const pull = await git('pull', '--ff-only');
      console.log(pull.ok ? pull.out || 'git pull: без изменений' : `git pull не удался:\n${pull.out}`);
      if (!pull.ok) return 1;
    } else {
      console.log('remote не настроен — обновляю только установку.');
    }
  }

  const kind = await statKind(target);
  if (kind === 'absent') {
    console.log('Скилл не установлен — ставлю.');
    return install();
  }
  if (kind === 'copy-ours') {
    await rm(target, { recursive: true, force: true });
    await cp(SKILL_SRC, target, { recursive: true });
    console.log(`Копия обновлена: ${target}`);
    return 0;
  }
  if (kind === 'symlink-ours') {
    console.log(`Симлинк цел: ${target} → ${SKILL_SRC}`);
    return 0;
  }
  console.error(`${target} — это ${kind}, не наша установка. Разберись вручную.`);
  return 1;
}

/**
 * Тихое самообновление для хука SessionStart: fetch + fast-forward, не чаще `--max-age` секунд.
 *
 * Молчит всегда, кроме факта обновления: хук печатает в контекст сессии, и шум там дороже пользы.
 * Отказывается работать при незакоммиченных изменениях и при расхождении истории — тогда решает
 * человек, а не хук.
 */
async function selfupdate(): Promise<number> {
  const maxAge = Number(value('max-age') ?? 21600); // 6 часов
  const say = (msg: string) => console.log(msg);

  if (!(await git('rev-parse', '--is-inside-work-tree')).ok) return 0;
  if (!(await git('remote')).out) return 0;

  if (!has('force') && Number.isFinite(maxAge)) {
    try {
      const checkedAt = (await lstat(STAMP)).mtimeMs;
      if ((Date.now() - checkedAt) / 1000 < maxAge) return 0;
    } catch {
      // метки ещё нет — это первая проверка
    }
  }

  // Метку ставим до сети: недоступный remote не должен превращаться в проверку на каждый запуск.
  await mkdir(dirname(STAMP), { recursive: true });
  await Bun.write(STAMP, '');

  if ((await git('status', '--porcelain')).out) {
    if (!has('quiet')) console.error('deps-update: есть незакоммиченные изменения — автообновление пропущено');
    return 0;
  }

  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out;
  if (!(await git('fetch', '--quiet', 'origin', branch)).ok) return 0;

  const before = (await git('rev-parse', '--short', 'HEAD')).out;
  const remote = (await git('rev-parse', '--short', `origin/${branch}`)).out;
  if (!remote || before === remote) return 0;

  const merge = await git('merge', '--ff-only', `origin/${branch}`);
  if (!merge.ok) {
    if (!has('quiet')) console.error(`deps-update: fast-forward невозможен, обнови вручную:\n${merge.out}`);
    return 0;
  }

  const after = (await git('rev-parse', '--short', 'HEAD')).out;
  const version = (await Bun.file(join(REPO_ROOT, 'package.json')).json()).version;
  if ((await statKind(target)) === 'copy-ours') {
    await rm(target, { recursive: true, force: true });
    await cp(SKILL_SRC, target, { recursive: true });
  }
  say(`Скилл deps-update обновлён до ${version} (${before} → ${after}).`);
  return 0;
}

/**
 * Прописывает (или убирает) хук SessionStart в ~/.claude/settings.json.
 *
 * Хук вызывает `selfupdate`, поэтому обновление скилла перестаёт зависеть от того, вспомнил ли
 * кто-то про `git pull`. Настройки читаются и пишутся целиком, рядом остаётся `.bak`.
 */
async function hook(): Promise<number> {
  const settingsPath = value('settings') ?? join(homedir(), '.claude', 'settings.json');
  const command = `bun ${join(REPO_ROOT, 'bin', 'cli.ts')} selfupdate --quiet`;
  const file = Bun.file(settingsPath);
  const settings = (await file.exists()) ? await file.json() : {};

  settings.hooks ??= {};
  const entries: any[] = (settings.hooks.SessionStart ??= []);
  const isOurs = (entry: any) =>
    (entry?.hooks ?? []).some((h: any) => typeof h?.command === 'string' && h.command.includes('cli.ts selfupdate'));

  if (has('remove')) {
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length === entries.length) {
      console.log('Хук не найден — нечего убирать.');
      return 0;
    }
    settings.hooks.SessionStart = kept;
    if (kept.length === 0) delete settings.hooks.SessionStart;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  } else {
    const existing = entries.find(isOurs);
    // Без matcher — SessionStart его не использует. async: старт сессии не должен ждать сеть.
    const entry = { hooks: [{ type: 'command', command, timeout: 15, async: true }] };
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) {
        console.log(`Хук уже прописан в ${settingsPath}`);
        return 0;
      }
      Object.assign(existing, entry); // путь к репозиторию или таймаут изменились
    } else {
      entries.push(entry);
    }
  }

  // Права на settings.json обычно сужены (600) — Bun.write создаёт файл заново, режим надо вернуть.
  let mode: number | null = null;
  if (await file.exists()) {
    mode = (await lstat(settingsPath)).mode & 0o777;
    await Bun.write(`${settingsPath}.bak`, await file.text());
    await chmod(`${settingsPath}.bak`, mode);
  }
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  if (mode !== null) await chmod(settingsPath, mode);
  console.log(
    has('remove')
      ? `Хук убран из ${settingsPath} (копия прежних настроек — ${settingsPath}.bak)`
      : `Хук SessionStart прописан в ${settingsPath} (копия прежних настроек — ${settingsPath}.bak).\n` +
          'Скилл будет обновляться сам, не чаще раза в 6 часов.',
  );
  return 0;
}

async function status(): Promise<number> {
  const kind = await statKind(target);
  const head = await git('rev-parse', '--short', 'HEAD');
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = await git('status', '--porcelain');

  console.log(`пакет:      ${pkg.name}@${pkg.version}`);
  console.log(`репозиторий: ${REPO_ROOT}`);
  if (head.ok) console.log(`git:        ${branch.out}@${head.out}${dirty.out ? ' (есть незакоммиченные изменения)' : ''}`);
  console.log(`установка:  ${target}`);
  console.log(
    `состояние:  ${
      {
        'symlink-ours': 'установлен симлинком (git pull обновляет сразу)',
        'copy-ours': 'установлен копией (обновлять через `update`)',
        absent: 'НЕ установлен',
        'symlink-foreign': 'симлинк на чужой каталог',
        'directory-foreign': 'посторонний каталог',
        file: 'посторонний файл',
      }[kind]
    }`,
  );
  const settingsPath = value('settings') ?? join(homedir(), '.claude', 'settings.json');
  const settingsFile = Bun.file(settingsPath);
  const hooked = (await settingsFile.exists()) && (await settingsFile.text()).includes('cli.ts selfupdate');
  let checkedAgo = '';
  try {
    const ms = Date.now() - (await lstat(STAMP)).mtimeMs;
    checkedAgo = `, последняя проверка ${Math.floor(ms / 3_600_000)} ч ${Math.floor((ms % 3_600_000) / 60_000)} мин назад`;
  } catch {
    checkedAgo = ', проверок ещё не было';
  }
  console.log(`автообновление: ${hooked ? 'хук SessionStart прописан' : 'выключено (`hook` — включить)'}${checkedAgo}`);
  console.log(`bun:        ${Bun.version}`);
  return kind === 'absent' ? 1 : 0;
}

async function uninstall(): Promise<number> {
  const kind = await statKind(target);
  if (kind === 'absent') {
    console.log('Нечего снимать.');
    return 0;
  }
  if (kind !== 'symlink-ours' && kind !== 'copy-ours' && !has('force')) {
    console.error(`${target} — это ${kind}, не наша установка. Удаляй вручную или добавь --force.`);
    return 1;
  }
  await rm(target, { recursive: true, force: true });
  console.log(`Снято: ${target} (файлы пакета в ${REPO_ROOT} не тронуты)`);
  return 0;
}

async function scan(): Promise<number> {
  const proc = Bun.spawn(['bun', join(SKILL_SRC, 'scripts', 'deps-scan.ts'), ...args.slice(1)], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return proc.exited;
}

function help(): number {
  console.log(`${pkg.name}@${pkg.version} — скилл ${SKILL_NAME} для Claude Code

  bun bin/cli.ts install [--copy] [--force] [--skills-dir <dir>] [--target <dir>]
  bun bin/cli.ts update            git pull + актуализация установки
  bun bin/cli.ts selfupdate        тихий fetch + fast-forward для хука SessionStart
                                   [--max-age <sec>, по умолчанию 21600] [--force] [--quiet]
  bun bin/cli.ts hook [--remove]   прописать/убрать хук SessionStart в ~/.claude/settings.json
  bun bin/cli.ts status            где установлен, какая ревизия
  bun bin/cli.ts uninstall         снять установку (файлы пакета остаются)
  bun bin/cli.ts scan [args...]    запустить анализатор в текущем проекте

Анализатор напрямую (из корня проверяемого проекта):
  bun ${join(SKILL_SRC, 'scripts', 'deps-scan.ts')} [--json] [--no-net] [--no-why] [--cwd <path>]`);
  return 0;
}

const handlers: Record<string, () => Promise<number> | number> = {
  install,
  update,
  selfupdate,
  hook,
  status,
  uninstall,
  scan,
  help,
  '--help': help,
  '-h': help,
};

const handler = handlers[command];
if (!handler) {
  console.error(`Неизвестная команда: ${command}\n`);
  help();
  process.exit(1);
}

process.exit(await handler());

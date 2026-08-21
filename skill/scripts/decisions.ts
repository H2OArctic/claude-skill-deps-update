#!/usr/bin/env bun
/**
 * Журнал решений «этот пакет пока не обновляем».
 *
 * Хранится в проверяемом проекте: `.claude/deps-update.json`. Нужен, чтобы один и тот же вопрос
 * не задавался каждый прогон, и чтобы к нему вернулись, когда изменится причина отказа —
 * условия возврата проверяет deps-scan.ts.
 *
 * Usage:
 *   bun decisions.ts list   [--cwd <path>] [--json]
 *   bun decisions.ts defer  <pkg> --declined <version> [--installed <version>] [--reason "..."]
 *                                 [--blocked-by <pkg,pkg>] [--major-above <N>] [--after <YYYY-MM-DD>]
 *   bun decisions.ts resume <pkg>          снять отложенность — вопрос вернётся в следующий прогон
 *   bun decisions.ts prune                 убрать записи о пакетах, которых больше нет в package.json
 */

import { parseVersion } from './lib/semver.ts';

type Revisit = {
  /** Вернуться, когда эти родители перестанут ограничивать пакет. */
  whenBlockerAllows?: string[];
  /** Вернуться, если выйдет мажор выше этого (по умолчанию — мажор отклонённой версии). */
  whenMajorAbove?: number;
  /** Вернуться после этой даты (YYYY-MM-DD). */
  after?: string;
};

type Decision = {
  package: string;
  declinedVersion: string;
  installedAtDecision?: string;
  reason: string;
  decidedAt: string;
  revisit: Revisit;
};

type Journal = { version: 1; deferred: Decision[] };

const args = Bun.argv.slice(2);
const command = args[0] ?? 'help';
const positional = args.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));
const has = (flag: string) => args.includes(`--${flag}`);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Значение флага — не позиционный аргумент. */
function isFlagValue(arg: string): boolean {
  const i = args.indexOf(arg);
  return i > 0 && args[i - 1]!.startsWith('--');
}

const root = value('cwd') ?? process.cwd();
const journalPath = value('file') ?? `${root}/.claude/deps-update.json`;

async function read(): Promise<Journal> {
  const file = Bun.file(journalPath);
  if (!(await file.exists())) return { version: 1, deferred: [] };
  const data = await file.json();
  return { version: 1, deferred: Array.isArray(data?.deferred) ? data.deferred : [] };
}

async function write(journal: Journal): Promise<void> {
  journal.deferred.sort((a, b) => a.package.localeCompare(b.package));
  await Bun.write(journalPath, JSON.stringify(journal, null, 2) + '\n');
}

const today = () => new Date().toISOString().slice(0, 10);

async function list(): Promise<number> {
  const journal = await read();
  if (has('json')) {
    console.log(JSON.stringify(journal, null, 2));
    return 0;
  }
  if (journal.deferred.length === 0) {
    console.log(`Отложенных решений нет (${journalPath})`);
    return 0;
  }
  console.log(`Отложено (${journal.deferred.length}) — ${journalPath}:`);
  for (const d of journal.deferred) {
    const when = [
      d.revisit.whenBlockerAllows?.length ? `когда отпустит ${d.revisit.whenBlockerAllows.join(', ')}` : null,
      d.revisit.whenMajorAbove !== undefined ? `при мажоре выше ${d.revisit.whenMajorAbove}` : null,
      d.revisit.after ? `после ${d.revisit.after}` : null,
    ].filter(Boolean);
    console.log(`- ${d.package}: отказ от ${d.declinedVersion} (${d.decidedAt}) — ${d.reason}`);
    console.log(`    вернуться: ${when.length ? when.join('; ') : 'только вручную (resume)'}`);
  }
  return 0;
}

async function defer(): Promise<number> {
  const pkg = positional[0];
  const declined = value('declined');
  if (!pkg || !declined) {
    console.error('Нужны имя пакета и --declined <version>');
    return 1;
  }

  // Точная версия, а не диапазон: по её мажору deps-scan решает, что следующий — уже другой вопрос.
  const parsed = parseVersion(declined);
  if (!parsed) {
    console.error(`--declined ждёт точную версию (например 5.2.1), получено «${declined}».`);
    return 1;
  }

  const explicitMajor = value('major-above');
  const revisit: Revisit = {
    whenMajorAbove: explicitMajor !== undefined ? Number(explicitMajor) : parsed.major,
  };
  const blockedBy = value('blocked-by');
  if (blockedBy) revisit.whenBlockerAllows = blockedBy.split(',').map((s) => s.trim()).filter(Boolean);
  if (value('after')) revisit.after = value('after');
  if (Number.isNaN(revisit.whenMajorAbove)) {
    console.error(`--major-above ждёт число, получено «${explicitMajor}».`);
    return 1;
  }

  const journal = await read();
  const entry: Decision = {
    package: pkg,
    declinedVersion: declined,
    installedAtDecision: value('installed'),
    reason: value('reason') ?? 'решение пользователя',
    decidedAt: today(),
    revisit,
  };
  const existing = journal.deferred.findIndex((d) => d.package === pkg);
  if (existing >= 0) journal.deferred[existing] = entry;
  else journal.deferred.push(entry);

  await write(journal);
  console.log(`${existing >= 0 ? 'Обновлено' : 'Отложено'}: ${pkg} ≠> ${declined} → ${journalPath}`);
  return 0;
}

async function resume(): Promise<number> {
  const pkg = positional[0];
  if (!pkg) {
    console.error('Нужно имя пакета');
    return 1;
  }
  const journal = await read();
  const before = journal.deferred.length;
  journal.deferred = journal.deferred.filter((d) => d.package !== pkg);
  if (journal.deferred.length === before) {
    console.log(`${pkg} не был отложен`);
    return 0;
  }
  await write(journal);
  console.log(`${pkg} снят с отложенных — вопрос вернётся в следующем прогоне`);
  return 0;
}

async function prune(): Promise<number> {
  const journal = await read();
  const declared = new Set<string>();
  const rootPkg = await Bun.file(`${root}/package.json`).json();
  const wsField = rootPkg.workspaces;
  const patterns: string[] = Array.isArray(wsField) ? wsField : (wsField?.packages ?? []);

  const collect = (pkg: any) => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg?.[field] ?? {})) declared.add(name);
    }
  };
  collect(rootPkg);
  for (const pattern of patterns) {
    for await (const hit of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root, onlyFiles: true })) {
      collect(await Bun.file(`${root}/${hit}`).json());
    }
  }

  const stale = journal.deferred.filter((d) => !declared.has(d.package));
  if (stale.length === 0) {
    console.log('Нечего чистить: все отложенные пакеты ещё объявлены.');
    return 0;
  }
  journal.deferred = journal.deferred.filter((d) => declared.has(d.package));
  await write(journal);
  console.log(`Убрано (пакетов больше нет в package.json): ${stale.map((d) => d.package).join(', ')}`);
  return 0;
}

function help(): number {
  console.log(`Журнал решений «пока не обновляем» — ${journalPath}

  bun decisions.ts list   [--json]
  bun decisions.ts defer  <pkg> --declined <version> [--installed <version>] [--reason "..."]
                                [--blocked-by <pkg,pkg>] [--major-above <N>] [--after <YYYY-MM-DD>]
  bun decisions.ts resume <pkg>
  bun decisions.ts prune

Общие флаги: --cwd <path> (корень проекта), --file <path> (другой путь журнала).

Условия возврата проверяет deps-scan.ts: он сам поднимает вопрос, когда блокер отпустил пакет,
вышел мажор выше отклонённого или истёк срок. Без условий вопрос не задаётся до \`resume\`.`);
  return 0;
}

const handlers: Record<string, () => Promise<number> | number> = { list, defer, resume, prune, help, '--help': help, '-h': help };
const handler = handlers[command];
if (!handler) {
  console.error(`Неизвестная команда: ${command}\n`);
  help();
  process.exit(1);
}
process.exit(await handler());

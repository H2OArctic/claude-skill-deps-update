/**
 * Разбор вывода `bun audit` и `bun audit fix --dry-run`.
 *
 * Здесь один принцип: **пустой аудит и несостоявшийся аудит — разные вещи**. Раньше вывод команды
 * склеивался из stdout и stderr, а результат парсился как «от первой `{` и до конца строки»:
 * любой `warn:` в stderr или строка версии с фигурной скобкой ломали `JSON.parse`, ошибка
 * гасилась через `?? {}`, и отчёт писал «`bun audit`: чисто» на проекте с открытыми advisory.
 * Поэтому всё, что не разобралось, возвращает `null` — вызывающий обязан сказать об этом вслух.
 *
 * Форматы (Bun 1.4):
 *   `bun audit --json`                  → `{ "<пакет>": [advisory, ...], ... }`, `{}` = чисто
 *   `bun audit fix --dry-run --json`    → `{ dryRun, fixed, remaining, fixes[], blocked[], unfixable[], ... }`
 *   `bun audit` (текст)                 → человекочитаемый отчёт, в конце строка-сводка
 */

export type Advisory = { title: string; severity: string; url: string; range: string };
export type VulnPackage = { name: string; advisories: Advisory[] };
export type SeverityCount = Record<string, number>;
export type AuditSummary = { total: number; bySeverity: SeverityCount };

/** Порядок вывода в отчёте — от худшего к безобидному. */
export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info', 'unknown'] as const;

/**
 * Первый сбалансированный JSON-объект/массив в выводе команды.
 *
 * До JSON Bun печатает строку версии (`bun dedupe v1.4.0 (34cbb9a40)`), после — может допечатать
 * что угодно, поэтому границу надо считать по скобкам, а не брать хвост строки целиком.
 */
export function extractJson(out: string): unknown | null {
  const start = out.search(/[{\[]/);
  if (start === -1) return null;

  const open = out[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < out.length; i++) {
    const ch = out[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(out.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * `bun audit --json` → пакеты с advisory.
 *
 * `null` означает «формат не тот» — например, Bun сменил схему вывода. Пустой массив означает
 * «проверено, уязвимостей нет»; путать эти два случая нельзя, отсюда и разные типы возврата.
 */
export function parseAuditReport(body: unknown): VulnPackage[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const packages: VulnPackage[] = [];
  for (const [name, list] of Object.entries(body as Record<string, unknown>)) {
    if (!Array.isArray(list)) return null;
    if (!list.length) continue;
    packages.push({
      name,
      advisories: list.map((a: any) => ({
        title: typeof a?.title === 'string' ? a.title : '',
        severity: typeof a?.severity === 'string' ? a.severity : 'unknown',
        url: typeof a?.url === 'string' ? a.url : '',
        range: typeof a?.vulnerable_versions === 'string' ? a.vulnerable_versions : '',
      })),
    });
  }
  return packages;
}

/** Считает advisory, а не пакеты: `bun audit` в сводке считает именно их, и цифры должны сходиться. */
export function countSeverities(packages: VulnPackage[]): AuditSummary {
  const bySeverity: SeverityCount = {};
  let total = 0;
  for (const pkg of packages) {
    for (const a of pkg.advisories) {
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      total++;
    }
  }
  return { total, bySeverity };
}

/** `5 high, 1 moderate, 2 low` — в порядке убывания опасности. */
export function formatSeverities(bySeverity: SeverityCount): string {
  const known = SEVERITY_ORDER.filter((s) => bySeverity[s]).map((s) => `${bySeverity[s]} ${s}`);
  const rest = Object.entries(bySeverity)
    .filter(([s]) => !(SEVERITY_ORDER as readonly string[]).includes(s))
    .map(([s, n]) => `${n} ${s}`);
  return [...known, ...rest].join(', ');
}

/**
 * Сводка из текстового `bun audit` — запасной источник, когда `--json` не разобрался.
 *
 * Формат строки: `59 vulnerabilities (3 critical, 32 high, 22 moderate, 2 low)`, при чистом дереве —
 * `No vulnerabilities found (checked 4 packages)`.
 */
export function parseAuditSummary(text: string): AuditSummary | null {
  const matches = [...text.matchAll(/(\d+)\s+vulnerabilit(?:y|ies)(?:\s*\(([^)]*)\))?/g)];
  const last = matches[matches.length - 1];
  if (!last) return /no vulnerabilities/i.test(text) ? { total: 0, bySeverity: {} } : null;

  const bySeverity: SeverityCount = {};
  for (const [, n, sev] of (last[2] ?? '').matchAll(/(\d+)\s+([a-z]+)/gi)) {
    bySeverity[sev!.toLowerCase()] = Number(n);
  }
  return { total: Number(last[1]), bySeverity };
}

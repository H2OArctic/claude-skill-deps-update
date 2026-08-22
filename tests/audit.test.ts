import { describe, expect, test } from 'bun:test';
import {
  countSeverities,
  extractJson,
  formatSeverities,
  parseAuditReport,
  parseAuditSummary,
} from '../skill/scripts/lib/audit.ts';

describe('extractJson', () => {
  test('строка версии перед JSON не мешает', () => {
    expect(extractJson('bun dedupe v1.4.0 (34cbb9a40)\n{"fixed":2}')).toEqual({ fixed: 2 });
  });

  test('регрессия: мусор ПОСЛЕ JSON больше не ломает разбор', () => {
    // Так выглядел склеенный stdout+stderr — из-за него живой аудит читался как «не вернул JSON».
    expect(extractJson('{"fixed":2,"remaining":0}\nwarn: incorrect peer dependency "left-pad@1.0.0"\n')).toEqual({
      fixed: 2,
      remaining: 0,
    });
  });

  test('скобки внутри строк не сдвигают границу', () => {
    expect(extractJson('{"title":"DoS via {nested} braces","severity":"high"}')).toEqual({
      title: 'DoS via {nested} braces',
      severity: 'high',
    });
    expect(extractJson('{"title":"экранированная \\" кавычка и }","n":1}')).toEqual({
      title: 'экранированная " кавычка и }',
      n: 1,
    });
  });

  test('вложенность считается по внешним скобкам', () => {
    expect(extractJson('x {"a":{"b":[1,2]},"c":3} y')).toEqual({ a: { b: [1, 2] }, c: 3 });
  });

  test('массив на верхнем уровне', () => {
    expect(extractJson('log\n[{"a":1},{"b":2}] tail')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('нет JSON или он оборван — null, а не пустой объект', () => {
    expect(extractJson('error: missing lockfile, nothing to audit')).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson('{"a":1')).toBeNull();
    expect(extractJson('{oops}')).toBeNull();
  });
});

describe('parseAuditReport', () => {
  const advisory = {
    id: 1097678,
    url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
    title: 'Prototype Pollution in minimist',
    severity: 'critical',
    vulnerable_versions: '>=1.0.0 <1.2.6',
  };

  test('пустой отчёт — это проверенное «чисто», а не сбой', () => {
    expect(parseAuditReport({})).toEqual([]);
  });

  test('пакеты с advisory', () => {
    expect(parseAuditReport({ minimist: [advisory] })).toEqual([
      {
        name: 'minimist',
        advisories: [
          {
            title: 'Prototype Pollution in minimist',
            severity: 'critical',
            url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
            range: '>=1.0.0 <1.2.6',
          },
        ],
      },
    ]);
  });

  test('пакеты с пустым списком отбрасываются', () => {
    expect(parseAuditReport({ lodash: [] })).toEqual([]);
  });

  test('незнакомый формат — null, чтобы отчёт не показал ноль', () => {
    expect(parseAuditReport({ advisories: { 1: advisory }, metadata: {} })).toBeNull();
    expect(parseAuditReport(null)).toBeNull();
    expect(parseAuditReport([advisory])).toBeNull();
    expect(parseAuditReport('{}')).toBeNull();
  });

  test('поля advisory могут отсутствовать', () => {
    expect(parseAuditReport({ pkg: [{}] })).toEqual([
      { name: 'pkg', advisories: [{ title: '', severity: 'unknown', url: '', range: '' }] },
    ]);
  });
});

describe('countSeverities / formatSeverities', () => {
  const packages = [
    { name: 'axios', advisories: [sev('high'), sev('high'), sev('high')] },
    { name: 'ws', advisories: [sev('high'), sev('high'), sev('moderate'), sev('low'), sev('low')] },
  ];

  test('считаются advisory, а не пакеты', () => {
    expect(countSeverities(packages)).toEqual({ total: 8, bySeverity: { high: 5, moderate: 1, low: 2 } });
  });

  test('порядок — от худшего к безобидному', () => {
    expect(formatSeverities({ low: 2, high: 5, moderate: 1 })).toBe('5 high, 1 moderate, 2 low');
  });

  test('незнакомая severity не теряется', () => {
    expect(formatSeverities({ high: 1, exotic: 2 })).toBe('1 high, 2 exotic');
  });

  test('пусто — пустая строка', () => {
    expect(countSeverities([])).toEqual({ total: 0, bySeverity: {} });
    expect(formatSeverities({})).toBe('');
  });
});

describe('parseAuditSummary', () => {
  test('сводка текстового bun audit', () => {
    const text = 'ws@5.0.0\n  high: ...\n\n59 vulnerabilities (3 critical, 32 high, 22 moderate, 2 low)\n';
    expect(parseAuditSummary(text)).toEqual({
      total: 59,
      bySeverity: { critical: 3, high: 32, moderate: 22, low: 2 },
    });
  });

  test('единственное число и отсутствие разбивки', () => {
    expect(parseAuditSummary('1 vulnerability (1 high)')).toEqual({ total: 1, bySeverity: { high: 1 } });
    expect(parseAuditSummary('4 vulnerabilities')).toEqual({ total: 4, bySeverity: {} });
  });

  test('чистое дерево', () => {
    expect(parseAuditSummary('No vulnerabilities found (checked 4 packages) [630.00ms]')).toEqual({
      total: 0,
      bySeverity: {},
    });
  });

  test('берётся последняя сводка, а не упоминание в тексте advisory', () => {
    const text = 'note: 2 vulnerabilities were ignored\n\n8 vulnerabilities (5 high, 1 moderate, 2 low)\n';
    expect(parseAuditSummary(text)?.total).toBe(8);
  });

  test('ошибка вместо отчёта — null', () => {
    expect(parseAuditSummary('error: missing lockfile, nothing to audit')).toBeNull();
  });
});

function sev(severity: string) {
  return { title: '', severity, url: '', range: '' };
}

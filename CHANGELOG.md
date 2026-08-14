# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [1.0.0] — 2026-08-14

### Добавлено

- Скилл `deps-update`: шесть фаз (предполёт → инвентаризация → план по группам риска → правки →
  пересборка lockfile → верификация → отчёт).
- Анализатор `skill/scripts/deps-scan.ts` (read-only): расхождения версий по воркспейсам, классы риска
  с отдельной трактовкой `0.x` и `0.0.x`, семейства пакетов, вердикты по `overrides`/`resolutions`
  на основе `bun why`, deprecated-пакеты, сложные диапазоны на ручную проверку. Флаги `--json`,
  `--no-net`, `--no-why`, `--cwd`.
- CLI `bin/cli.ts`: `install` (симлинк или `--copy`), `update`, `status`, `uninstall`, `scan`.

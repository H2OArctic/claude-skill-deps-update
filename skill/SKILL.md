---
name: deps-update
description: Update libraries in a Bun project or monorepo with control over overrides, exact pins, 0.x versions, peer conflicts, and lockfile rebuild. Use when updating dependencies, bumping libraries, checking outdated packages, running bun audit, cleaning up overrides/resolutions, or refreshing bun.lock.
---

# Dependency updates (Bun)

Runtime and package manager: **Bun only**. Never `npm`, `npx`, `yarn`, `pnpm`, or `node`.

This skill does not chase `latest`. It splits updates by risk, manages `overrides` as a separate concern,
and ends with a rebuilt lockfile plus typecheck and tests.

Talk to the user in the language they use.

## Invariant

**Nothing is written to disk before the plan is approved (phase 2).** Phases 0–1 are read-only.

## Phase 0. Preflight

```bash
git status --porcelain        # working tree must be clean
git branch --show-current
bun --version
```

- Dirty tree → tell the user and ask whether to continue. A clean tree means rollback is one command
  (`git checkout -- .`), so no backups are needed.
- Read the root `package.json`: which scripts exist (typecheck, tests, lockfile `clean`, dead-code checks),
  whether there are `workspaces`, `overrides`/`resolutions`. Use the project's own script names later —
  do not assume them.
- No `workspaces` → the skill works the same, just one package.

## Phase 1. Inventory (read-only)

```bash
bun ~/.claude/skills/deps-update/scripts/deps-scan.ts            # + --json, --no-net, --no-why
bun outdated                                                     # root package.json
bun outdated --filter='*'                                        # every workspace
bun audit --json                                                 # vulnerabilities from the lockfile
```

`deps-scan.ts` reports: version mismatches across workspaces, a risk class per update, exact pins,
package families, verdicts on `overrides`, and deprecated packages.
`bun outdated` is the independent cross-check (`Update` = what the current range allows, `Latest` = absolute).
Never paper over disagreements between the script and `bun outdated` — show them.

For anything that looks blocked, find the actual reason instead of guessing:

```bash
bun why <pkg> --top          # who requires it and with which ranges
bun info <pkg>@<ver> peerDependencies
bun info <pkg> versions      # are there intermediate versions at all
```

## Phase 2. Plan by risk group

Sort candidates into four groups and **show them to the user before touching any file**.

### A. Update right away

- `patch` and `minor` when major ≥ 1, no peer conflicts, not part of a pinned family.
- Mismatch alignment: one library, one version across every `package.json`.

### B. Only with the user's decision, after reading the changelog

- **Majors** (`5 → 6`).
- **`0.x` minors** — `^0.35.3` only allows `0.35.x`, so `0.36.0` breaks exactly like `1.x → 2.0` does.
  For `0.0.x`, even a patch counts as breaking.
- **Exactly pinned** packages (no `^`) — the pin is deliberate, usually because the author hit a real
  incompatibility. Do not widen the range: either a new exact version, or nothing.
- **Families** — a scoped set (`@scope/*`) or a framework plus its plugins and adapters, where every member
  must share one version. Update as a whole or not at all; a half-updated family fails at runtime, not at
  install time.
- **Deprecated latest** — updating is pointless, migration is needed; list it as its own item.
- **Prerelease** as `latest` — never propose it as a target.

For every B item, read the changelog **before** editing: GitHub Releases / `CHANGELOG.md` via WebFetch
(get the URL from `bun info <pkg> --json` → `repository`/`homepage`), or Context7 MCP for documented libraries.
Report per item: what breaks, whether this project's code actually touches it (grep the real call sites),
and how much work it is.

### C. Leave alone — blocked by peers

A direct dependency cannot move past what a parent's `peerDependencies` allow: if a framework requires
`^16.8.1` of a library, that library's `17.x` is unreachable until the framework's own major lands.
Show the `bun why` output as evidence and do not try to work around it.

### D. Overrides / resolutions

Verdicts from `deps-scan.ts`:

- `REDUNDANT_NOW` — parents already require at least this much. **Removal candidate**: drop it, run
  `bun install`, then `bun audit` + `bun why <pkg>`. Version held and no vulnerabilities? Remove for good.
  Version regressed → put it back and record in the report that the override is still load-bearing.
- `RAISES_FLOOR` — raises the minimum inside what parents allow. Ordinary security override, keep it.
- `BREAKS_CEILING` — forces a version above what the parent considers compatible (parent asks for `^1.1.7`,
  the override supplies `^5.0.8`). Keep it, but remember this is a potential runtime bug, not just freshness.
  A major-sized gap is a red flag — call it out.
- **A new override is needed** when `bun audit` reports a vulnerability in a transitive dependency with no
  direct owner. Use the minimum sufficient range (`^` of the fixed version), never "a bit higher just in case".
- A package present both in `overrides` and in direct dependencies must be **edited in both places at once** —
  otherwise the override silently caps the update, or raises the installed version past what `package.json` says.

## Phase 3. Edits

- Edit `package.json` files by hand — not `bun update` — so the diff stays predictable and reviewable.
- One library → the same version string in every workspace. Preserve the range style (`^` stays `^`,
  exact stays exact).
- Do **not** align `peerDependencies` of internal workspace packages (`*`, `>=11.1.29`) — they are
  deliberately wide.
- Change nothing else: no formatting, no drive-by fixes. Versions only.

## Phase 4. Lockfile

```bash
bun install                            # check the tree resolves at all
```

Then rebuild the lockfile from scratch — **ask for confirmation**, this is slow and wipes `node_modules`:

```bash
bun run clean                          # if the project has such a script
```

No `clean` script → equivalent: `rm -rf node_modules **/node_modules bun.lock && bun install`.

After the rebuild:

```bash
bun audit
bun outdated --filter='*'
git diff --stat
```

- `postinstall` codegen hooks run on their own. If one fails, the cause is env/schema, not the update —
  do not conflate the two in the report.
- Rebuilding the lock pulls the maximum allowed by each range, so versions can move further than the
  `package.json` edits (the "max in range" column of the scan). That is expected, but list every such move.

## Phase 5. Verification

Run the project's own checks, in order, stopping at the first failure: typecheck first, then the build/compile
check if there is one, then tests.

- Tests may need a live database or other services. Unavailable → say plainly that they did not run;
  never present that as success.
- On failure: find the culprit (`git diff` + the error) and roll back **only that package**, keeping the rest.
  A breaking major from group B gets reverted whole and reported as "needs its own task".

## Phase 6. Report

```
## Updated
<package: from → to, workspaces>

## Aligned
<package: N different versions → one>

## Overrides
<removed / added / kept, and why>

## Lockfile
<bun.lock rebuilt: yes/no; versions that moved inside their ranges>

## Untouched
<package — reason: peer block (bun why), 0.x major, exact pin, deprecated>

## Checks
<typecheck / build / tests — result of each>

## Needs a decision
<majors with changelog highlights and an effort estimate>
```

## Never

- Turn an exact version into `^`, or "simplify" a pin.
- Bump a `0.x` minor, a major, or a pinned family without explicit consent.
- Remove an override without running `bun audit` and `bun why` afterwards.
- Wipe `node_modules` or the lockfile without confirmation.
- Commit or push: committing happens only on a separate, explicit request.
- Report success when tests did not run or failed.

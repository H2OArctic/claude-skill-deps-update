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

One exception, and only with the user's consent: the overrides experiment in phase 2D temporarily edits
the root `package.json` and reinstalls. Keep the original `overrides` block verbatim and restore it the
moment the experiment ends — the plan is written from its result, not from it being left in place.

## Phase 0. Preflight

```bash
git status --porcelain        # working tree must be clean
git branch --show-current
bun --version
```

- Dirty tree → **look at what is actually in the diff** (`git diff --stat`, then the `package.json` diff)
  before asking anything. It is often a previous run of this skill, or unrelated work in progress; the two
  need different handling. Show the user what you found, then ask whether to continue. A clean tree means
  rollback is one command (`git checkout -- .`), so no backups are needed.
- Working on top of someone else's uncommitted work is allowed, but from that moment you must be able to
  say which changes are yours — phase 5 failures will otherwise get blamed on the update.
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

`deps-scan.ts` reports: version mismatches across workspaces, duplicate copies in the tree, a risk class
per update, exact pins, package families, verdicts on `overrides`, and deprecated packages.
`bun outdated` is the independent cross-check (`Update` = what the current range allows, `Latest` = absolute).
Never paper over disagreements between the script and `bun outdated` — show them.

The two tools measure different things and disagree by design: the scan's range column is what
`package.json` *declares*, `bun outdated`'s `Current` is what is *installed*. A dependency declared
`^4.1.0` with `4.2.0` on disk is already up to date — editing the range there is bookkeeping,
not an update. Say which of the two you mean, every time.

For anything that looks blocked, find the actual reason instead of guessing:

```bash
bun pm ls --all              # every installed copy — the tree as it really is
bun why <pkg>                # who requires it and with which ranges
bun info <pkg>@<ver> peerDependencies
bun info <pkg> versions      # are there intermediate versions at all
```

**A package can be in the tree several times.** `bun why <pkg>` prints each copy as its own block, and
`--top` trims the parent chains — so the first `pkg@version` line is one copy out of N, never "the"
installed version. Read the whole output, or take versions from `bun pm ls --all`. Reasoning from one
copy is how an override gets called load-bearing when the old copy it was supposed to fix is still there.

## Phase 2. Plan by risk group

Sort candidates into four groups and **show them to the user before touching any file**.

### A. Update right away

- `patch` and `minor` when major ≥ 1, no peer conflicts, not part of a pinned family.
- Mismatch alignment: one library, one version across every `package.json`.

### B. Only with the user's decision, after reading the changelog

- **Majors** (`5 → 6`).
- **`0.x` minors** — a caret on a `0.x` version only allows that same minor, so bumping the minor
  (`0.x → 0.x+1`) breaks exactly like `1.x → 2.0` does. For `0.0.x`, even a patch counts as breaking.
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
`^2.4.0` of a library, that library's `3.x` is unreachable until the framework's own major lands.
Show the `bun why` output as evidence and do not try to work around it.

### D. Overrides / resolutions

**Decide this by experiment, not by reading ranges.** An override's declared range says what it asks for;
only the tree says what it did. Bun does not rewrite every branch — an override can sit in `package.json`
for a year while the old copy it was meant to replace is still installed under some parent.

Run the whole set at once — one experiment answers the entire block:

```bash
# 1. baseline, with overrides in place
bun audit                              # expect: clean
bun pm ls --all                        # keep this output

# 2. strip ALL overrides from the root package.json, then
bun install
bun audit                              # what surfaced is what the overrides were actually holding
bun pm ls --all                        # what changed version, what split into two copies
```

Read the result:

- **A package shows up in `bun audit`** → that override is load-bearing. Put it back.
- **A package collapsed several copies into one** (two versions in the tree became one) → load-bearing too,
  even if `audit` is quiet: it is de-duplicating the tree.
- **Nothing changed — same version, same number of copies, clean audit** → dead weight. Remove it.

Then restore only the load-bearing ones and reinstall. Report the experiment's numbers (`N vulnerabilities
without them`), not your reasoning about ranges.

Verdicts from `deps-scan.ts` are **hypotheses to prioritise the experiment**, never the conclusion:

- `REDUNDANT_NOW` — parents already require at least this much. Most likely removable.
- `RAISES_FLOOR` — raises the minimum inside what parents allow. Looks like a security override.
- `BREAKS_CEILING` — asks for a version above what the parent considers compatible. Frequently a fiction:
  if the scan also marks ⚠ (several copies), the parent's old copy is still installed, so nothing was
  forced on it and nothing is at risk — the override just did not reach that branch.
- `NOT_APPLIED` — no installed copy satisfies the override at all: the lockfile drifted from `package.json`
  (run `bun install`), or Bun never applied it. Range-based verdicts mean nothing here.

Two rules that hold regardless of the experiment:

- **A new override is needed** when `bun audit` reports a vulnerability in a transitive dependency with no
  direct owner. Use the minimum sufficient range (`^` of the fixed version), never "a bit higher just in case".
- A package present both in `overrides` and in direct dependencies must be **edited in both places at once** —
  otherwise the override silently caps the update, or raises the installed version past what `package.json` says.

## Phase 3. Edits

- Edit `package.json` files by hand — not `bun update` — so the diff stays predictable and reviewable.
- One library → the same version string in every workspace. Preserve the range style (`^` stays `^`,
  exact stays exact).
- Do **not** align `peerDependencies` of internal workspace packages (`*`, `>=11`) — they are
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
- Generated code does not always live in `node_modules` — some generators emit into the project's own
  source tree, where `clean` leaves it untouched and no regeneration is needed. Check where it actually is
  before concluding that a wave of type errors came from the wipe.
- Rebuilding the lock pulls the maximum allowed by each range, so versions can move further than the
  `package.json` edits (the "max in range" column of the scan). That is expected, but list every such move.

## Phase 5. Verification

Run the project's own checks, in order, stopping at the first failure: typecheck first, then the build/compile
check if there is one, then tests.

- **A command that exits 0 without doing anything is not a passing check.** A task runner reporting
  `0 successful, 0 total` / "no tasks were executed" means the script is missing in the workspaces, not that
  the code is fine. Look for the check that really compiles the project (a root `tsc --build`, for instance)
  and say which one you ran.
- Tests may need a live database or other services. Unavailable → say plainly that they did not run;
  never present that as success.
- Failures in files that were already dirty when you started are not yours. Name the file and the error,
  state that it is unrelated to the dependency work, and do not "fix" someone's work in progress.
- On failure: find the culprit (`git diff` + the error) and roll back **only that package**, keeping the rest.
  A breaking major from group B gets reverted whole and reported as "needs its own task".

## Phase 6. Report

```
## Updated
<package: from → to, workspaces>

## Aligned
<package: N different versions → one>

## Overrides
<removed / added / kept — with the experiment's numbers: vulnerabilities and copies with and without them>

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
- Keep an override because a verdict said so. Verdicts rank ranges; only removing it and reinstalling
  shows what it does.
- Read one `pkg@version` line and call it the installed version — count the copies first.
- Wipe `node_modules` or the lockfile without confirmation.
- Commit or push: committing happens only on a separate, explicit request.
- Report success when tests did not run or failed.

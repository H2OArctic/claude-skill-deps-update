---
name: deps-update
description: Update libraries in a Bun project or monorepo with control over overrides, exact pins, 0.x versions, peer conflicts, supply-chain risk, and lockfile rebuild. Use when updating dependencies, bumping libraries, checking outdated packages, running bun audit, cleaning up overrides/resolutions, deduplicating the tree, or refreshing bun.lock.
---

# Dependency updates (Bun)

Runtime and package manager: **Bun only**. Never `npm`, `npx`, `yarn`, `pnpm`, or `node`.
Requires **Bun >= 1.4** (`bun audit fix`, `bun dedupe`, `bun pm diff`, `--minimum-release-age`).

This skill does not chase `latest`. It splits updates by risk, rebuilds the lockfile, then settles
`overrides` on that final tree, and ends with typecheck and tests.

Talk to the user in the language they use.

## Invariant

**Nothing is written to disk before the plan is approved (phase 2).** Phases 0–1 are read-only, and the
new tools keep it that way: `bun pm diff` only downloads and compares tarballs, while `bun audit fix` and
`bun dedupe` resolve and report **as long as `--dry-run` is there**. Without that flag both rewrite
`bun.lock` and `node_modules` (and `audit fix` rewrites `package.json` too), so in phases 0–1 they are
never run bare.

The overrides experiment in phase 5 temporarily strips the root `overrides` block and reinstalls. Keep the
original block verbatim: everything load-bearing goes back before the phase ends, so the stripped state is
a measurement, never a result.

## Phase 0. Preflight

```bash
git status --porcelain        # working tree must be clean
git branch --show-current
bun --version                 # must be >= 1.4
```

- Dirty tree → **look at what is actually in the diff** (`git diff --stat`, then the `package.json` diff)
  before asking anything. It is often a previous run of this skill, or unrelated work in progress; the two
  need different handling. Show the user what you found, then ask whether to continue. A clean tree means
  rollback is one command (`git checkout -- .`), so no backups are needed.
- Working on top of someone else's uncommitted work is allowed, but from that moment you must be able to
  say which changes are yours — phase 6 failures will otherwise get blamed on the update.
- Read the root `package.json`: which scripts exist (typecheck, tests, lockfile `clean`, dead-code checks),
  whether there are `workspaces`, `catalog`/`catalogs`, `overrides`/`resolutions`. Use the project's own
  script names later — do not assume them.
- Read `bunfig.toml` if present. `[install] minimumReleaseAge` is the project's supply-chain policy and
  `linker = "isolated"` changes what `node_modules` looks like (not what the lockfile says). Both are
  reported by the scan; respect them instead of proposing your own.
- No `workspaces` → the skill works the same, just one package.

## Phase 1. Inventory (read-only)

```bash
bun ~/.claude/skills/deps-update/scripts/deps-scan.ts            # + --json, --no-net, --no-tree, --min-age <days>
bun ~/.claude/skills/deps-update/scripts/decisions.ts list       # what was already deferred, and why
bun outdated                                                     # root package.json
bun outdated --filter='*'                                        # every workspace
bun audit                                                        # vulnerabilities from the lockfile
```

`deps-scan.ts` reads `bun.lock` directly, so "installed" means the resolved tree, not a guess: version
mismatches across workspaces, duplicate copies, a risk class per update, exact pins, package families,
override verdicts computed per consumer (hypotheses only — the override work happens in phase 5, on the
rebuilt tree), deprecated packages, open advisories, and what `bun audit fix` and `bun dedupe` would do.

Run it with `--min-age <days>` (or set `install.minimumReleaseAge` in `bunfig.toml` and it is picked up
automatically) whenever the project has no policy of its own — see **Supply chain** below.

`bun outdated` is the independent cross-check (`Update` = what the current range allows, `Latest` = absolute).
Never paper over disagreements between the script and `bun outdated` — show them.

The two tools measure different things and disagree by design: the scan's range column is what
`package.json` *declares*, `bun outdated`'s `Current` is what is *installed*. A dependency declared
`^4.1.0` with `4.2.0` on disk is already up to date — editing the range there is bookkeeping,
not an update. Say which of the two you mean, every time.

`bun outdated` also takes name patterns, which is how you narrow a large monorepo without reading
90 rows: `bun outdated '@types/*'`, `bun outdated '!eslint*'`.

For anything that looks blocked, find the actual reason instead of guessing:

```bash
bun pm ls --all              # every installed copy — the tree as it really is
bun why <pkg>                # who requires it and with which ranges
bun why '@scope/*' --depth 2 # globs and depth limits both work
bun info <pkg>@<ver> peerDependencies
bun info <pkg> versions      # are there intermediate versions at all
bun info <pkg> time          # when each version was published
```

**A package can be in the tree several times.** `bun why <pkg>` prints each copy as its own block, and
`--top` trims the parent chains — so the first `pkg@version` line is one copy out of N, never "the"
installed version. Read the whole output, or take versions from `bun pm ls --all` (or the scan, which
already counted them). Reasoning from one copy is how an override gets called load-bearing when the old
copy it was supposed to fix is still there.

### Vulnerabilities: let Bun compute the minimum

```bash
bun audit fix --dry-run --json    # the plan: which package, from → to, what it touches
```

This is the only source that computes the **minimum sufficient safe version** for each vulnerable
package while respecting every dependent's declared range. Do not derive it by hand and do not
substitute `latest`. Read the plan before proposing anything:

- `fixes[]` — `from → to` plus `packageJson[]` (empty means lockfile-only, so no `package.json` edit).
- `blocked[]` — a dependent's range blocks the safe version. That is an override question (phase 5),
  not a version bump.
- `unfixable[]` — no safe version exists. Migration or replacement, its own task.
- `downgrade: true` on a fix means the safe version is *lower* than what is installed — say so out loud.
- `newerThanMinimumReleaseAge: true` means the safe version is younger than the project's policy allows.

`bun audit fix --latest` would additionally rewrite declared ranges to accept new majors. Never propose
it as a shortcut: a major is a group B decision with a changelog to read, not an audit side effect.

## Phase 2. Plan by risk group

Sort candidates into four groups and **show them to the user before touching any file**.

### Already-answered questions stay answered

A "not now" is a decision, not a mood. `deps-scan.ts` keeps it in `.claude/deps-update.json` and splits
the deferred set for you:

- **section 3b — do not ask.** The reason for the refusal still holds. These packages are not candidates,
  not questions, and not part of the plan. Mention them as one line ("N deferred, unchanged") and move on.
  Re-asking here is the failure mode this journal exists to prevent.
- **section 3a — ask again, and say what changed.** The blocker released the package, a newer major landed,
  the deferral expired, or the project has moved past the declined version on its own. Lead with the change
  ("`react-dom` no longer pins it to 18.x"), not with the original question.

When the user declines an update — now or after a section 3a discussion — record it, with the condition
that should bring it back:

```bash
bun ~/.claude/skills/deps-update/scripts/decisions.ts defer <pkg> \
  --declined <version> --reason "<why, in the user's words>" \
  [--blocked-by <pkg,pkg>] [--after YYYY-MM-DD] [--major-above N]
```

- `--declined` takes an exact version (`5.2.1`), not a range: its major is what decides whether the *next*
  major counts as a new question.
- `--blocked-by` — the *external* parents that hold it (from `bun why`); the skill re-asks once they stop.
  Name real packages: a made-up blocker resolves to "no longer holds it" on the next run.
- `--after` — for "let's look again next quarter". Without any condition the question never returns
  until someone runs `decisions.ts resume <pkg>`, so always leave at least one way back.
- A declined major implies `--major-above <its major>`: the next major is a different decision and gets asked.
- Deciding to go ahead with something previously deferred → `decisions.ts resume <pkg>` first, so the
  journal does not contradict the tree.
- The journal belongs to the project and is meant to be committed — it is the team's answer, not a cache.
  Do not commit it yourself, though (see Never).

### A. Update right away

- `patch` and `minor` when major ≥ 1, no peer conflicts, not part of a pinned family.
- Mismatch alignment: one library, one version across every `package.json`.
- Old enough to be trusted — see **Supply chain**.

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

For every B item, gather evidence **before** editing:

```bash
bun pm diff <pkg>@<current> <pkg>@<target>          # what actually changed between the two
bun pm diff <pkg>@<current> <pkg>@<target> --json   # same, machine-readable: .notes and .totals
bun pm diff <pkg> --stat                            # installed version → latest, sizes only
```

`bun pm diff` compares the published tarballs, so it reports what the changelog may not: an added
`postinstall`, a new `import` of `fs`/`child_process`/`os`, `engines` moving from `node >=12` to `>=18`,
dependencies added or dropped. Read `notes` first — that is the summary. It normalises formatting and
minification, so a huge `linesAdded` with an empty `notes` is usually a rebuild, not new behaviour.

Then read the changelog for intent: GitHub Releases / `CHANGELOG.md` via WebFetch (get the URL from
`bun info <pkg> --json` → `repository`/`homepage`), or Context7 MCP for documented libraries.

Report per item: what breaks, whether this project's code actually touches it (grep the real call sites),
what `bun pm diff` flagged, and how much work it is. If a major also changes the licence
(`bun pm licenses --json` before and after, or the `notes` line), say so — that is a decision for the user,
not a detail.

### C. Leave alone — blocked by peers

A direct dependency cannot move past what a parent's `peerDependencies` allow: if a framework requires
`^2.4.0` of a library, that library's `3.x` is unreachable until the framework's own major lands.
Show the `bun why` output as evidence and do not try to work around it.

Record these too — `defer <pkg> --declined <latest> --blocked-by <the parent>` — otherwise the same
impossible update is re-litigated on every run. This is not a user decision to wait for: the tree already
made it, so write it down and report it as recorded.

### D. Overrides / resolutions — noted here, decided in phase 5

**Do not touch `overrides` yet, and do not judge them on the current tree.** Whether an override still
earns its place depends on the versions around it, and those are about to change: a bumped parent may now
require the fixed version by itself, and a rebuilt lockfile resolves branches differently. Any verdict
reached before phase 4 describes a tree that will not exist by the time the work is done.

For the plan, list them with their scan verdicts as **hypotheses** and say they are settled at the end.
The scan derives each verdict per consumer from `bun.lock` — the declared range against the copy that
consumer actually resolved to:

- `REDUNDANT_NOW` — consumers already require at least this much. Most likely removable.
- `RAISES_FLOOR` — raises the minimum inside what consumers allow. Looks like a security override.
- `BREAKS_CEILING` — someone got a version above the ceiling they declared. Check the "reach" column:
  below 100% means part of the tree kept its own copy and nothing was forced on it.
- `CAPS_BELOW` — **the override holds the package *below* what a consumer asks for.** When the same package
  is both a direct dependency and an override, this is the update being silently capped. Raise it in the
  plan, not in phase 5: it usually means the two places drifted apart.
- `NOT_APPLIED` — no consumer resolved to a version satisfying the override: the lockfile drifted from
  `package.json` (run `bun install`), or Bun never applied it.
- `NOT_IN_TREE` — the package is not installed at all. Dead rule; it can go without an experiment.

One exception to the "not yet": if `bun audit` in phase 1 reports a vulnerability that a version bump in
group A or B closes on its own, say so — that is an argument about the update, not about the override.

### Supply chain

A version published hours ago has had no time to be caught. Compromised releases of popular packages are
typically yanked within a day, so the age of a release is a real signal, and Bun enforces it for you:

```bash
bun install --minimum-release-age=604800     # one-off: nothing younger than 7 days
```

```toml
# bunfig.toml — the durable version of the same rule
[install]
minimumReleaseAge = 604800
minimumReleaseAgeExcludes = ["@our-scope/internal-lib"]
```

- The scan marks targets younger than the threshold with ⏳. Either wait, or say explicitly why this one
  is taken now (closing a known advisory is a good reason; "it is the latest" is not).
- If the project has no policy at all, propose adding one — once, as a suggestion, not as part of the diff.
- Bun 1.4 narrowed `trustedDependencies`: only npm-registry packages are auto-trusted, so a git or tarball
  dependency that used to run its install scripts silently stops. `bun pm untrusted` lists what is waiting;
  do not "fix" it by trusting everything.
- `bun pm diff` reporting a newly added install script or a new `child_process`/`fs` import in a routine
  patch bump is a stop sign, not a footnote. Show it to the user before updating.

## Phase 3. Edits

- Edit `package.json` files by hand — not `bun update` — so the diff stays predictable and reviewable.
  (`bun update` in 1.4 also moves transitive dependencies and accepts patterns like `'@types/*'`, which
  makes it even less reviewable, not more.)
- One library → the same version string in every workspace. Preserve the range style (`^` stays `^`,
  exact stays exact).
- In a monorepo, a version that keeps drifting between workspaces belongs in a **catalog** — one entry in
  the root, `"catalog:"` everywhere else, and the drift cannot come back:

  ```jsonc
  // root package.json
  { "workspaces": { "packages": ["apps/*"], "catalog": { "react": "^19.2.0" } } }
  // apps/web/package.json
  { "dependencies": { "react": "catalog:" } }
  ```

  Propose it for repeat offenders (the scan lists them in section 1); do not convert a whole monorepo to
  catalogs as a side effect of an update. `bun add --catalog <pkg>` adds new ones the same way.
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
bun dedupe --dry-run                   # duplicates that collapse with no package.json edit
git diff --stat
```

- `postinstall` codegen hooks run on their own. If one fails, the cause is env/schema, not the update —
  do not conflate the two in the report.
- Generated code does not always live in `node_modules` — some generators emit into the project's own
  source tree, where `clean` leaves it untouched and no regeneration is needed. Check where it actually is
  before concluding that a wave of type errors came from the wipe.
- Rebuilding the lock pulls the maximum allowed by each range, so versions can move further than the
  `package.json` edits (the "max in range" column of the scan). That is expected, but list every such move.
- `bun dedupe` re-resolves ranges onto versions **already in the lockfile**, so it can *lower* an installed
  version to collapse two copies into one. Show the `--dry-run` output, get the user's agreement, run it,
  then re-run `bun audit`: a downgrade can reopen a vulnerability the update just closed. Skip it entirely
  if the duplicates are the point (a family mid-migration, for instance).

Keep the post-rebuild `bun audit` and `bun pm ls --all` output — **this** is the baseline for phase 5,
the first tree on which an override question can be answered honestly.

## Phase 5. Overrides / resolutions

Now, and not before: the versions are settled and the lockfile is rebuilt, so the tree finally is the one
the project will ship with. **Decide by experiment, not by reading ranges.** An override's declared range
says what it asks for; only the tree says what it did. Bun does not rewrite every branch — an override can
sit in `package.json` for a year while the old copy it was meant to replace is still installed under some
parent. And after an update, some of them are held up by nothing at all: the parent that needed forcing
now requires the fixed version on its own.

Run the whole set at once — one experiment answers the entire block:

```bash
# 1. strip ALL overrides from the root package.json, then
bun install
bun audit                              # what surfaced is what the overrides were actually holding
bun pm ls --all                        # what changed version, what split into two copies
```

Compare against the phase 4 baseline and read the result per package:

- **Shows up in `bun audit`** → load-bearing. Put it back, but re-derive the range: after the update the
  minimum sufficient version may be lower than what the old override demanded. `bun audit fix --dry-run --json`
  computes exactly that minimum — use its number instead of guessing.
- **Several copies collapsed into one** (two versions in the tree became one) → load-bearing too, even if
  `audit` is quiet: it is de-duplicating the tree. Check whether `bun dedupe` does the same job without an
  override; if it does, that is the better tool, because it changes no declared intent.
- **Nothing changed — same version, same copy count, clean audit** → dead weight. Remove it.
- **A vulnerability that is new since phase 1** → it came from the update, not from the override set. Add a
  fresh override with the minimum sufficient range (`^` of the fixed version), never "a bit higher just in case".

A package present both in `overrides` and in direct dependencies must be **edited in both places at once** —
otherwise the override silently caps the update, or raises the installed version past what `package.json` says.
The scan's `CAPS_BELOW` verdict is exactly this drift, already detected; fix it here.

### Scope the override instead of forcing the whole tree

Only one parent needs the fix? Then only that parent should get it. Bun 1.4 accepts nested overrides,
and the most specific rule wins (parent-with-version > parent > top-level):

```jsonc
{
  "overrides": {
    "picomatch": "^2.3.2",              // everywhere — the blunt instrument
    "micromatch>picomatch": "^2.3.2",   // only under micromatch
    "micromatch@^4>picomatch": "^2.3.2" // only under micromatch 4.x
  }
}
```

Prefer the narrow form when the experiment showed a single culprit: it stops the override from silently
capping or forcing every other branch, and it fails loudly if the culprit disappears. `"parent/child"` and
npm's nested object form mean the same thing; the scan reads all of them.

Then write the final `overrides` block — only the load-bearing ones — and settle the lockfile again:

```bash
bun install
bun audit                              # expect: clean
```

If the set changed, rebuild the lockfile once more (`bun run clean`, same confirmation as phase 4) so the
committed lock is the one resolved from the final `overrides`, not a patched intermediate. Report the
experiment's numbers (`N vulnerabilities without them`, copies before/after), not reasoning about ranges.

## Phase 6. Verification

Run the project's own checks on the final tree — after the overrides are settled, so a failure is not
chased across two different dependency graphs. In order, stopping at the first failure: typecheck first,
then the build/compile check if there is one, then tests.

- **A command that exits 0 without doing anything is not a passing check.** A task runner reporting
  `0 successful, 0 total` / "no tasks were executed" means the script is missing in the workspaces, not that
  the code is fine. Look for the check that really compiles the project (a root `tsc --build`, for instance)
  and say which one you ran.
- Use the project's own test script. If the suite is slow enough to be a problem, `bun test --parallel`
  spreads files across workers and `bun test --changed` runs only what the diff touches — but a dependency
  update can break a file nothing in the diff mentions, so **the final verification run is the full suite**.
  `--changed` is for iterating while fixing, not for signing off.
- Tests may need a live database or other services. Unavailable → say plainly that they did not run;
  never present that as success.
- Failures in files that were already dirty when you started are not yours. Name the file and the error,
  state that it is unrelated to the dependency work, and do not "fix" someone's work in progress.
- On failure: find the culprit (`git diff` + the error) and roll back **only that package**, keeping the rest.
  A breaking major from group B gets reverted whole and reported as "needs its own task".
- `bun pm diff <pkg>@<from> <pkg>@<to>` on the suspect turns "something broke" into a specific removed
  export or changed default — check it before rolling back a whole major.
- A removed override is a suspect like any bumped version: if the failure involves a transitive package that
  the experiment let split or fall back, restore that one override and re-run the check.

## Phase 7. Report

```
## Updated
<package: from → to, workspaces>

## Aligned
<package: N different versions → one; moved to catalog: yes/no>

## Security
<advisories closed, and by what: a version bump / an override / bun audit fix's minimum>
<held back as too fresh: package, version, age>

## Overrides
<removed / added / kept — with the experiment's numbers: vulnerabilities and copies with and without them>
<narrowed to a parent: package — from tree-wide to parent>child>

## Lockfile
<bun.lock rebuilt: yes/no; versions that moved inside their ranges; bun dedupe run: yes/no, what collapsed>

## Untouched
<package — reason: peer block (bun why), 0.x major, exact pin, deprecated>

## Deferred
<recorded this run: package ≠> version, and what will bring the question back>
<still deferred, not re-asked: N packages — one line, no details>

## Checks
<typecheck / build / tests — result of each>

## Needs a decision
<majors with changelog highlights, what bun pm diff flagged, and an effort estimate>
```

## Never

- Turn an exact version into `^`, or "simplify" a pin.
- Bump a `0.x` minor, a major, or a pinned family without explicit consent.
- Run `bun audit fix`, `bun dedupe` or `bun update` without `--dry-run` before the plan is approved —
  they rewrite the lockfile, and `audit fix` rewrites `package.json` too.
- Use `bun audit fix --latest` to sneak a major past the group B conversation.
- Adopt a version published hours ago without a reason better than "it is the latest".
- Ignore a new install script or a new `child_process`/`fs` import that `bun pm diff` reports.
- Judge, edit, or remove an override before the versions are updated and the lockfile is rebuilt — the
  answer belongs to the final tree, not the one you started with.
- Re-ask a question the journal already answered while its condition still holds (section 3b). Equally:
  never let a refusal go unrecorded — an unwritten "not now" comes back as the same question next week.
- Remove an override without running `bun audit` and `bun why` afterwards.
- Keep an override because a verdict said so. Verdicts rank ranges against the current tree; only removing
  it and reinstalling shows what it does.
- Read one `pkg@version` line and call it the installed version — count the copies first.
- Run `bun dedupe` without showing that it can downgrade, and without re-running `bun audit` after.
- Wipe `node_modules` or the lockfile without confirmation.
- Commit or push: committing happens only on a separate, explicit request.
- Report success when tests did not run or failed.

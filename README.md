<h1 align="center">unasked</h1>

<p align="center">
  <strong>Your agent was asked to fix a typo. It touched 14 files.</strong><br>
  <code>unasked</code> tells you which of those changes were out of scope — before you commit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unasked"><img alt="npm" src="https://img.shields.io/npm/v/unasked.svg"></a>
  <a href="https://github.com/furkanyesildag/unasked/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/furkanyesildag/unasked/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="no network at runtime" src="https://img.shields.io/badge/network%20at%20runtime-none-brightgreen">
  <img alt="no model calls" src="https://img.shields.io/badge/model%20calls-0-brightgreen">
</p>

---

You asked for a one-line fix. You got a diff. Somewhere in it is the fix, and
also: a retry layer nobody asked for, `axios` added to `package.json`, a
`// @ts-ignore`, a deleted helper, a skipped test, and a new CI workflow.

You will not read all of it. You will skim it, approve it, and find out in three
weeks.

`unasked` reads the same diff and tells you which parts have nothing to do
with what you asked for.

```
$ unasked

  unasked

  task (from Claude Code session 8754a19e)
  "fix the typo on the login button in src/auth/LoginButton.tsx"

  OUT OF SCOPE src/api/client.ts         +14 -2
               !! TypeScript error suppressed:3 [error-suppression]
                   // @ts-ignore
                ! debug output added:5 [debug-left]
                   console.log('fetching', url);
                ! unimplemented stub added:15 [stub-left]
                   throw new Error('TODO: handle retry exhaustion');
  OUT OF SCOPE .github/workflows/ci.yml  +7 added
                ! CI/deploy config modified [ci-config-changed]
                   added, +7/-0
  OUT OF SCOPE package.json              +4 -3
                ! 1 dependency added: axios [dependency-added]
                   axios
                . version bumped:3 [version-bumped]
                   "version": "1.1.0",
  OUT OF SCOPE src/utils/format.ts       -2
  IN SCOPE     tests/auth.test.ts        +1 -1
               !! test skipped:4 [test-disabled]
                   it.skip('handles failure', () => { expect(2).toBe(2); });
  ... 1 more file in scope and clean (--all to show)

  ────────────────────────────────────────────────────────────────────────────
  6 files +27 -9   2 in scope · 4 out of scope
  2 critical · 4 warnings · 1 note

  review just the surprises: unasked diff --out-of-scope
  put them back:            unasked revert --out-of-scope
```

Nobody typed the task. It was read out of the agent's own session log.

## Install

```bash
npx unasked
```

That is the whole setup. No config file, no API key, no account. It reads your
git diff and your agent's transcript, both of which are already on your disk,
and it never talks to the network once installed.

To keep it around:

```bash
npm install -g unasked
```


## How it decides

There is no model call here. Every verdict is mechanical and comes with the
evidence that produced it, so you can disagree with it in one second instead of
trusting it.

**1. It finds the task.** Explicit `-t "..."` wins. Otherwise it reads the last
human-typed prompt for this repository out of `~/.claude/projects/*.jsonl`.
Otherwise it falls back to the commit message.

**2. It finds the anchors** — the changed files the task actually names.
Backticked paths, file names, `CamelCase` and `snake_case` identifiers, and
distinctive words are matched against the paths in front of it. Filler like
"fix", "update", "the code" is discarded, because it matches everything.

**3. It walks a ladder** for every other changed file, stopping at the first hit:

| Verdict | Reached when |
| --- | --- |
| `IN SCOPE` | the task names this file |
| `ADJACENT` | it is the sibling test of a named file |
| `ADJACENT` | it imports, or is imported by, a named file |
| `ADJACENT` | it sits in the same *specific* module directory (`src/auth/`, not `src/`) |
| `OUT OF SCOPE` | none of the above |

**4. It runs the rules** — mechanical checks that fire regardless of scope,
because a skipped test in a file you *did* ask about is still a skipped test.

If the task names none of the changed files, everything is reported as
`UNSCOPED` rather than `OUT OF SCOPE`, and `revert` refuses to run. The tool
would rather say "I don't know" than guess.

## Rules

`unasked rules` prints this list. Turn any of them off with
`--disable dependency-added,version-bumped`.

### Critical

| Rule | Fires on |
| --- | --- |
| `test-disabled` | `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]` |
| `test-deleted` | a test file removed, or test cases that disappeared from one |
| `assertion-weakened` | assertions removed from a test without replacement |
| `error-suppression` | `@ts-ignore`, `# type: ignore`, `# noqa`, `eslint-disable`, `except: pass`, empty `catch {}` |
| `secret-touched` | `.env`, keys, certificates, or an API-key-shaped literal (reported redacted) |

### Warning

| Rule | Fires on |
| --- | --- |
| `dependency-added` | a package added to or removed from a manifest |
| `ci-config-changed` | workflows, `Dockerfile`, `Makefile`, deploy config |
| `build-config-changed` | `tsconfig`, bundler, linter, formatter config |
| `generated-committed` | `dist/`, `build/`, `node_modules/`, `*.min.js` |
| `large-deletion` | a big net removal from a file the task never named |
| `debug-left` | `console.log`, `print(`, `debugger`, `fmt.Println` in non-test code |
| `stub-left` | `NotImplementedError`, `todo!()`, `throw new Error("TODO")` |
| `license-changed` | the license file was edited |

### Note

| Rule | Fires on |
| --- | --- |
| `mass-reformat` | a file where the changed lines are ≥90% formatting |
| `version-bumped` | a version field changed |
| `lockfile-churn` | a lockfile moved by more than 20 lines |
| `binary-added` | a binary file entered the tree |

## When a rule is wrong

Every rule is a pattern, and patterns hit things they should not — a fixture
that contains `it.skip(` as data, a `console.log` that is the whole point of the
file. Two escape hatches, both standard:

Mark the line:

```ts
console.log(banner); // unasked-ok
```

Or exclude paths in `.unaskedignore`, which reads like `.gitignore`:

```gitignore
# fixtures that contain the patterns the rules look for
tests/fixtures/
*.min.js
!src/keep-this.ts
```

This repository ships one, because its own rule tests are full of the strings
its own rules look for.

To turn a rule off everywhere, `--disable dependency-added,version-bumped`.

## Wire it into Claude Code

```bash
unasked install-hook          # this repo
unasked install-hook --global # everywhere
```

That adds a `Stop` hook. When the agent finishes a turn, `unasked` reviews
what it just did and hands the findings back **to the agent**, which then has to
justify or undo them before you ever see the diff:

```
unasked review of your changes:

4 file(s) you changed are not related to the stated task:
  - src/api/client.ts (+14/-2)
  - .github/workflows/ci.yml (+7/-0)
  - package.json (+4/-3)
  - src/utils/format.ts (+0/-2)
Either explain why each was necessary, or revert it.

Critical findings:
  - src/api/client.ts:3 — TypeScript error suppressed [error-suppression]
  - tests/auth.test.ts:4 — test skipped [test-disabled]
```

By default the hook blocks the turn only on `critical` findings and passes
everything else through as a note. `--fail-on out-of-scope` makes it stricter,
`--fail-on none` makes it advisory.

Works the same as a plain command in Cursor, Codex, Windsurf, or anything else
that can run a shell — the difference is only that the task has to be passed
with `-t` when there is no Claude Code transcript to read.

## In CI

Review an agent-authored pull request against its own description:

```yaml
- run: npx unasked --base ${{ github.base_ref }} -t "${{ github.event.pull_request.title }}" --fail-on critical
```

Exit codes: `0` clean, `1` threshold exceeded, `2` usage or git error.
`--json` gives you the full report if you would rather decide for yourself.

## Commands

```
unasked [check]        review the working tree (default)
unasked diff           show the diff for the flagged files only
unasked revert         restore files the task never asked for
unasked hook           Claude Code hook adapter
unasked install-hook   wire the hook into settings.json
unasked rules          list the rule families

  -t, --task "..."   state the task instead of inferring it
      --staged       only what is staged
      --range A..B   a revision range
      --base main    everything since the merge-base with main
      --why          explain every verdict
      --all          include files that are in scope and clean
      --json         machine-readable report
      --fail-on L    exit 1 on none|out-of-scope|critical|warn
      --disable a,b  turn off rule families
```

`revert` is destructive and refuses to run without `--yes`. It always prints
what it is about to discard first.

## What this does not do

Worth knowing before you install it.

- **It does not know if the code is correct.** A change can be perfectly in
  scope and completely wrong. This tool answers "was this asked for", not "does
  this work". Keep your tests and your reviewer.
- **Scope is inferred from words, not meaning.** A task phrased as "make the
  checkout faster" names no files, so everything comes back `UNSCOPED` and you
  get the rules but no scope verdicts. Naming a file or a symbol in the prompt
  is what makes it useful — which is also just a good habit.
- **The import graph is regex-based.** It resolves relative imports, Python
  dotted modules, and Rust paths well enough to catch the common cases. It does
  not read `tsconfig` path aliases, monorepo workspace links, or dependency
  injection. When it misses an edge, a related file is reported as out of scope;
  `--why` will show you that the reason was `no-relation`, and you can move on.
- **Adjacency is a heuristic, deliberately a generous one.** It would rather
  call a related file `ADJACENT` than accuse it. Expect the occasional
  false negative, and treat a clean report as "nothing obvious", not "nothing".
- **It only reads Claude Code transcripts today.** Other agents work fine, they
  just need `-t`.

## Prior art

[ponytail](https://github.com/DietrichGebert/ponytail) tells the agent to write
less code before it starts. `unasked` checks what it actually wrote after it
stops. They compose; the prompt-level fix and the diff-level check catch
different things.

`git diff --stat` tells you how much changed. `unasked` tells you how much of
it you asked for.

## Contributing

New rule families are the most useful contribution, and the bar is specific:
a rule must be **mechanical** (no judgement call), must **quote its evidence**,
and must ship with a test proving it stays quiet on the honest version of the
same change. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm test
```

## License

MIT

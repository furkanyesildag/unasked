# Contributing

```bash
npm install
npm test        # builds, then runs the suite
npm run typecheck
```

No runtime dependencies. `typescript` and `@types/node` are the only dev
dependencies, and that is deliberate — a tool you run on every agent turn should
not drag a tree behind it. Please do not add one without a good reason.

## Adding a rule

Rules live in [`src/rules.ts`](src/rules.ts). A new one has to clear three bars,
in this order:

**1. It must be mechanical.** If deciding whether it fires requires taste, it is
not a rule. `test-disabled` fires because the literal string `it.skip(` appeared
in an added line. `bad-abstraction` is not a rule and never will be.

**2. It must quote its evidence.** Every flag carries the verbatim source lines
that triggered it, so a reader can overrule the tool in one second. A rule that
says "this looks wrong" without showing what it saw is worse than no rule.

**3. It must have a negative test.** Any pattern can find something. The test
that matters is the one proving the rule *stays quiet* on the honest version of
the same change. Look at how `dependency-added` is tested: it fires on a new
package, and it must not fire when only a version string moved.

A rule that fires on ordinary work is worse than a missing rule, because it
trains people to ignore the output. When in doubt, ship it as `info`.

### Shape

```ts
{
  id: 'my-rule',
  severity: 'warn',
  describe: 'One line, shown by `blastradius rules`.',
  check(file, ctx) {
    // ctx.anchors  — files the task named; usually stay quiet about these
    // ctx.isTestFile(path)
    return hits.map((h) => flag(this, file.path, 'what happened', [h.text], h.line));
  },
}
```

Then add it to the table in the README, and add both tests to
`tests/rules.test.mjs`.

## Adding language support

Two places understand syntax:

- `IMPORT_PATTERNS` in [`src/scope.ts`](src/scope.ts) — how imports are written.
- `TEST_PATH` and the test-case regexes in `src/rules.ts` — how tests are named
  and declared.

Both are regex-based on purpose. A real parser per language would be more
accurate and would also make the tool slow enough that people stop running it on
every turn. If a regex cannot express what you need, say so in the issue and we
will talk about it.

## Reporting a bad verdict

The most useful bug report is a wrong `OUT OF SCOPE`. Include the output of:

```bash
blastradius --why --all -t "the task you gave"
```

The `--why` lines say which rung of the ladder the file fell off, which is
usually enough to find the fix.

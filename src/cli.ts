#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze } from './analyze.js';
import { GitError, checkoutPaths, isTracked, removeUntracked, repoRoot } from './git.js';
import { hookMessage, hookSettingsFragment, readHookInput } from './hook.js';
import { renderReport } from './report.js';
import { ALL_RULES } from './rules.js';
import { resolveTask } from './task.js';
import type { DiffSelector } from './git.js';
import type { Report, Verdict } from './types.js';

const VERSION = '0.1.0';

// `blastradius | head` closes the pipe early; that is a normal way to use a
// CLI, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

interface Args {
  command: string;
  task?: string;
  staged?: boolean;
  range?: string;
  base?: string;
  json?: boolean;
  why?: boolean;
  all?: boolean;
  outOfScope?: boolean;
  failOn?: 'none' | 'out-of-scope' | 'critical' | 'warn';
  disable: Set<string>;
  yes?: boolean;
  global?: boolean;
  help?: boolean;
  version?: boolean;
}

const COMMANDS = new Set(['check', 'diff', 'revert', 'hook', 'install-hook', 'rules']);

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'check', disable: new Set() };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = () => argv[++i] as string | undefined;

    switch (a) {
      case '-t':
      case '--task':
        args.task = next();
        break;
      case '--staged':
        args.staged = true;
        break;
      case '--range':
        args.range = next();
        break;
      case '--base':
        args.base = next();
        break;
      case '--json':
        args.json = true;
        break;
      case '--why':
        args.why = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--out-of-scope':
        args.outOfScope = true;
        break;
      case '--fail-on':
        args.failOn = next() as Args['failOn'];
        break;
      case '--disable':
        for (const r of (next() ?? '').split(',')) if (r.trim()) args.disable.add(r.trim());
        break;
      case '-y':
      case '--yes':
        args.yes = true;
        break;
      case '--global':
        args.global = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      default:
        if (a.startsWith('-')) {
          process.stderr.write(`blastradius: unknown option ${a}\n`);
          process.exit(2);
        }
        rest.push(a);
    }
  }

  const first = rest[0];
  if (first && COMMANDS.has(first)) args.command = first;
  else if (first) {
    process.stderr.write(`blastradius: unknown command "${first}"\n`);
    process.exit(2);
  }
  return args;
}

const HELP = `blastradius ${VERSION}
Your agent was asked to fix a typo. It touched 14 files.
Blast Radius tells you which changes were out of scope.

USAGE
  blastradius [check] [options]     review the working tree (default)
  blastradius diff   [options]      show the diff for the flagged files only
  blastradius revert [options]      restore files the task never asked for
  blastradius hook                  Claude Code hook adapter (reads stdin)
  blastradius install-hook          wire the hook into settings.json
  blastradius rules                 list the rule families

WHAT TO REVIEW
  -t, --task "..."      state the task instead of inferring it
      --staged          only what is staged
      --range A..B      a revision range
      --base main       everything since the merge-base with main

OUTPUT
      --why             explain every verdict
      --all             include files that are in scope and clean
      --json            machine-readable report
      --out-of-scope    with diff/revert: act on out-of-scope files only

BEHAVIOUR
      --fail-on LEVEL   exit 1 on none|out-of-scope|critical|warn
                        (default: none for check, critical for hook)
      --disable a,b     turn off rule families by id
  -y, --yes             do not ask for confirmation
      --global          install-hook: write to ~/.claude/settings.json

The task is read from your agent's own session log when you do not pass one,
so there is nothing to configure. Everything runs locally; no network, no API
key, no model call.
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return void process.stdout.write(HELP);
  if (args.version) return void process.stdout.write(`${VERSION}\n`);

  switch (args.command) {
    case 'hook':
      void runHook(args);
      return;
    case 'install-hook':
      return installHook(args);
    case 'rules':
      return listRules();
    case 'diff':
      return runDiff(args);
    case 'revert':
      return runRevert(args);
    default:
      return runCheck(args);
  }
}

function selectorFrom(args: Args): DiffSelector {
  const sel: DiffSelector = {};
  if (args.staged) sel.staged = true;
  if (args.range) sel.range = args.range;
  if (args.base) sel.base = args.base;
  return sel;
}

function buildReport(args: Args, repo: string): Report {
  const selector = selectorFrom(args);
  const task = resolveTask({
    explicit: args.task,
    repoPath: repo,
    preferCommitMessage: Boolean(selector.range || selector.base),
  });
  return analyze({ repoPath: repo, task, selector, disabledRules: args.disable });
}

function resolveRepo(): string {
  try {
    return repoRoot(process.cwd());
  } catch {
    process.stderr.write('blastradius: not a git repository.\n');
    process.exit(2);
  }
}

function exitCodeFor(report: Report, failOn: Args['failOn']): number {
  switch (failOn) {
    case 'warn':
      return report.totals.critical + report.totals.warn > 0 ? 1 : 0;
    case 'critical':
      return report.totals.critical > 0 ? 1 : 0;
    case 'out-of-scope':
      return report.totals.outOfScope > 0 || report.totals.critical > 0 ? 1 : 0;
    default:
      return 0;
  }
}

function runCheck(args: Args): void {
  const repo = resolveRepo();
  const report = buildReport(args, repo);

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(renderReport(report, { why: args.why, all: args.all }) + '\n');

  process.exit(exitCodeFor(report, args.failOn ?? 'none'));
}

function targetVerdicts(args: Args): Set<Verdict> {
  return args.outOfScope
    ? new Set<Verdict>(['out-of-scope'])
    : new Set<Verdict>(['out-of-scope', 'unscoped']);
}

function runDiff(args: Args): void {
  const repo = resolveRepo();
  const report = buildReport(args, repo);
  const want = targetVerdicts(args);
  const paths = report.files
    .filter((f) => want.has(f.verdict) || f.flags.some((x) => x.severity === 'critical'))
    .map((f) => f.file.path);

  if (paths.length === 0) {
    process.stdout.write('blastradius: nothing flagged.\n');
    return;
  }

  const sel = selectorFrom(args);
  const gitArgs = ['diff'];
  if (sel.range) gitArgs.push(sel.range);
  else if (sel.staged) gitArgs.push('--cached');
  gitArgs.push('--', ...paths);

  try {
    process.stdout.write(
      execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }),
    );
  } catch (err) {
    process.stdout.write(String((err as { stdout?: string }).stdout ?? ''));
  }
}

function runRevert(args: Args): void {
  const repo = resolveRepo();
  if (args.range || args.base) {
    process.stderr.write('blastradius: revert only operates on the working tree.\n');
    process.exit(2);
  }

  const report = buildReport(args, repo);

  // With no anchors every file is `unscoped`, so a blanket revert would throw
  // away the work the agent was actually asked to do. Refuse instead.
  if (report.anchors.length === 0) {
    process.stderr.write(
      'blastradius: the task does not name any of the changed files, so every change\n' +
        'looks unscoped and reverting would discard the real work too.\n' +
        'State the task explicitly first:  blastradius revert -t "..." --out-of-scope\n',
    );
    process.exit(2);
  }

  const want = targetVerdicts(args);
  const targets = report.files.filter((f) => want.has(f.verdict));

  if (targets.length === 0) {
    process.stdout.write('blastradius: nothing to revert.\n');
    return;
  }

  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const t of targets) {
    if (t.file.kind === 'added' && !isTracked(repo, t.file.path)) untracked.push(t.file.path);
    else tracked.push(t.file.path);
  }

  process.stdout.write('\nThe following changes will be discarded:\n\n');
  for (const t of targets) {
    const mark = untracked.includes(t.file.path) ? 'delete  ' : 'restore ';
    process.stdout.write(`  ${mark} ${t.file.path}  (+${t.file.additions}/-${t.file.deletions})\n`);
  }
  process.stdout.write('\n');

  if (!args.yes) {
    process.stderr.write('This is destructive. Re-run with --yes to proceed.\n');
    process.exit(1);
  }

  checkoutPaths(repo, tracked);
  removeUntracked(repo, untracked);
  process.stdout.write(`Reverted ${targets.length} file(s).\n`);
}

async function runHook(args: Args): Promise<void> {
  const input = await readHookInput(process.stdin);
  const cwd = input.cwd ?? process.cwd();

  let repo: string;
  try {
    repo = repoRoot(cwd);
  } catch {
    // Not a repo: a hook must never break the agent's turn.
    process.exit(0);
  }

  let report: Report;
  try {
    const task = resolveTask({ explicit: args.task ?? input.prompt, repoPath: repo });
    report = analyze({ repoPath: repo, task, disabledRules: args.disable });
  } catch (err) {
    if (err instanceof GitError) process.exit(0);
    throw err;
  }

  const message = hookMessage(report);
  if (!message) process.exit(0);

  const failOn = args.failOn ?? 'critical';
  const shouldBlock = exitCodeFor(report, failOn) === 1;

  process.stdout.write(
    JSON.stringify(
      shouldBlock
        ? { decision: 'block', reason: message }
        : { systemMessage: message, continue: true },
    ) + '\n',
  );
  process.exit(0);
}

function installHook(args: Args): void {
  const settingsPath = args.global
    ? join(homedir(), '.claude', 'settings.json')
    : join(resolveRepo(), '.claude', 'settings.json');

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      process.stderr.write(`blastradius: ${settingsPath} is not valid JSON; leaving it alone.\n`);
      process.exit(1);
    }
  }

  const fragment = hookSettingsFragment().hooks as Record<string, unknown[]>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];

  const already = JSON.stringify(stop).includes('blastradius hook');
  if (already) {
    process.stdout.write(`blastradius: hook already installed in ${settingsPath}\n`);
    return;
  }

  hooks.Stop = [...stop, ...(fragment.Stop as unknown[])];
  settings.hooks = hooks;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  process.stdout.write(`blastradius: installed Stop hook in ${settingsPath}\n`);
}

function listRules(): void {
  const width = Math.max(...ALL_RULES.map((r) => r.id.length));
  for (const sev of ['critical', 'warn', 'info'] as const) {
    process.stdout.write(`\n${sev.toUpperCase()}\n`);
    for (const r of ALL_RULES.filter((x) => x.severity === sev)) {
      process.stdout.write(`  ${r.id.padEnd(width)}  ${r.describe}\n`);
    }
  }
  process.stdout.write('\n');
}

try {
  main();
} catch (err) {
  if (err instanceof GitError) {
    process.stderr.write(`blastradius: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

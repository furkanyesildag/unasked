import { execFileSync } from 'node:child_process';
import type { FileChange } from './types.js';
import { parseUnifiedDiff } from './diff.js';

export class GitError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError((e.stderr || e.message || 'git failed').trim());
  }
}

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

export function currentBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
}

export function hasCommits(cwd: string): boolean {
  try {
    git(['rev-parse', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

export interface DiffSelector {
  /** Compare against the index only. */
  staged?: boolean;
  /** An explicit revision range, e.g. `main..HEAD`. */
  range?: string;
  /** Diff against the merge-base with this ref. */
  base?: string;
}

/**
 * Collect the changed files for a selector.
 *
 * The default (no selector) is the full working tree against HEAD, including
 * untracked files — that is what an agent has just done to you, which is the
 * state we care about most.
 */
export function collectChanges(cwd: string, sel: DiffSelector = {}): FileChange[] {
  const common = ['--no-color', '--no-ext-diff', '-M', '--unified=0'];
  let args: string[];

  if (sel.range) {
    args = ['diff', ...common, sel.range];
  } else if (sel.base) {
    const mergeBase = git(['merge-base', sel.base, 'HEAD'], cwd).trim();
    args = ['diff', ...common, `${mergeBase}..HEAD`];
  } else if (sel.staged) {
    args = ['diff', ...common, '--cached'];
  } else {
    // Before the first commit there is no HEAD to diff against, and everything
    // `git add`ed would otherwise be invisible.
    args = hasCommits(cwd) ? ['diff', ...common, 'HEAD'] : ['diff', ...common, '--cached'];
  }

  const changes = parseUnifiedDiff(git(args, cwd));

  // Untracked files are invisible to `git diff`, but an agent creating a file
  // it was never asked to create is exactly the signal we exist to report.
  if (!sel.range && !sel.base && !sel.staged) {
    for (const path of listUntracked(cwd)) {
      if (changes.some((c) => c.path === path)) continue;
      changes.push(untrackedAsChange(cwd, path));
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function listUntracked(cwd: string): string[] {
  return git(['ls-files', '--others', '--exclude-standard'], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function untrackedAsChange(cwd: string, path: string): FileChange {
  // `--no-index` exits 1 on difference, which execFileSync reports as failure;
  // recover the diff from stderr-free stdout instead of treating it as an error.
  let raw = '';
  try {
    raw = git(['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-index', '/dev/null', path], cwd);
  } catch (err) {
    raw = String((err as { stdout?: string }).stdout ?? '');
    if (!raw) {
      const parsed = tryDiffNoIndex(cwd, path);
      raw = parsed;
    }
  }
  const parsed = parseUnifiedDiff(raw);
  const first = parsed[0];
  if (first) return { ...first, path, kind: 'added' };
  return { path, kind: 'added', binary: true, additions: 0, deletions: 0, hunks: [] };
}

function tryDiffNoIndex(cwd: string, path: string): string {
  try {
    return execFileSync(
      'git',
      ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-index', '/dev/null', path],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '');
  }
}

/** Read a file as it exists in the post-image of the selected diff. */
export function readPostImage(cwd: string, path: string, sel: DiffSelector = {}): string | null {
  try {
    if (sel.range) {
      const rev = sel.range.split('..').pop() || 'HEAD';
      return git(['show', `${rev}:${path}`], cwd);
    }
    if (sel.staged) return git(['show', `:${path}`], cwd);
    return git(['show', `HEAD:${path}`], cwd);
  } catch {
    return null;
  }
}

export function checkoutPaths(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(['checkout', '--', ...paths], cwd);
}

export function removeUntracked(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(['clean', '-f', '--', ...paths], cwd);
}

export function isTracked(cwd: string, path: string): boolean {
  try {
    return git(['ls-files', '--error-unmatch', path], cwd).trim().length > 0;
  } catch {
    return false;
  }
}

export function lastCommitMessage(cwd: string): string | null {
  try {
    return git(['log', '-1', '--pretty=%B'], cwd).trim() || null;
  } catch {
    return null;
  }
}

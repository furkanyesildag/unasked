import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A throwaway git repository seeded with `files`, all committed. */
export function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'unasked-test-'));
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial');
  return dir;
}

export function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Collect the flags a report raised for one rule id. */
export function flagsFor(report, rule) {
  return report.files.flatMap((f) => f.flags).filter((f) => f.rule === rule);
}

export function verdictOf(report, path) {
  return report.files.find((f) => f.file.path === path)?.verdict;
}

/**
 * Run `fn` with the home directory pointed somewhere disposable.
 *
 * `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so both have
 * to move or the test silently reads the real transcript directory.
 */
export function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

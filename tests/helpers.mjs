import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A throwaway git repository seeded with `files`, all committed. */
export function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'blastradius-test-'));
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

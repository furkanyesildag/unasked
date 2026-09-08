import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../dist/analyze.js';
import { cleanup, makeRepo, verdictOf, write } from './helpers.mjs';

/**
 * Build a fake Claude Code transcript directory for `repoPath` and point HOME
 * at it, so the inference path can be exercised without touching the real one.
 */
function withTranscript(repoPath, entries, fn) {
  const home = mkdtempSync(join(tmpdir(), 'blastradius-home-'));
  const slug = repoPath.replace(/\//g, '-');
  const dir = join(home, '.claude', 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session-abc.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const userTurn = (cwd, text) => ({
  type: 'user',
  isSidechain: false,
  cwd,
  sessionId: 'abc',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('the task is recovered from the agent transcript with no configuration', async () => {
  const dir = makeRepo({ 'src/login.ts': 'a\n', 'src/billing.ts': 'a\n' });
  write(dir, { 'src/login.ts': 'b\n', 'src/billing.ts': 'b\n' });

  const { resolveTask } = await import('../dist/task.js');
  const report = withTranscript(dir, [userTurn(dir, 'fix the label in src/login.ts')], () => {
    const task = resolveTask({ repoPath: dir });
    return analyze({ repoPath: dir, task });
  });
  cleanup(dir);

  assert.equal(report.task.source, 'claude-code');
  assert.match(report.task.text, /src\/login\.ts/);
  assert.equal(verdictOf(report, 'src/billing.ts'), 'out-of-scope');
});

test('tool results are never mistaken for a human task', async () => {
  const dir = makeRepo({ 'a.ts': 'a\n' });
  const { resolveTask } = await import('../dist/task.js');

  const task = withTranscript(
    dir,
    [
      userTurn(dir, 'rename the widget in a.ts'),
      {
        type: 'user',
        isSidechain: false,
        cwd: dir,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      },
    ],
    () => resolveTask({ repoPath: dir }),
  );
  cleanup(dir);

  assert.match(task.text, /rename the widget/);
});

test('a transcript from another repository is ignored', async () => {
  const dir = makeRepo({ 'a.ts': 'a\n' });
  const { resolveTask } = await import('../dist/task.js');

  const task = withTranscript(dir, [userTurn('/somewhere/else', 'do a thing over there')], () =>
    resolveTask({ repoPath: dir }),
  );
  cleanup(dir);

  assert.notEqual(task.source, 'claude-code');
});

test('an explicit task always wins over inference', async () => {
  const dir = makeRepo({ 'a.ts': 'a\n' });
  const { resolveTask } = await import('../dist/task.js');

  const task = withTranscript(dir, [userTurn(dir, 'inferred task')], () =>
    resolveTask({ repoPath: dir, explicit: 'my explicit task' }),
  );
  cleanup(dir);

  assert.equal(task.source, 'explicit');
  assert.equal(task.text, 'my explicit task');
});

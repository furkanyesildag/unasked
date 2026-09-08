import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/analyze.js';
import { cleanup, git, makeRepo, flagsFor, write } from './helpers.mjs';

/** Run the analyzer over a repo after applying `after` to `before`. */
function scan(before, after, task = '') {
  const dir = makeRepo(before);
  write(dir, after);
  try {
    return analyze({ repoPath: dir, task: { text: task, source: 'explicit' } });
  } finally {
    cleanup(dir);
  }
}

test('test-disabled fires on .skip, .only, and pytest markers', () => {
  const r = scan(
    {
      'a.test.ts': "it('works', () => {});\n",
      'b.test.ts': "it('works', () => {});\n",
      'test_c.py': 'def test_works():\n    assert True\n',
    },
    {
      'a.test.ts': "it.skip('works', () => {});\n",
      'b.test.ts': "it.only('works', () => {});\n",
      'test_c.py': '@pytest.mark.skip\ndef test_works():\n    assert True\n',
    },
  );
  const hits = flagsFor(r, 'test-disabled');
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.severity === 'critical'));
  assert.ok(hits[0].evidence[0].includes('it.skip'), 'evidence must quote the line');
});

test('test-disabled stays quiet on ordinary test edits', () => {
  const r = scan(
    { 'a.test.ts': "it('works', () => { expect(1).toBe(1); });\n" },
    { 'a.test.ts': "it('works', () => { expect(1).toBe(2); });\n" },
  );
  assert.equal(flagsFor(r, 'test-disabled').length, 0);
});

test('test-deleted counts removed cases and outright deletions', () => {
  const dir = makeRepo({
    'x.test.ts': "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\n",
    'y.test.ts': "it('only', () => {});\n",
  });
  write(dir, { 'x.test.ts': "it('a', () => {});\n" });
  git(dir, 'rm', '-q', 'y.test.ts');
  const r = analyze({ repoPath: dir, task: { text: '', source: 'explicit' } });
  cleanup(dir);

  const hits = flagsFor(r, 'test-deleted');
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.message.includes('2 test cases removed')));
  assert.ok(hits.some((h) => h.message.includes('deleted outright')));
});

test('assertion-weakened needs a net loss of at least two assertions', () => {
  const one = scan(
    { 'a.test.ts': 'expect(1).toBe(1);\nexpect(2).toBe(2);\n' },
    { 'a.test.ts': 'expect(1).toBe(1);\n' },
  );
  assert.equal(flagsFor(one, 'assertion-weakened').length, 0, 'one removal is noise');

  const three = scan(
    { 'a.test.ts': 'expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\n' },
    { 'a.test.ts': 'expect(1).toBe(1);\n' },
  );
  assert.equal(flagsFor(three, 'assertion-weakened').length, 1);
});

test('error-suppression catches the common silencers', () => {
  const r = scan(
    { 'a.ts': 'const x = 1;\n', 'b.py': 'x = 1\n', 'c.py': 'pass\n' },
    {
      'a.ts': '// @ts-ignore\nconst x = 1;\n',
      'b.py': 'x = 1  # type: ignore\n',
      'c.py': 'try:\n    go()\nexcept Exception:\n    pass\n',
    },
  );
  const hits = flagsFor(r, 'error-suppression');
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.severity === 'critical'));
});

test('secret-touched redacts the literal it reports', () => {
  const r = scan({ 'cfg.ts': 'export const a = 1;\n' }, {
    'cfg.ts': "export const key = 'sk-abcdefghijklmnopqrstuvwxyz0123';\n",
  });
  const [hit] = flagsFor(r, 'secret-touched');
  assert.ok(hit, 'expected a secret flag');
  assert.ok(!hit.evidence[0].includes('mnopqrstuvwxyz'), 'the key must not be echoed in full');
});

test('dependency-added names the packages, and ignores version-only edits', () => {
  const added = scan(
    { 'package.json': '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n' },
    { 'package.json': '{\n  "dependencies": {\n    "react": "^18.0.0",\n    "axios": "^1.7.0"\n  }\n}\n' },
  );
  const [hit] = flagsFor(added, 'dependency-added');
  assert.ok(hit.message.includes('axios'));

  const bumped = scan(
    { 'package.json': '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n' },
    { 'package.json': '{\n  "dependencies": {\n    "react": "^18.3.0"\n  }\n}\n' },
  );
  assert.equal(flagsFor(bumped, 'dependency-added').length, 0, 'a version change is not a new dep');
});

test('debug-left ignores test files and honours the opt-out comment', () => {
  const r = scan(
    { 'a.ts': 'run();\n', 'a.test.ts': 'run();\n', 'b.ts': 'run();\n' },
    {
      'a.ts': "console.log('here');\nrun();\n",
      'a.test.ts': "console.log('here');\nrun();\n",
      'b.ts': "console.log('kept'); // blastradius-ok\nrun();\n",
    },
  );
  const hits = flagsFor(r, 'debug-left');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'a.ts');
});

test('mass-reformat recognises churn that changes nothing', () => {
  const before = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const after = Array.from({ length: 20 }, (_, i) => `const v${i}   =   ${i}`).join('\n') + '\n';
  const r = scan({ 'a.ts': before }, { 'a.ts': after });
  assert.equal(flagsFor(r, 'mass-reformat').length, 1);
});

test('large-deletion stays quiet on files the task named', () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const noisy = scan({ 'src/format.ts': before }, { 'src/format.ts': 'line 0\n' });
  assert.equal(flagsFor(noisy, 'large-deletion').length, 1);

  const asked = scan(
    { 'src/format.ts': before },
    { 'src/format.ts': 'line 0\n' },
    'trim src/format.ts down to one line',
  );
  assert.equal(flagsFor(asked, 'large-deletion').length, 0);
});

test('a clean, in-scope change raises nothing at all', () => {
  const r = scan(
    { 'src/login.ts': 'export const label = "Sign in";\n' },
    { 'src/login.ts': 'export const label = "Sign In";\n' },
    'fix the capitalisation in src/login.ts',
  );
  assert.equal(r.totals.critical, 0);
  assert.equal(r.totals.warn, 0);
  assert.equal(r.totals.outOfScope, 0);
});

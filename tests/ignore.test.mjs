import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../dist/analyze.js';
import { IgnoreList } from '../dist/ignore.js';
import { cleanup, makeRepo, flagsFor, write } from './helpers.mjs';

test('glob patterns match the way gitignore does', () => {
  const list = new IgnoreList(['*.min.js', 'fixtures/', 'src/**/generated.ts', '# a comment', '']);
  assert.equal(list.ignores('app.min.js'), true);
  assert.equal(list.ignores('deep/nested/app.min.js'), true);
  assert.equal(list.ignores('app.js'), false);
  assert.equal(list.ignores('fixtures/a.ts'), true);
  assert.equal(list.ignores('tests/fixtures/a.ts'), true);
  assert.equal(list.ignores('src/a/b/generated.ts'), true);
  assert.equal(list.ignores('src/generated.ts'), true);
  assert.equal(list.ignores('src/real.ts'), false);
});

test('a later negation rescues an earlier match', () => {
  const list = new IgnoreList(['docs/*', '!docs/keep.md']);
  assert.equal(list.ignores('docs/drop.md'), true);
  assert.equal(list.ignores('docs/keep.md'), false);
});

test('an empty list ignores nothing but the ignore file itself', () => {
  const list = new IgnoreList([]);
  assert.equal(list.empty, true);
  assert.equal(list.ignores('anything.ts'), false);
  assert.equal(list.ignores('.blastradiusignore'), true);
});

test('.blastradiusignore removes a file from the review entirely', () => {
  const dir = makeRepo({ 'src/a.ts': 'a\n', 'fixtures/b.ts': 'a\n' });
  writeFileSync(join(dir, '.blastradiusignore'), 'fixtures/\n');
  write(dir, { 'src/a.ts': "console.log('x');\n", 'fixtures/b.ts': "console.log('x');\n" });

  const r = analyze({ repoPath: dir, task: { text: 'update src/a.ts', source: 'explicit' } });
  cleanup(dir);

  assert.equal(flagsFor(r, 'debug-left').length, 1);
  assert.ok(!r.files.some((f) => f.file.path.startsWith('fixtures/')));
});

test('the inline marker suppresses any rule, not just one', () => {
  const dir = makeRepo({ 'a.ts': 'x\n', 'b.test.ts': 'x\n' });
  write(dir, {
    'a.ts': "console.log('kept'); // blastradius-ok\n",
    'b.test.ts': "it.skip('known flake'); // blastradius-ok\n",
  });

  const r = analyze({ repoPath: dir, task: { text: '', source: 'explicit' } });
  cleanup(dir);

  assert.equal(flagsFor(r, 'debug-left').length, 0);
  assert.equal(flagsFor(r, 'test-disabled').length, 0);
});

test('the marker suppresses only the line it is on', () => {
  const dir = makeRepo({ 'a.ts': 'x\n' });
  write(dir, { 'a.ts': "console.log('kept'); // blastradius-ok\nconsole.log('flagged');\n" });

  const r = analyze({ repoPath: dir, task: { text: '', source: 'explicit' } });
  cleanup(dir);

  const hits = flagsFor(r, 'debug-left');
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence[0], /flagged/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../dist/diff.js';

test('parses a simple modification', () => {
  const raw = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,1 +3,2 @@',
    '-const x = 1;',
    '+const x = 2;',
    '+const y = 3;',
  ].join('\n');

  const [file] = parseUnifiedDiff(raw);
  assert.equal(file.path, 'src/a.ts');
  assert.equal(file.kind, 'modified');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks[0].newStart, 3);
  assert.deepEqual(file.hunks[0].added, ['const x = 2;', 'const y = 3;']);
});

test('a hunk header without a count means one line', () => {
  const raw = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw);
  assert.equal(file.hunks[0].oldLines, 1);
  assert.equal(file.hunks[0].newLines, 1);
});

test('detects additions and deletions of whole files', () => {
  const raw = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,1 @@',
    '+hello',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-bye',
  ].join('\n');

  const files = parseUnifiedDiff(raw);
  assert.equal(files.length, 2);
  assert.equal(files[0].kind, 'added');
  assert.equal(files[0].path, 'new.ts');
  assert.equal(files[1].kind, 'deleted');
  assert.equal(files[1].path, 'gone.ts');
});

test('follows renames to the new path', () => {
  const raw = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 95%',
    'rename from old/name.ts',
    'rename to new/name.ts',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw);
  assert.equal(file.kind, 'renamed');
  assert.equal(file.path, 'new/name.ts');
  assert.equal(file.oldPath, 'old/name.ts');
});

test('marks binary files without inventing line counts', () => {
  const raw = [
    'diff --git a/logo.png b/logo.png',
    'index 111..222 100644',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw);
  assert.equal(file.binary, true);
  assert.equal(file.additions, 0);
});

test('handles paths containing spaces', () => {
  const raw = [
    'diff --git a/my dir/my file.ts b/my dir/my file.ts',
    '--- a/my dir/my file.ts',
    '+++ b/my dir/my file.ts',
    '@@ -1,0 +1,1 @@',
    '+x',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw);
  assert.equal(file.path, 'my dir/my file.ts');
});

test('unquotes git C-style paths', () => {
  const raw = [
    'diff --git "a/s\\303\\274per.ts" "b/s\\303\\274per.ts"',
    '--- "a/s\\303\\274per.ts"',
    '+++ "b/s\\303\\274per.ts"',
    '@@ -1,0 +1,1 @@',
    '+x',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw);
  assert.ok(file.path.endsWith('per.ts'), `unexpected path: ${file.path}`);
  assert.ok(!file.path.includes('\\'), 'escape sequences should be decoded');
});

test('returns nothing for empty input', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

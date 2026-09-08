import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/analyze.js';
import { extractTerms, fileStem } from '../dist/anchors.js';
import { cleanup, makeRepo, verdictOf, write } from './helpers.mjs';

function scan(before, after, task) {
  const dir = makeRepo(before);
  write(dir, after);
  try {
    return analyze({ repoPath: dir, task: { text: task, source: 'explicit' } });
  } finally {
    cleanup(dir);
  }
}

test('fileStem strips extensions and test decoration', () => {
  assert.equal(fileStem('src/auth/login.ts'), 'login');
  assert.equal(fileStem('src/auth/login.test.ts'), 'login');
  assert.equal(fileStem('tests/test_login.py'), 'login');
  assert.equal(fileStem('pkg/login_test.go'), 'login');
  assert.equal(fileStem('a/b/Button.spec.tsx'), 'Button');
});

test('extractTerms separates paths, symbols, and plain words', () => {
  const t = extractTerms('fix the typo in `src/auth/LoginButton.tsx` so signIn works');
  assert.ok(t.paths.includes('src/auth/LoginButton.tsx'));
  assert.ok(t.symbols.includes('LoginButton'));
  assert.ok(t.symbols.includes('signIn'));
});

test('extractTerms drops filler words that would match everything', () => {
  const t = extractTerms('please update the code and fix the tests in this project');
  assert.deepEqual(t.words, []);
});

test('extractTerms does not mistake a version number for a path', () => {
  const t = extractTerms('bump to 1.2.3');
  assert.deepEqual(t.paths, []);
});

test('a file the task names is in scope; an unrelated one is not', () => {
  const r = scan(
    { 'src/login.ts': 'a\n', 'src/billing.ts': 'a\n' },
    { 'src/login.ts': 'b\n', 'src/billing.ts': 'b\n' },
    'fix src/login.ts',
  );
  assert.equal(verdictOf(r, 'src/login.ts'), 'in-scope');
  assert.equal(verdictOf(r, 'src/billing.ts'), 'out-of-scope');
});

test('the sibling test of a named file counts as adjacent, not a surprise', () => {
  const r = scan(
    { 'src/login.ts': 'a\n', 'src/__tests__/login.test.ts': 'a\n' },
    { 'src/login.ts': 'b\n', 'src/__tests__/login.test.ts': 'b\n' },
    'change the behaviour of `login.ts`',
  );
  assert.notEqual(verdictOf(r, 'src/__tests__/login.test.ts'), 'out-of-scope');
});

test('a file that imports a named file is adjacent', () => {
  const r = scan(
    {
      'src/login.ts': 'export const a = 1;\n',
      'src/page.ts': "import { a } from './login';\nconst b = a;\n",
      'src/unrelated.ts': 'const c = 1;\n',
    },
    {
      'src/login.ts': 'export const a = 2;\n',
      'src/page.ts': "import { a } from './login';\nconst b = a + 1;\n",
      'src/unrelated.ts': 'const c = 2;\n',
    },
    'update the export in src/login.ts',
  );
  assert.equal(verdictOf(r, 'src/page.ts'), 'adjacent');
  assert.equal(verdictOf(r, 'src/unrelated.ts'), 'out-of-scope');
});

test('a Python module importing a named module is adjacent', () => {
  const r = scan(
    {
      'app/auth.py': 'X = 1\n',
      'app/views.py': 'from app.auth import X\n',
      'app/other.py': 'Y = 1\n',
    },
    {
      'app/auth.py': 'X = 2\n',
      'app/views.py': 'from app.auth import X\nZ = X\n',
      'app/other.py': 'Y = 2\n',
    },
    'change X in app/auth.py',
  );
  assert.equal(verdictOf(r, 'app/views.py'), 'adjacent');
  assert.equal(verdictOf(r, 'app/other.py'), 'out-of-scope');
});

test('with no recognisable anchors everything is unscoped, never out-of-scope', () => {
  const r = scan({ 'a.ts': 'a\n', 'b.ts': 'a\n' }, { 'a.ts': 'b\n', 'b.ts': 'b\n' }, 'make it better');
  assert.equal(r.anchors.length, 0);
  assert.equal(r.totals.outOfScope, 0);
  assert.equal(r.totals.unscoped, 2);
});

test('untracked files are reviewed, not ignored', () => {
  const r = scan({ 'src/login.ts': 'a\n' }, { 'src/login.ts': 'b\n', 'scratch.ts': 'new\n' }, 'fix src/login.ts');
  assert.equal(verdictOf(r, 'scratch.ts'), 'out-of-scope');
});

test('totals add up to the number of files reviewed', () => {
  const r = scan(
    { 'src/login.ts': 'a\n', 'src/billing.ts': 'a\n', 'src/tax.ts': 'a\n' },
    { 'src/login.ts': 'b\n', 'src/billing.ts': 'b\n', 'src/tax.ts': 'b\n' },
    'fix src/login.ts',
  );
  const { inScope, adjacent, outOfScope, unscoped, files } = r.totals;
  assert.equal(inScope + adjacent + outOfScope + unscoped, files);
});

test('sharing a broad directory like src/ is not evidence of relatedness', () => {
  const r = scan(
    { 'src/login.ts': 'a\n', 'src/billing.ts': 'a\n' },
    { 'src/login.ts': 'b\n', 'src/billing.ts': 'b\n' },
    'fix src/login.ts',
  );
  assert.equal(verdictOf(r, 'src/billing.ts'), 'out-of-scope');
});

test('sharing a specific module directory is evidence of relatedness', () => {
  const r = scan(
    { 'src/auth/login.ts': 'a\n', 'src/auth/session.ts': 'a\n' },
    { 'src/auth/login.ts': 'b\n', 'src/auth/session.ts': 'b\n' },
    'fix src/auth/login.ts',
  );
  assert.equal(verdictOf(r, 'src/auth/session.ts'), 'adjacent');
});

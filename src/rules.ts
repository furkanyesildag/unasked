import { basename } from 'node:path';
import type { FileChange, Flag, Severity } from './types.js';
import { addedLines, removedLines } from './diff.js';
import { isSuppressed } from './ignore.js';

/**
 * Deterministic rule families.
 *
 * Every rule here answers "did the agent do a thing it is famous for doing
 * without being asked". They are intentionally mechanical: no model, no
 * heuristic confidence, no guessing. If a rule fires, the evidence is a
 * verbatim line from the diff and you can judge it yourself in one second.
 */

export interface Rule {
  id: string;
  severity: Severity;
  describe: string;
  check(file: FileChange, ctx: RuleContext): Flag[];
}

export interface RuleContext {
  /** Files the task actually named, so rules can stay quiet about them. */
  anchors: Set<string>;
  isTestFile(path: string): boolean;
}

const flag = (
  rule: Rule,
  path: string,
  message: string,
  evidence: string[],
  line?: number,
): Flag => ({
  rule: rule.id,
  severity: rule.severity,
  path,
  message,
  evidence: evidence.slice(0, 4).map((e) => e.trim().slice(0, 160)),
  ...(line !== undefined ? { line } : {}),
});

const MANIFESTS =
  /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json|pubspec\.yaml|build\.gradle(\.kts)?|pom\.xml)$/;

const LOCKFILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;

const CI_CONFIG =
  /(^\.github\/(workflows|actions)\/|(^|\/)(Dockerfile|docker-compose[\w.-]*\.ya?ml|Makefile|Jenkinsfile|\.gitlab-ci\.yml|\.circleci\/config\.yml|\.travis\.yml|netlify\.toml|vercel\.json|fly\.toml)$)/;

const BUILD_CONFIG =
  /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|rollup\.config\.[jt]s|esbuild\.config\.[jt]s|babel\.config\.[jt]s|\.babelrc|next\.config\.[jmt]s|nuxt\.config\.[jt]s|svelte\.config\.js|tailwind\.config\.[jt]s|jest\.config\.[jt]s|vitest\.config\.[jt]s|setup\.py|setup\.cfg|tox\.ini|\.eslintrc[\w.]*|eslint\.config\.[jmt]s|\.prettierrc[\w.]*|ruff\.toml|\.flake8)$/;

const SECRETS = /(^|\/)(\.env[\w.-]*|\.npmrc|\.netrc|credentials|id_[rd]sa|.*\.pem|.*\.key|.*\.pfx|.*\.p12)$/i;

const GENERATED =
  /(^|\/)(dist|build|out|\.next|\.nuxt|target|node_modules|vendor|__pycache__|coverage)\/|\.min\.(js|css)$|\.generated\.[\w]+$/;

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|specs|e2e|integration)\/|[._-](test|spec)\.[\w]+$|(^|\/)test_[\w-]+\.py$|_test\.(go|py|rb)$|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path);
}

const DEP_LINE =
  /^\s*["']?([\w@][\w@/.-]*)["']?\s*[:=]\s*["'][~^>=<]*[\d*][\w.\-+*]*["']\s*,?\s*$|^\s*([\w.-]+)\s*(==|>=|~=|<=)\s*[\d]/;

function depNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const l of lines) {
    const m = DEP_LINE.exec(l);
    if (m) names.push((m[1] ?? m[2] ?? '').trim());
    else if (/^\s+[\w.\/-]+\s+v?\d+\.\d+/.test(l)) {
      const t = l.trim().split(/\s+/)[0];
      if (t) names.push(t);
    }
  }
  return names.filter(Boolean);
}

const rules: Rule[] = [
  {
    id: 'test-disabled',
    severity: 'critical',
    describe: 'A test was skipped, focused, or otherwise switched off.',
    check(file) {
      const out: Flag[] = [];
      const patterns: Array<[RegExp, string]> = [
        [/\b(it|test|describe|context|suite)\.(skip|todo)\s*\(/, 'test skipped'],
        [/\b(it|test|describe|context)\.only\s*\(/, 'test focused with .only (siblings will not run)'],
        [/\b(xit|xdescribe|xtest|fdescribe|fit)\s*\(/, 'test skipped/focused'],
        [/@(pytest\.mark\.)?skip(if)?\b/, 'pytest skip marker added'],
        [/@unittest\.skip/, 'unittest skip added'],
        [/\bt\.Skip(Now)?\s*\(/, 'Go test skipped'],
        [/#\[ignore\]/, 'Rust test ignored'],
        [/\btesting\.Short\s*\(\s*\)/, 'test gated behind -short'],
      ];
      for (const { line, text } of addedLines(file)) {
        for (const [re, msg] of patterns) {
          if (re.test(text)) {
            out.push(flag(this, file.path, msg, [text], line));
            break;
          }
        }
      }
      return out;
    },
  },
  {
    id: 'test-deleted',
    severity: 'critical',
    describe: 'A test file was deleted, or test cases disappeared from one.',
    check(file, ctx) {
      if (!ctx.isTestFile(file.path)) return [];
      if (file.kind === 'deleted') {
        return [flag(this, file.path, 'test file deleted outright', [`${file.deletions} lines removed`])];
      }
      const caseRe = /\b(it|test|describe|def test_|func Test|#\[test\]|\[Test\]|@Test)\b/;
      const removedCases = removedLines(file).filter((l) => caseRe.test(l));
      const addedCases = addedLines(file).filter(({ text }) => caseRe.test(text));
      const net = removedCases.length - addedCases.length;
      if (net > 0) {
        return [
          flag(this, file.path, `${net} test case${net > 1 ? 's' : ''} removed`, removedCases),
        ];
      }
      return [];
    },
  },
  {
    id: 'assertion-weakened',
    severity: 'critical',
    describe: 'Assertions were removed from a test without being replaced.',
    check(file, ctx) {
      if (!ctx.isTestFile(file.path) || file.kind === 'deleted') return [];
      const assertRe = /\b(expect|assert|assertEquals|assertThat|should|require\.|t\.Error|t\.Fatal|panic!|assert_eq!)\b/;
      const removed = removedLines(file).filter((l) => assertRe.test(l));
      const added = addedLines(file).filter(({ text }) => assertRe.test(text));
      const net = removed.length - added.length;
      if (net >= 2) {
        return [flag(this, file.path, `${net} assertions removed net`, removed)];
      }
      return [];
    },
  },
  {
    id: 'error-suppression',
    severity: 'critical',
    describe: 'An error was silenced rather than handled.',
    check(file) {
      const out: Flag[] = [];
      const patterns: Array<[RegExp, string]> = [
        [/@ts-(ignore|expect-error|nocheck)/, 'TypeScript error suppressed'],
        [/eslint-disable(-next-line)?(?!\s*$)/, 'ESLint rule disabled inline'],
        [/#\s*type:\s*ignore/, 'mypy error suppressed'],
        [/#\s*noqa/, 'linter error suppressed'],
        [/^\s*except[^:]*:\s*(pass|\.\.\.)\s*$/, 'exception swallowed (except: pass)'],
        [/\bcatch\s*(\([^)]*\))?\s*\{\s*\}\s*$/, 'exception swallowed (empty catch)'],
        [/_\s*=\s*err\b|^\s*_\s*=\s*\w+\.Close\(\)/, 'Go error discarded'],
        [/\.unwrap_or_default\(\)\s*;\s*\/\/\s*(ignore|todo)/i, 'Rust error discarded'],
      ];

      const added = addedLines(file);
      const claimed = new Set<number>();

      // The idiomatic swallow spans two lines, so match on the pair before
      // falling back to the single-line patterns.
      const BLOCK_OPENERS: Array<[RegExp, RegExp, string]> = [
        [/^\s*except\b[^:]*:\s*$/, /^\s*(pass|\.\.\.)\s*$/, 'exception swallowed (except: pass)'],
        [/\bcatch\s*(\([^)]*\))?\s*\{\s*$/, /^\s*\}\s*$/, 'exception swallowed (empty catch)'],
      ];
      for (let i = 0; i < added.length - 1; i++) {
        const a = added[i];
        const b = added[i + 1];
        if (!a || !b || b.line !== a.line + 1) continue;
        for (const [open, close, msg] of BLOCK_OPENERS) {
          if (open.test(a.text) && close.test(b.text)) {
            out.push(flag(this, file.path, msg, [a.text, b.text], a.line));
            claimed.add(a.line);
            claimed.add(b.line);
            break;
          }
        }
      }

      for (const { line, text } of added) {
        if (claimed.has(line)) continue;
        for (const [re, msg] of patterns) {
          if (re.test(text)) {
            out.push(flag(this, file.path, msg, [text], line));
            break;
          }
        }
      }
      return out;
    },
  },
  {
    id: 'secret-touched',
    severity: 'critical',
    describe: 'A credential file was modified, or a key-shaped literal was added.',
    check(file) {
      const out: Flag[] = [];
      if (SECRETS.test(file.path)) {
        out.push(flag(this, file.path, 'credential file modified', [`${file.kind}, +${file.additions}/-${file.deletions}`]));
      }
      const keyish =
        /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{10,})/;
      for (const { line, text } of addedLines(file)) {
        if (keyish.test(text)) {
          out.push(flag(this, file.path, 'API-key-shaped literal added', [text.replace(/[A-Za-z0-9_-]{12,}/g, (s) => s.slice(0, 6) + '…')], line));
        }
      }
      return out;
    },
  },
  {
    id: 'dependency-added',
    severity: 'warn',
    describe: 'A dependency was added or removed.',
    check(file) {
      if (!MANIFESTS.test(file.path)) return [];
      const added = depNames(addedLines(file).map((a) => a.text));
      const removed = depNames(removedLines(file));
      const net = added.filter((a) => !removed.includes(a));
      const gone = removed.filter((r) => !added.includes(r));
      const out: Flag[] = [];
      if (net.length) {
        out.push(flag(this, file.path, `${net.length} dependenc${net.length > 1 ? 'ies' : 'y'} added: ${net.slice(0, 5).join(', ')}`, net));
      }
      if (gone.length) {
        out.push(flag(this, file.path, `${gone.length} dependenc${gone.length > 1 ? 'ies' : 'y'} removed: ${gone.slice(0, 5).join(', ')}`, gone));
      }
      return out;
    },
  },
  {
    id: 'ci-config-changed',
    severity: 'warn',
    describe: 'CI, container, or deployment configuration was modified.',
    check(file, ctx) {
      if (!CI_CONFIG.test(file.path) || ctx.anchors.has(file.path)) return [];
      return [flag(this, file.path, 'CI/deploy config modified', [`${file.kind}, +${file.additions}/-${file.deletions}`])];
    },
  },
  {
    id: 'build-config-changed',
    severity: 'warn',
    describe: 'Compiler, bundler, or linter configuration was modified.',
    check(file, ctx) {
      if (!BUILD_CONFIG.test(file.path) || ctx.anchors.has(file.path)) return [];
      return [flag(this, file.path, 'build/lint config modified', [`${file.kind}, +${file.additions}/-${file.deletions}`])];
    },
  },
  {
    id: 'generated-committed',
    severity: 'warn',
    describe: 'Build output or vendored code was written into the tree.',
    check(file) {
      if (!GENERATED.test(file.path)) return [];
      return [flag(this, file.path, 'generated/vendored file changed', [`${file.kind}, +${file.additions}/-${file.deletions}`])];
    },
  },
  {
    id: 'large-deletion',
    severity: 'warn',
    describe: 'A large amount of code was removed from a file the task never named.',
    check(file, ctx) {
      if (ctx.anchors.has(file.path)) return [];
      if (LOCKFILES.test(file.path) || GENERATED.test(file.path)) return [];
      if (file.kind === 'deleted') {
        return [flag(this, file.path, `file deleted (${file.deletions} lines)`, [])];
      }
      if (file.deletions >= 30 && file.deletions > file.additions * 3) {
        return [flag(this, file.path, `${file.deletions} lines removed, only ${file.additions} added`, removedLines(file))];
      }
      return [];
    },
  },
  {
    id: 'debug-left',
    severity: 'warn',
    describe: 'Debug output was left in non-test code.',
    check(file, ctx) {
      if (ctx.isTestFile(file.path)) return [];
      const out: Flag[] = [];
      const re = /\b(console\.(log|debug|dir)|debugger|fmt\.Print(ln|f)?|System\.out\.print|dbg!|pp\s|var_dump)\s*[(!;]|^\s*print\s*\(/;
      for (const { line, text } of addedLines(file)) {
        if (re.test(text)) out.push(flag(this, file.path, 'debug output added', [text], line));
      }
      return out.slice(0, 5);
    },
  },
  {
    id: 'stub-left',
    severity: 'warn',
    describe: 'Unimplemented code was left behind.',
    check(file) {
      const out: Flag[] = [];
      const re = /(not implemented|NotImplementedError|todo!\(\)|unimplemented!\(\)|panic\("TODO|throw new Error\(['"`](TODO|not implemented))/i;
      for (const { line, text } of addedLines(file)) {
        if (re.test(text)) out.push(flag(this, file.path, 'unimplemented stub added', [text], line));
      }
      return out.slice(0, 5);
    },
  },
  {
    id: 'version-bumped',
    severity: 'info',
    describe: 'A package version was changed.',
    check(file) {
      if (!MANIFESTS.test(file.path)) return [];
      const hit = addedLines(file).find(({ text }) => /^\s*["']?version["']?\s*[:=]\s*["']?\d+\.\d+/.test(text));
      if (!hit) return [];
      return [flag(this, file.path, 'version bumped', [hit.text], hit.line)];
    },
  },
  {
    id: 'license-changed',
    severity: 'warn',
    describe: 'The license was modified.',
    check(file) {
      if (!/^(LICENSE|LICENCE|COPYING)(\.\w+)?$/i.test(basename(file.path))) return [];
      return [flag(this, file.path, 'license file modified', [`${file.kind}, +${file.additions}/-${file.deletions}`])];
    },
  },
  {
    id: 'lockfile-churn',
    severity: 'info',
    describe: 'A lockfile changed by a large amount.',
    check(file) {
      if (!LOCKFILES.test(file.path)) return [];
      const total = file.additions + file.deletions;
      if (total < 20) return [];
      return [flag(this, file.path, `lockfile churned ${total} lines`, [])];
    },
  },
  {
    id: 'mass-reformat',
    severity: 'info',
    describe: 'A file changed in volume but not in substance — a formatter ran over it.',
    check(file) {
      if (file.kind !== 'modified' || file.additions < 15) return [];
      const norm = (s: string) => s.replace(/\s+/g, '').replace(/[;,]/g, '');
      const before = new Set(removedLines(file).map(norm).filter(Boolean));
      const after = addedLines(file).map((a) => norm(a.text)).filter(Boolean);
      if (after.length === 0) return [];
      const unchanged = after.filter((l) => before.has(l)).length;
      const ratio = unchanged / after.length;
      if (ratio >= 0.9) {
        return [
          flag(this, file.path, `${Math.round(ratio * 100)}% of ${file.additions} changed lines are formatting only`, []),
        ];
      }
      return [];
    },
  },
  {
    id: 'binary-added',
    severity: 'info',
    describe: 'A binary file entered the tree.',
    check(file) {
      if (!file.binary || file.kind === 'deleted') return [];
      return [flag(this, file.path, 'binary file added or modified', [])];
    },
  },
];

export const ALL_RULES = rules;

export function runRules(files: FileChange[], anchors: Set<string>, disabled: Set<string>): Flag[] {
  const ctx: RuleContext = { anchors, isTestFile };
  const out: Flag[] = [];
  for (const file of files) {
    for (const rule of rules) {
      if (disabled.has(rule.id)) continue;
      try {
        // Evidence is verbatim source, so one check covers every rule: if the
        // author marked the line, the rule was right about the pattern and
        // wrong about the intent.
        out.push(...rule.check(file, ctx).filter((f) => !f.evidence.some(isSuppressed)));
      } catch {
        // A rule must never take the whole run down with it.
      }
    }
  }
  return out;
}

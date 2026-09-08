import { dirname, join, posix } from 'node:path';
import { readFileSync } from 'node:fs';
import type { FileChange, FileVerdict, ScopeReason, Verdict } from './types.js';
import { fileStem } from './anchors.js';
import { isTestFile } from './rules.js';

/**
 * Import statements across the languages people actually run agents on.
 * We only need the module specifier, so one regex per syntax family is enough
 * and avoids dragging in a parser for every language in the repo.
 */
const IMPORT_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*import\s+[^;\n]*?from\s+['"]([^'"]+)['"]/g, // ES modules
  /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // CommonJS
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
  /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g, // Python
  /(?:^|\n)\s*use\s+(?:crate|super|self)::([\w:]+)/g, // Rust
  /(?:^|\n)\s*(?:import\s+)?["]([\w./-]+)["]/g, // Go import blocks
];

function extractImports(source: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      for (let g = 1; g < m.length; g++) {
        const v = m[g];
        if (v) out.add(v);
      }
    }
  }
  return [...out];
}

/** Resolve a module specifier to a repo-relative path, best-effort. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    return joined.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '');
  }
  // Python dotted modules and Rust paths map onto directory structure.
  if (/^[\w.]+$/.test(spec) && spec.includes('.')) return spec.replace(/\./g, '/');
  if (spec.includes('::')) return spec.replace(/::/g, '/');
  if (spec.includes('/') && !spec.startsWith('@')) return spec;
  return null;
}

function pathMatchesModule(path: string, module: string): boolean {
  const stripped = path.replace(/\.\w+$/, '');
  return (
    stripped === module ||
    stripped.endsWith('/' + module) ||
    stripped === module + '/index' ||
    stripped.endsWith('/' + module + '/index') ||
    stripped.endsWith('/' + module + '/__init__') ||
    stripped.endsWith('/' + module + '/mod')
  );
}

export interface ScopeInput {
  repoPath: string;
  files: FileChange[];
  anchors: Map<string, ScopeReason>;
  /** Read file contents to resolve import edges. Off for range diffs. */
  useImportGraph: boolean;
}

/**
 * Assign every changed file a verdict.
 *
 * The ladder is deliberately conservative: a file only lands in `out-of-scope`
 * once it has failed every cheap way of being related to the task. False
 * "out-of-scope" calls are the one thing that would make this tool unusable.
 */
export function assignVerdicts(input: ScopeInput): FileVerdict[] {
  const { files, anchors } = input;
  const anchorPaths = [...anchors.keys()];
  const hasAnchors = anchorPaths.length > 0;

  const anchorDirs = new Set(anchorPaths.map((p) => dirname(p)));
  const anchorStems = new Set(anchorPaths.map((p) => fileStem(p).toLowerCase()));

  const importsOf = new Map<string, string[]>();
  if (input.useImportGraph) {
    for (const f of files) {
      if (f.binary || f.kind === 'deleted') continue;
      const abs = join(input.repoPath, f.path);
      try {
        const src = readFileSync(abs, 'utf8');
        if (src.length > 2_000_000) continue;
        importsOf.set(
          f.path,
          extractImports(src)
            .map((s) => resolveSpecifier(f.path, s))
            .filter((s): s is string => s !== null),
        );
      } catch {
        // Unreadable file: fall through to the cheaper signals.
      }
    }
  }

  return files.map((file) => {
    const reasons: ScopeReason[] = [];

    if (!hasAnchors) {
      return {
        file,
        verdict: 'unscoped' as Verdict,
        reasons: [
          {
            kind: 'no-anchors',
            detail: 'task did not name any of the changed files',
          },
        ],
        flags: [],
      };
    }

    const anchorReason = anchors.get(file.path);
    if (anchorReason) {
      return { file, verdict: 'in-scope', reasons: [anchorReason], flags: [] };
    }

    const stem = fileStem(file.path).toLowerCase();

    if (isTestFile(file.path) && anchorStems.has(stem)) {
      reasons.push({ kind: 'sibling-test', detail: `tests ${stem}, which the task names` });
      return { file, verdict: 'adjacent', reasons, flags: [] };
    }
    if (!isTestFile(file.path) && anchorStems.has(stem)) {
      reasons.push({ kind: 'sibling-test', detail: `shares a name with a file the task names` });
      return { file, verdict: 'adjacent', reasons, flags: [] };
    }

    const mine = importsOf.get(file.path) ?? [];
    const importedAnchor = anchorPaths.find((a) => mine.some((m) => pathMatchesModule(a, m)));
    if (importedAnchor) {
      reasons.push({ kind: 'imports-anchor', detail: `imports ${importedAnchor}` });
      return { file, verdict: 'adjacent', reasons, flags: [] };
    }

    const importerAnchor = anchorPaths.find((a) =>
      (importsOf.get(a) ?? []).some((m) => pathMatchesModule(file.path, m)),
    );
    if (importerAnchor) {
      reasons.push({ kind: 'imported-by-anchor', detail: `imported by ${importerAnchor}` });
      return { file, verdict: 'adjacent', reasons, flags: [] };
    }

    const dir = dirname(file.path);
    if (anchorDirs.has(dir) && isCohesiveDir(dir)) {
      reasons.push({ kind: 'same-directory', detail: `sits in ${dir} alongside a named file` });
      return { file, verdict: 'adjacent', reasons, flags: [] };
    }

    reasons.push({
      kind: 'no-relation',
      detail: 'not named by the task, not a sibling, no import edge to a named file',
    });
    return { file, verdict: 'out-of-scope', reasons, flags: [] };
  });
}


/**
 * Generic containers that hold the whole project rather than one module.
 * Co-residence in `src/` says nothing about relatedness; co-residence in
 * `src/auth/` says quite a lot.
 */
const GENERIC_DIRS = new Set([
  '.', '', 'src', 'lib', 'app', 'pkg', 'internal', 'source', 'sources',
  'scripts', 'tools', 'test', 'tests', 'spec', 'docs', 'examples', 'packages',
  'apps', 'services', 'modules', 'components', 'utils', 'helpers', 'common',
]);

function isCohesiveDir(dir: string): boolean {
  if (GENERIC_DIRS.has(dir)) return false;
  const parts = dir.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  // A single non-generic top-level directory (e.g. `auth/`) is specific enough;
  // a generic one needs a qualifying segment beneath it.
  if (parts.length === 1) return !GENERIC_DIRS.has(parts[0] as string);
  return true;
}

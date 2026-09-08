import { basename, dirname, extname } from 'node:path';
import type { FileChange, ScopeReason } from './types.js';

/**
 * Words that appear in nearly every task description and would otherwise match
 * half the repository. Kept deliberately small — over-filtering loses signal.
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'also', 'always', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'build', 'called', 'change', 'changes',
  'check', 'code', 'could', 'create', 'current', 'default', 'does', 'done', 'down',
  'during', 'each', 'error', 'every', 'file', 'files', 'first', 'fix', 'fixed',
  'from', 'function', 'have', 'here', 'into', 'issue', 'just', 'like', 'line',
  'lines', 'make', 'makes', 'method', 'more', 'most', 'must', 'need', 'needs',
  'new', 'not', 'now', 'only', 'other', 'over', 'please', 'project', 'refactor',
  'remove', 'repo', 'return', 'same', 'should', 'since', 'some', 'such', 'test',
  'tests', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'update', 'use', 'used', 'using', 'value',
  'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'will',
  'with', 'would', 'you', 'your',
]);

export interface TaskTerms {
  /** Explicit paths or path fragments, e.g. `src/auth/login.ts`. */
  paths: string[];
  /** Identifier-shaped tokens: CamelCase, snake_case, kebab-case, dotted. */
  symbols: string[];
  /** Remaining content words, lowercased. */
  words: string[];
}

export function extractTerms(task: string): TaskTerms {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const words = new Set<string>();

  // Backticked spans are the strongest signal a human can give.
  for (const m of task.matchAll(/`([^`]{2,120})`/g)) {
    const inner = (m[1] as string).trim();
    if (/[/\\]/.test(inner) || /\.[a-z0-9]{1,5}$/i.test(inner)) paths.add(inner);
    else if (/^[A-Za-z_$][\w$.-]*$/.test(inner)) symbols.add(inner);
  }

  for (const m of task.matchAll(/(?:^|[\s(<"'`])((?:[\w.@-]+\/)+[\w.@-]+|[\w-]+\.[a-z]{1,5})(?=$|[\s)>,;:"'`.])/gi)) {
    const cand = m[1] as string;
    if (/^\d+(\.\d+)*$/.test(cand)) continue; // version numbers
    paths.add(cand.replace(/^\.\//, ''));
  }

  for (const m of task.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    const tok = m[1] as string;
    const isIdentifierShaped =
      /[A-Z]/.test(tok.slice(1)) || tok.includes('_') || /^[a-z]+[A-Z]/.test(tok);
    if (isIdentifierShaped && tok.length >= 3) symbols.add(tok);
    else if (tok.length >= 4 && !STOPWORDS.has(tok.toLowerCase())) words.add(tok.toLowerCase());
  }

  for (const m of task.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)+)\b/gi)) {
    const tok = m[1] as string;
    if (tok.length >= 5) symbols.add(tok);
  }

  return { paths: [...paths], symbols: [...symbols], words: [...words] };
}

/** Strip the extension and any test/spec decoration: `foo.test.ts` -> `foo`. */
export function fileStem(path: string): string {
  let name = basename(path);
  for (let i = 0; i < 3; i++) {
    const ext = extname(name);
    if (!ext) break;
    name = name.slice(0, -ext.length);
  }
  return name.replace(/[._-](test|spec)$/i, '').replace(/^test[._-]/i, '');
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface AnchorMatch {
  path: string;
  reason: ScopeReason;
  strength: number;
}

/**
 * Decide which changed files the task actually names.
 *
 * Only changed files are considered: a task may mention twenty things, but the
 * question is always "which of the files in front of me was I asked to touch".
 */
export function findAnchors(terms: TaskTerms, files: FileChange[]): AnchorMatch[] {
  const matches = new Map<string, AnchorMatch>();

  const record = (path: string, reason: ScopeReason, strength: number) => {
    const prev = matches.get(path);
    if (!prev || prev.strength < strength) matches.set(path, { path, reason, strength });
  };

  for (const file of files) {
    const path = file.path;
    const lowerPath = path.toLowerCase();
    const stem = fileStem(path);
    const normStem = normalize(stem);

    for (const p of terms.paths) {
      const lower = p.toLowerCase();
      if (lowerPath === lower || lowerPath.endsWith('/' + lower) || lower.endsWith('/' + lowerPath)) {
        record(path, { kind: 'path-mentioned', detail: `task names "${p}"` }, 100);
      } else if (lower.includes('/') && lowerPath.includes(lower)) {
        record(path, { kind: 'path-mentioned', detail: `task names path fragment "${p}"` }, 90);
      } else if (!lower.includes('/') && basename(lowerPath) === lower) {
        record(path, { kind: 'path-mentioned', detail: `task names file "${p}"` }, 90);
      }
    }

    for (const s of terms.symbols) {
      const n = normalize(s);
      if (n.length < 3) continue;
      if (n === normStem) {
        record(path, { kind: 'symbol-mentioned', detail: `"${s}" matches file name` }, 80);
      } else if (n.length >= 5 && normStem.length >= 5 && (normStem.includes(n) || n.includes(normStem))) {
        record(path, { kind: 'symbol-mentioned', detail: `"${s}" ~ ${stem}` }, 60);
      } else if (n.length >= 4 && normalize(dirname(path)).includes(n)) {
        record(path, { kind: 'symbol-mentioned', detail: `"${s}" matches directory` }, 50);
      }
    }

    for (const w of terms.words) {
      if (w.length < 4) continue;
      if (normStem === w) record(path, { kind: 'stem-mentioned', detail: `"${w}" matches file name` }, 55);
      else if (normStem.length >= 4 && normStem.includes(w)) {
        record(path, { kind: 'stem-mentioned', detail: `"${w}" appears in file name` }, 40);
      }
    }
  }

  return [...matches.values()].filter((m) => m.strength >= 40).sort((a, b) => b.strength - a.strength);
}

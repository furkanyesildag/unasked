import type { FileChange, Hunk } from './types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0` output.
 *
 * Written by hand rather than pulled from npm: this is the one place where a
 * dependency would be load-bearing, and a wrong parse silently produces wrong
 * verdicts. It handles renames, binary files, and quoted paths.
 */
export function parseUnifiedDiff(raw: string): FileChange[] {
  const out: FileChange[] = [];
  const lines = raw.split('\n');
  let current: FileChange | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current) out.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith('diff --git ')) {
      closeFile();
      const paths = parseDiffHeaderPaths(line);
      current = {
        path: paths.b ?? paths.a ?? '',
        kind: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.kind = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.kind = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = unquotePath(line.slice('rename from '.length));
      current.kind = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = unquotePath(line.slice('rename to '.length));
      current.kind = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4));
      if (p && !current.path) current.path = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4));
      // `+++ /dev/null` marks a deletion; keep the a-side path we already have.
      if (p) current.path = p;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      closeHunk();
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        added: [],
        removed: [],
      };
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('+')) {
      hunk.added.push(line.slice(1));
      current.additions++;
    } else if (line.startsWith('-')) {
      hunk.removed.push(line.slice(1));
      current.deletions++;
    }
  }

  closeFile();
  return out.filter((f) => f.path.length > 0);
}

function stripPrefix(p: string): string | null {
  const cleaned = unquotePath(p.trim().replace(/\t.*$/, ''));
  if (cleaned === '/dev/null') return null;
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) return cleaned.slice(2);
  return cleaned;
}

/**
 * Split `diff --git a/x b/y`. Paths may contain spaces, so the naive split on
 * whitespace is wrong; anchor on the ` b/` separator and fall back to the
 * midpoint when both sides are quoted.
 */
function parseDiffHeaderPaths(line: string): { a: string | null; b: string | null } {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const parts = splitQuoted(rest);
    return { a: parts[0] ? stripPrefix(parts[0]) : null, b: parts[1] ? stripPrefix(parts[1]) : null };
  }
  const sep = rest.lastIndexOf(' b/');
  if (sep === -1) return { a: null, b: null };
  return { a: stripPrefix(rest.slice(0, sep)), b: stripPrefix(rest.slice(sep + 1)) };
}

function splitQuoted(s: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && inQuote) {
      buf += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      buf += c;
      if (!inQuote) {
        parts.push(buf);
        buf = '';
      }
      continue;
    }
    if (c === ' ' && !inQuote) {
      if (buf) parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Undo git's C-style quoting of paths with special characters. */
export function unquotePath(p: string): string {
  const t = p.trim();
  if (!t.startsWith('"') || !t.endsWith('"')) return t;
  const inner = t.slice(1, -1);
  return inner.replace(/\\(\d{3}|.)/g, (_, esc: string) => {
    if (/^\d{3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
    return map[esc] ?? esc;
  });
}

/** All added lines across a file's hunks, paired with their post-image line number. */
export function addedLines(file: FileChange): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (const h of file.hunks) {
    h.added.forEach((text, i) => out.push({ line: h.newStart + i, text }));
  }
  return out;
}

export function removedLines(file: FileChange): string[] {
  return file.hunks.flatMap((h) => h.removed);
}

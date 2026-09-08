import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inline suppression, honoured by every rule.
 *
 * Put it on the offending line when the rule is right about the pattern and
 * wrong about the intent — a fixture that contains `it.skip(` as data, a
 * `console.log` that is the whole point of the file.
 */
export const INLINE_MARKER = 'unasked-ok';

export function isSuppressed(line: string): boolean {
  return line.includes(INLINE_MARKER);
}

/**
 * A `.unaskedignore` file, in the same shape as `.gitignore`: one glob per
 * line, `#` comments, `!` to re-include. Matched files are skipped entirely —
 * no verdict, no rules.
 */
export const IGNORE_FILE = '.unaskedignore';

export class IgnoreList {
  private readonly rules: Array<{ re: RegExp; negated: boolean }> = [];

  constructor(patterns: string[]) {
    // The file that lists the patterns necessarily contains the patterns.
    // Running the rules over it would flag the tool's own configuration.
    this.rules.push({ re: globToRegExp(IGNORE_FILE), negated: false });

    for (const raw of patterns) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      this.rules.push({ re: globToRegExp(pattern), negated });
    }
  }

  static load(repoPath: string): IgnoreList {
    try {
      return new IgnoreList(readFileSync(join(repoPath, IGNORE_FILE), 'utf8').split('\n'));
    } catch {
      return new IgnoreList([]);
    }
  }

  /** True when the only rule is the implicit one for the ignore file itself. */
  get empty(): boolean {
    return this.rules.length <= 1;
  }

  ignores(path: string): boolean {
    let ignored = false;
    // Later rules win, so a `!` line can rescue something an earlier line took.
    for (const { re, negated } of this.rules) {
      if (re.test(path)) ignored = !negated;
    }
    return ignored;
  }
}

/** Translate a gitignore-style glob into an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  let pattern = glob;
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);

  // A pattern without a slash matches at any depth, as in gitignore.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans directories; a bare `**` spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = dirOnly ? '(?:/.*)?$' : '(?:/.*)?$';
  return new RegExp(prefix + out + suffix);
}

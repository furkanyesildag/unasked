import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './types.js';
import { lastCommitMessage } from './git.js';

/**
 * Claude Code stores one JSONL transcript per session under a directory named
 * after the project path with separators replaced by dashes.
 */
function claudeProjectDir(repoPath: string): string {
  const slug = repoPath.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  userType?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
}

/** Pull the plain text out of a message body, ignoring tool results and images. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    // A turn containing a tool_result is the harness replying to itself, not a
    // human stating a task.
    if (b.type === 'tool_result') return null;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  const joined = parts.join('\n').trim();
  return joined || null;
}

/**
 * Recover the most recent human-typed prompt for this repository from the
 * agent's own session log. This is what makes `blastradius` zero-config: the
 * task is already on disk, nobody should have to retype it.
 */
export function inferFromClaudeCode(repoPath: string, maxAgeHours = 24): Task | null {
  const dir = claudeProjectDir(repoPath);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const cutoff = Date.now() - maxAgeHours * 3600_000;
  const recent = files
    .map((f) => {
      try {
        return { f, mtime: statSync(f).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; mtime: number } => x !== null && x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { f } of recent) {
    const prompt = lastUserPrompt(f, repoPath);
    if (prompt) {
      return { text: prompt.text, source: 'claude-code', detail: `session ${prompt.sessionId ?? '?'}` };
    }
  }
  return null;
}

function lastUserPrompt(file: string, repoPath: string): { text: string; sessionId?: string } | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    if (entry.isSidechain) continue;
    if (entry.cwd && entry.cwd !== repoPath && !entry.cwd.startsWith(repoPath + '/')) continue;
    const text = textOf(entry.message?.content);
    if (!text) continue;
    // Command envelopes and system notices are not tasks.
    if (text.startsWith('<') && text.includes('</')) continue;
    return { text, sessionId: entry.sessionId };
  }
  return null;
}

export interface ResolveTaskOptions {
  explicit?: string;
  repoPath: string;
  /** Set for range/base diffs, where the commit message is the better source. */
  preferCommitMessage?: boolean;
  maxAgeHours?: number;
}

export function resolveTask(opts: ResolveTaskOptions): Task {
  if (opts.explicit && opts.explicit.trim()) {
    return { text: opts.explicit.trim(), source: 'explicit' };
  }
  if (opts.preferCommitMessage) {
    const msg = lastCommitMessage(opts.repoPath);
    if (msg) return { text: msg, source: 'commit-message', detail: 'HEAD' };
  }
  const fromAgent = inferFromClaudeCode(opts.repoPath, opts.maxAgeHours);
  if (fromAgent) return fromAgent;

  const msg = lastCommitMessage(opts.repoPath);
  if (msg) return { text: msg, source: 'commit-message', detail: 'HEAD' };

  return { text: '', source: 'none' };
}

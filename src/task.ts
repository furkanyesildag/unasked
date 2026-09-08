import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './types.js';
import { lastCommitMessage } from './git.js';

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Claude Code names each project directory after the project path with the
 * separators replaced by dashes. The exact substitution differs by platform —
 * a Windows path has backslashes and a drive colon — so rather than commit to
 * one spelling, try the plausible ones and let the caller fall back to
 * searching if none of them exist.
 */
function candidateProjectDirs(repoPath: string): string[] {
  const slugs = new Set([
    repoPath.replace(/\//g, '-'),
    repoPath.replace(/[\\/]/g, '-'),
    repoPath.replace(/[\\/:]/g, '-'),
    repoPath.replace(/\\/g, '/').replace(/\//g, '-'),
  ]);
  return [...slugs].map((s) => join(projectsRoot(), s));
}

/** Paths from different platforms and casings should still compare equal. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.startsWith(nb + '/');
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
 * agent's own session log. This is what makes `unasked` zero-config: the
 * task is already on disk, nobody should have to retype it.
 */
export function inferFromClaudeCode(repoPath: string, maxAgeHours = 24): Task | null {
  const cutoff = Date.now() - maxAgeHours * 3600_000;

  // Fast path: the project directory is where the naming convention says it is.
  let files = transcriptsIn(candidateProjectDirs(repoPath), cutoff);

  // Slow path: the convention did not match, so find the transcript by reading
  // the `cwd` each session records rather than by guessing its file name.
  if (files.length === 0) files = allRecentTranscripts(cutoff);

  for (const { f } of files) {
    const prompt = lastUserPrompt(f, repoPath);
    if (prompt) {
      return { text: prompt.text, source: 'claude-code', detail: `session ${prompt.sessionId ?? '?'}` };
    }
  }
  return null;
}

interface DatedFile {
  f: string;
  mtime: number;
}

function transcriptsIn(dirs: string[], cutoff: number): DatedFile[] {
  const out: DatedFile[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const f = join(dir, name);
      try {
        const mtime = statSync(f).mtimeMs;
        if (mtime >= cutoff) out.push({ f, mtime });
      } catch {
        // Vanished between listing and stat; nothing to do about it.
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Bounded so a machine with hundreds of projects does not pay for the miss. */
const MAX_SCANNED_TRANSCRIPTS = 25;

function allRecentTranscripts(cutoff: number): DatedFile[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot()).map((d) => join(projectsRoot(), d));
  } catch {
    return [];
  }
  return transcriptsIn(dirs, cutoff).slice(0, MAX_SCANNED_TRANSCRIPTS);
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
    if (entry.cwd && !samePath(entry.cwd, repoPath)) continue;
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

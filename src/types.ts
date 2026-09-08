/** Core data model shared across the pipeline. */

export type Verdict = 'in-scope' | 'adjacent' | 'out-of-scope' | 'unscoped';

export type Severity = 'critical' | 'warn' | 'info';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** A single contiguous block of changed lines within a file. */
export interface Hunk {
  /** 1-based start line in the post-image. */
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  added: string[];
  removed: string[];
}

export interface FileChange {
  path: string;
  /** Set only when `kind === 'renamed'`. */
  oldPath?: string;
  kind: ChangeKind;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

/** A deterministic rule hit, always carrying the evidence that produced it. */
export interface Flag {
  /** Stable machine-readable id, e.g. `test-disabled`. */
  rule: string;
  severity: Severity;
  path: string;
  message: string;
  /** Verbatim source lines that triggered the rule. */
  evidence: string[];
  /** Line number in the post-image, when the rule anchors to one. */
  line?: number;
}

/** Why a file received the verdict it did — surfaced with `--why`. */
export interface ScopeReason {
  kind:
    | 'path-mentioned'
    | 'symbol-mentioned'
    | 'stem-mentioned'
    | 'sibling-test'
    | 'same-directory'
    | 'imports-anchor'
    | 'imported-by-anchor'
    | 'no-relation'
    | 'no-anchors';
  detail: string;
}

export interface FileVerdict {
  file: FileChange;
  verdict: Verdict;
  reasons: ScopeReason[];
  flags: Flag[];
}

export interface Task {
  text: string;
  source: 'explicit' | 'claude-code' | 'commit-message' | 'none';
  /** Human-readable provenance, e.g. a session id or file path. */
  detail?: string;
}

export interface Report {
  task: Task;
  anchors: string[];
  files: FileVerdict[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
    inScope: number;
    adjacent: number;
    outOfScope: number;
    unscoped: number;
    critical: number;
    warn: number;
    info: number;
  };
}

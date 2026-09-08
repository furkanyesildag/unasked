import type { FileVerdict, Report, ScopeReason, Task } from './types.js';
import { collectChanges, type DiffSelector } from './git.js';
import { extractTerms, findAnchors } from './anchors.js';
import { runRules } from './rules.js';
import { assignVerdicts } from './scope.js';
import { IgnoreList } from './ignore.js';

export interface AnalyzeOptions {
  repoPath: string;
  task: Task;
  selector?: DiffSelector;
  disabledRules?: Set<string>;
  /** Skip reading working-tree files for import edges. */
  noImportGraph?: boolean;
  /** Defaults to `.blastradiusignore` at the repository root. */
  ignore?: IgnoreList;
}

export function analyze(opts: AnalyzeOptions): Report {
  const selector = opts.selector ?? {};
  const ignore = opts.ignore ?? IgnoreList.load(opts.repoPath);
  const files = collectChanges(opts.repoPath, selector).filter((f) => !ignore.ignores(f.path));

  const terms = extractTerms(opts.task.text);
  const anchorMatches = opts.task.text ? findAnchors(terms, files) : [];
  const anchors = new Map<string, ScopeReason>(anchorMatches.map((a) => [a.path, a.reason]));

  const verdicts = assignVerdicts({
    repoPath: opts.repoPath,
    files,
    anchors,
    useImportGraph: !opts.noImportGraph && !selector.range && !selector.base,
  });

  const flags = runRules(files, new Set(anchors.keys()), opts.disabledRules ?? new Set());
  const byPath = new Map<string, FileVerdict>(verdicts.map((v) => [v.file.path, v]));
  for (const f of flags) byPath.get(f.path)?.flags.push(f);

  for (const v of byPath.values()) {
    v.flags.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  const totals = {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    inScope: verdicts.filter((v) => v.verdict === 'in-scope').length,
    adjacent: verdicts.filter((v) => v.verdict === 'adjacent').length,
    outOfScope: verdicts.filter((v) => v.verdict === 'out-of-scope').length,
    unscoped: verdicts.filter((v) => v.verdict === 'unscoped').length,
    critical: flags.filter((f) => f.severity === 'critical').length,
    warn: flags.filter((f) => f.severity === 'warn').length,
    info: flags.filter((f) => f.severity === 'info').length,
  };

  return {
    task: opts.task,
    anchors: anchorMatches.map((a) => a.path),
    files: sortForReport(verdicts),
    totals,
  };
}

function severityRank(s: string): number {
  return s === 'critical' ? 3 : s === 'warn' ? 2 : 1;
}

function verdictRank(v: string): number {
  return v === 'out-of-scope' ? 0 : v === 'unscoped' ? 1 : v === 'adjacent' ? 2 : 3;
}

/** Worst news first: out-of-scope files, then by severity, then by size. */
function sortForReport(verdicts: FileVerdict[]): FileVerdict[] {
  return [...verdicts].sort((a, b) => {
    const v = verdictRank(a.verdict) - verdictRank(b.verdict);
    if (v !== 0) return v;
    const sa = Math.max(0, ...a.flags.map((f) => severityRank(f.severity)));
    const sb = Math.max(0, ...b.flags.map((f) => severityRank(f.severity)));
    if (sa !== sb) return sb - sa;
    const ca = a.file.additions + a.file.deletions;
    const cb = b.file.additions + b.file.deletions;
    if (ca !== cb) return cb - ca;
    return a.file.path.localeCompare(b.file.path);
  });
}

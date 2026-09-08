import type { FileVerdict, Report, Severity, Verdict } from './types.js';

/** Built at runtime so no literal escape byte ever sits in the source. */
const CSI = String.fromCharCode(27) + '[';

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR !== undefined);

const c = (code: string) => (s: string) => (useColor ? `${CSI}${code}m${s}${CSI}0m` : s);
const dim = c('2');
const bold = c('1');
const red = c('31');
const yellow = c('33');
const green = c('32');
const blue = c('34');
const gray = c('90');

const VERDICT_LABEL: Record<Verdict, string> = {
  'in-scope': 'IN SCOPE',
  adjacent: 'ADJACENT',
  'out-of-scope': 'OUT OF SCOPE',
  unscoped: 'UNSCOPED',
};

const VERDICT_COLOR: Record<Verdict, (s: string) => string> = {
  'in-scope': green,
  adjacent: blue,
  'out-of-scope': red,
  unscoped: gray,
};

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  critical: red,
  warn: yellow,
  info: gray,
};

const SEV_MARK: Record<Severity, string> = { critical: '!!', warn: ' !', info: ' .' };

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(s.length - n + 1);
}

function delta(v: FileVerdict): string {
  const { additions, deletions } = v.file;
  const a = additions ? green(`+${additions}`) : '';
  const d = deletions ? red(`-${deletions}`) : '';
  return [a, d].filter(Boolean).join(' ') || dim('0');
}

export interface RenderOptions {
  why?: boolean;
  /** Show every changed file, not just the ones that need attention. */
  all?: boolean;
  width?: number;
}

export function renderReport(report: Report, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const width = opts.width ?? terminalWidth();
  const { totals, task } = report;

  out.push('');
  out.push(bold('  unasked'));
  out.push('');

  if (task.source === 'none' || !task.text) {
    out.push(`  ${yellow('No task found.')} Pass one with ${bold('-t "..."')} to get scope verdicts.`);
    out.push(`  ${dim('Running in flags-only mode: the mechanical rules still apply.')}`);
  } else {
    const label =
      task.source === 'explicit'
        ? 'task'
        : task.source === 'claude-code'
          ? `task ${dim(`(from Claude Code ${task.detail ?? ''})`)}`
          : `task ${dim('(from commit message)')}`;
    out.push(`  ${dim(label)}`);
    for (const line of wrap(firstLines(task.text, 3), width - 8)) {
      out.push(`  ${bold('"' + line + '"')}`);
    }
  }
  out.push('');

  if (totals.files === 0) {
    out.push(`  ${green('No changes.')} Nothing to review.`);
    out.push('');
    return out.join('\n');
  }

  const shown = opts.all
    ? report.files
    : report.files.filter(
        (v) => v.verdict === 'out-of-scope' || v.verdict === 'unscoped' || v.flags.length > 0,
      );

  const pathWidth = Math.max(
    20,
    Math.min(width - 34, Math.max(...shown.map((v) => v.file.path.length), 20)),
  );

  for (const v of shown) {
    const vc = VERDICT_COLOR[v.verdict];
    const label = pad(VERDICT_LABEL[v.verdict], 12);
    const path = pad(truncate(v.file.path, pathWidth), pathWidth);
    const kind = v.file.kind === 'modified' ? '' : dim(` ${v.file.kind}`);
    out.push(`  ${vc(label)} ${path}  ${delta(v)}${kind}`);

    if (opts.why) {
      for (const r of v.reasons) out.push(`  ${' '.repeat(12)} ${gray('↳ ' + r.detail)}`);
    }

    for (const f of v.flags) {
      const sc = SEV_COLOR[f.severity];
      const at = f.line ? gray(`:${f.line}`) : '';
      out.push(
        `  ${' '.repeat(12)} ${sc(SEV_MARK[f.severity])} ${sc(f.message)}${at} ${gray(`[${f.rule}]`)}`,
      );
      for (const e of f.evidence) {
        out.push(`  ${' '.repeat(16)} ${gray(truncate(e, width - 20))}`);
      }
    }
  }

  const hidden = report.files.length - shown.length;
  if (hidden > 0) {
    const s = hidden > 1 ? 's' : '';
    out.push(`  ${gray(`... ${hidden} more file${s} in scope and clean (--all to show)`)}`);
  }

  out.push('');
  out.push('  ' + gray('─'.repeat(Math.max(20, width - 4))));

  const parts: string[] = [];
  if (totals.inScope) parts.push(green(`${totals.inScope} in scope`));
  if (totals.adjacent) parts.push(blue(`${totals.adjacent} adjacent`));
  if (totals.outOfScope) parts.push(red(`${totals.outOfScope} out of scope`));
  if (totals.unscoped) parts.push(gray(`${totals.unscoped} unscoped`));

  out.push(
    `  ${bold(`${totals.files} file${totals.files > 1 ? 's' : ''}`)} ` +
      `${green(`+${totals.additions}`)} ${red(`-${totals.deletions}`)}   ` +
      parts.join(dim(' · ')),
  );

  const sev: string[] = [];
  if (totals.critical) sev.push(red(`${totals.critical} critical`));
  if (totals.warn) sev.push(yellow(`${totals.warn} warning${totals.warn > 1 ? 's' : ''}`));
  if (totals.info) sev.push(gray(`${totals.info} note${totals.info > 1 ? 's' : ''}`));
  if (sev.length) out.push(`  ${sev.join(dim(' · '))}`);

  out.push('');
  if (totals.outOfScope > 0) {
    out.push(`  ${dim('review just the surprises:')} ${bold('unasked diff --out-of-scope')}`);
    out.push(`  ${dim('put them back:')}            ${bold('unasked revert --out-of-scope')}`);
    out.push('');
  }

  return out.join('\n');
}

/** Honour COLUMNS when stdout is a pipe, so piped and redirected output wraps sanely. */
function terminalWidth(): number {
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env >= 40) return Math.min(env, 110);
  return Math.min(process.stdout.columns || 100, 110);
}

function firstLines(s: string, n: number): string {
  const lines = s.split('\n').filter((l) => l.trim());
  const head = lines.slice(0, n).join(' ');
  return lines.length > n ? head + ' ...' : head;
}

function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

/** One-line summary for hooks and CI annotations. */
export function renderSummary(report: Report): string {
  const t = report.totals;
  const bits = [`${t.files} files changed`];
  if (t.outOfScope) bits.push(`${t.outOfScope} out of scope`);
  if (t.critical) bits.push(`${t.critical} critical`);
  if (t.warn) bits.push(`${t.warn} warnings`);
  return bits.join(', ');
}

import type { Report } from './types.js';

/**
 * Claude Code hook payloads. Only the fields we consume are modelled; the
 * harness sends more and is free to add to it.
 */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  /** Text surfaced back into the agent's context. */
  systemMessage?: string;
  decision?: 'block';
  reason?: string;
  continue?: boolean;
}

export async function readHookInput(stdin: NodeJS.ReadableStream): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

/**
 * Turn a report into feedback the agent itself will read.
 *
 * Written in the second person and kept short on purpose: this text lands in
 * the agent's context, where a wall of output costs tokens and gets ignored.
 */
export function hookMessage(report: Report): string | null {
  const { totals } = report;
  const outOfScope = report.files.filter((f) => f.verdict === 'out-of-scope');
  const critical = report.files.flatMap((f) => f.flags).filter((f) => f.severity === 'critical');

  if (outOfScope.length === 0 && critical.length === 0) return null;

  const lines: string[] = ['Unasked review of your changes:'];

  if (outOfScope.length > 0) {
    lines.push('');
    lines.push(`${outOfScope.length} file(s) you changed are not related to the stated task:`);
    for (const f of outOfScope.slice(0, 10)) {
      lines.push(`  - ${f.file.path} (+${f.file.additions}/-${f.file.deletions})`);
    }
    if (outOfScope.length > 10) lines.push(`  - ... and ${outOfScope.length - 10} more`);
    lines.push('Either explain why each was necessary, or revert it.');
  }

  if (critical.length > 0) {
    lines.push('');
    lines.push('Critical findings:');
    for (const f of critical.slice(0, 10)) {
      lines.push(`  - ${f.path}${f.line ? ':' + f.line : ''} — ${f.message} [${f.rule}]`);
    }
  }

  lines.push('');
  lines.push(`Totals: ${totals.files} files, +${totals.additions}/-${totals.deletions}.`);
  return lines.join('\n');
}

/** The settings.json fragment `unasked install-hook` writes. */
export function hookSettingsFragment(): Record<string, unknown> {
  return {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'unasked hook', timeout: 30 }],
        },
      ],
    },
  };
}

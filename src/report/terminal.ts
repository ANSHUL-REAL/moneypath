import { createColors } from 'picocolors';
import type { Finding, ScanResult, Severity } from '../types';

export interface TerminalOptions {
  color: boolean;
  /** Hide `review` findings and show only what the analyzer can prove. */
  confirmedOnly: boolean;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
};

export function renderTerminal(result: ScanResult, options: TerminalOptions): string {
  const c = createColors(options.color);
  const out: string[] = [];

  const findings = options.confirmedOnly
    ? result.findings.filter((f) => f.confidence === 'confirmed')
    : result.findings;

  const paint = (severity: Severity, text: string): string => {
    if (severity === 'critical') return c.red(c.bold(text));
    if (severity === 'high') return c.yellow(c.bold(text));
    return c.blue(text);
  };

  out.push('');
  out.push(
    `  ${c.bold('moneypath')} ${c.dim('·')} ${c.dim(
      `${result.filesScanned} files in ${result.durationMs}ms`,
    )}`,
  );
  out.push('');

  if (result.noPaymentCodeFound) {
    out.push(`  ${c.dim('No Razorpay or Stripe usage found in this project.')}`);
    out.push(
      `  ${c.dim('If that is wrong, point moneypath at the directory holding your server code.')}`,
    );
    out.push('');
    return out.join('\n');
  }

  if (findings.length === 0) {
    out.push(`  ${c.green('✔')} No payment logic flaws found.`);
    out.push('');
    return out.join('\n');
  }

  for (const finding of findings) {
    const badge = paint(finding.severity, ` ${SEVERITY_LABEL[finding.severity]} `);
    const confidence =
      finding.confidence === 'confirmed'
        ? c.dim('confirmed')
        : c.dim(c.italic('needs review'));

    out.push(`  ${badge} ${c.bold(finding.title)}  ${c.dim(finding.rule)} ${confidence}`);
    out.push(`  ${c.cyan(`${finding.file}:${finding.line}:${finding.column}`)}`);
    out.push('');
    out.push(`      ${c.dim('│')} ${finding.snippet}`);

    if (finding.trace && finding.trace.length > 0) {
      out.push('');
      for (const step of finding.trace) {
        out.push(`      ${c.dim('↳')} ${c.dim(step)}`);
      }
    }

    out.push('');
    out.push(wrap(finding.impact, 6, c.reset));
    out.push('');
    out.push(wrap(`${c.green('Fix:')} ${finding.fix}`, 6, c.dim));
    out.push('');
  }

  out.push(`  ${c.dim('─'.repeat(60))}`);
  out.push(`  ${summaryLine(findings, c)}`);
  out.push('');

  return out.join('\n');
}

function summaryLine(findings: Finding[], c: ReturnType<typeof createColors>): string {
  const count = (s: Severity): number => findings.filter((f) => f.severity === s).length;
  const parts: string[] = [];
  if (count('critical') > 0) parts.push(c.red(c.bold(`${count('critical')} critical`)));
  if (count('high') > 0) parts.push(c.yellow(`${count('high')} high`));
  if (count('medium') > 0) parts.push(c.blue(`${count('medium')} medium`));
  const review = findings.filter((f) => f.confidence === 'review').length;
  const tail = review > 0 ? c.dim(`  (${review} needing review)`) : '';
  return `${parts.join(c.dim(' · '))}${tail}`;
}

/** Soft-wrap prose to a readable width with a hanging indent. */
function wrap(text: string, indent: number, style: (s: string) => string): string {
  const width = 78 - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);

  return lines.map((l) => `${' '.repeat(indent)}${style(l)}`).join('\n');
}

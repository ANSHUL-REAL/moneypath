/** Severity ordering is meaningful: see SEVERITY_RANK. */
export type Severity = 'critical' | 'high' | 'medium';

/**
 * `confirmed` means the analyzer traced the full path and stands behind it.
 * `review` means the pattern matched but a human has to judge intent.
 *
 * The distinction is the whole trust model of this tool. A scanner that cries
 * wolf on payment code gets uninstalled once and never reinstalled, so anything
 * the analyzer cannot prove is downgraded rather than dropped.
 */
export type Confidence = 'confirmed' | 'review';

export type Gateway = 'razorpay' | 'stripe';

export type RuleId =
  | 'MP001'
  | 'MP002'
  | 'MP003'
  | 'MP004'
  | 'MP005'
  | 'MP006';

export interface Finding {
  rule: RuleId;
  /** Short kebab-case slug, e.g. `client-controlled-amount`. */
  slug: string;
  severity: Severity;
  confidence: Confidence;
  gateway: Gateway | null;
  /** One line stating the defect. */
  title: string;
  /** Repo-relative, forward-slashed. */
  file: string;
  line: number;
  column: number;
  /** The offending source line, trimmed. */
  snippet: string;
  /** What an attacker actually gets out of it. */
  impact: string;
  /** Concrete remediation. */
  fix: string;
  /** How the analyzer reached this conclusion (the traced path, when there is one). */
  trace?: string[];
}

export interface ScanOptions {
  /** Directory to scan. */
  cwd: string;
  /** Extra glob patterns to ignore, on top of the defaults. */
  ignore?: string[];
  /** Cap on files parsed; guards against scanning a monorepo by accident. */
  maxFiles?: number;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  durationMs: number;
  /** True when no payment SDK call sites were found at all. */
  noPaymentCodeFound: boolean;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
};

export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  // Confirmed findings outrank ones needing review at the same severity.
  if (a.confidence !== b.confidence) return a.confidence === 'confirmed' ? -1 : 1;
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  return a.line - b.line;
}

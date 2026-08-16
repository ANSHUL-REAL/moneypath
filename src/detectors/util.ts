import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { RULES } from '../rules';
import type { Confidence, Finding, Gateway, RuleId } from '../types';
import { locate } from '../analysis/ast';
import type { PaymentSink } from '../analysis/sinks';

export interface DetectorContext {
  sourceFile: SourceFile;
  /** Repo-relative, forward-slashed. */
  relPath: string;
  sinks: PaymentSink[];
}

export type Detector = (ctx: DetectorContext) => Finding[];

export interface FindingInput {
  rule: RuleId;
  node: Node;
  ctx: DetectorContext;
  confidence: Confidence;
  gateway: Gateway | null;
  impact: string;
  fix: string;
  title?: string;
  trace?: string[];
}

/** Display name for prose. `razorpay` reads as a typo in a sentence. */
export function gatewayName(gateway: Gateway | null): string {
  if (gateway === 'razorpay') return 'Razorpay';
  if (gateway === 'stripe') return 'Stripe';
  if (gateway === 'cashfree') return 'Cashfree';
  return 'the payment gateway';
}

export function buildFinding(input: FindingInput): Finding {
  const meta = RULES[input.rule];
  const { line, column, snippet } = locate(input.node);
  const finding: Finding = {
    rule: meta.id,
    slug: meta.slug,
    severity: meta.severity,
    confidence: input.confidence,
    gateway: input.gateway,
    title: input.title ?? meta.title,
    file: input.ctx.relPath,
    line,
    column,
    snippet,
    impact: input.impact,
    fix: input.fix,
  };
  if (input.trace && input.trace.length > 0) finding.trace = input.trace;
  return finding;
}

/** Calls that verify a payment actually happened, in any of the common SDK spellings. */
export const VERIFICATION_RE =
  /validateWebhookSignature|verifyPaymentSignature|verifyWebhookSignature|constructEvent|constructEventAsync|createHmac|timingSafeEqual|new\s+Webhook\s*\(/;

export function hasVerification(sf: SourceFile): boolean {
  return VERIFICATION_RE.test(sf.getFullText());
}

/** Property names that carry an order's paid/unpaid state. */
const STATUS_PROP_RE = /^(status|state|payment_status|paymentStatus|paid|isPaid)$/;
/** Values that mean "money received". */
const PAID_VALUE_RE = /^(paid|success|successful|completed|complete|captured|confirmed|active)$/i;

export interface StatusWrite {
  node: Node;
  value: string;
}

/**
 * Find places where an order is flipped into a paid state.
 *
 * Requires the write to be an argument of a mutation-shaped call so that UI
 * state like `const [status, setStatus] = useState('completed')` does not
 * register as a payment confirmation.
 */
export function findPaidStatusWrites(sf: SourceFile): StatusWrite[] {
  const writes: StatusWrite[] = [];

  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = prop.getName().replace(/['"]/g, '');
    if (!STATUS_PROP_RE.test(name)) continue;

    const init = prop.getInitializer();
    if (!init) continue;

    let value: string | null = null;
    if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
      value = init.getLiteralText();
    } else if (init.getKind() === SyntaxKind.TrueKeyword && /^(paid|isPaid)$/.test(name)) {
      value = 'true';
    }
    if (value === null) continue;
    if (value !== 'true' && !PAID_VALUE_RE.test(value)) continue;

    if (!isInsideMutationCall(prop)) continue;

    writes.push({ node: prop, value });
  }

  return writes;
}

const MUTATION_CALLEE_RE =
  /(update|insert|upsert|create|save|set|patch|put|post|write|edit|modify)/i;

function isInsideMutationCall(node: Node): boolean {
  const call = node.getFirstAncestorByKind(SyntaxKind.CallExpression);
  if (!call) return false;
  const callee = call.getExpression().getText();
  if (MUTATION_CALLEE_RE.test(callee)) return true;
  // `fetch('/api/x', { method: 'POST', body: ... })` shaped writes.
  return /^fetch$/.test(callee) && /POST|PUT|PATCH/i.test(call.getText());
}

/** Redirect/callback parameters a browser can forge. */
export const REDIRECT_PARAM_RE =
  /razorpay_payment_id|razorpay_order_id|razorpay_signature|payment_intent|session_id|checkout_session/;

export function readsRedirectParams(sf: SourceFile): boolean {
  const text = sf.getFullText();
  if (!REDIRECT_PARAM_RE.test(text)) return false;
  return /searchParams|req\.query|request\.query|useSearchParams|params\./.test(text);
}

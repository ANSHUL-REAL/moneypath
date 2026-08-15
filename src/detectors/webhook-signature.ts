import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding, Gateway } from '../types';
import { getGatewayContext } from '../analysis/sinks';
import { buildFinding, hasVerification, type Detector } from './util';

const SIGNATURE_HEADER_RE = /x-razorpay-signature|stripe-signature|razorpay_signature/i;
const HANDLER_NAME_RE = /^(POST|PUT|handler|webhook|default)$/;

/** Anchor the finding on the request handler when we can find one. */
function findAnchor(sf: SourceFile): Node {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && HANDLER_NAME_RE.test(name)) return fn;
  }
  for (const decl of sf.getVariableDeclarations()) {
    if (HANDLER_NAME_RE.test(decl.getName())) return decl;
  }
  const exported = sf.getFirstDescendantByKind(SyntaxKind.ExportAssignment);
  return exported ?? sf.getStatements()[0] ?? sf;
}

/**
 * Does this file actually expose an HTTP handler?
 *
 * Without this check, any file that merely *discusses* webhooks — a security
 * util, a comment, a fix string in a scanner like this one — reads as a
 * vulnerable endpoint. Mentioning a header name is not the same as serving a
 * request.
 */
function hasRequestHandler(sf: SourceFile): boolean {
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    if (fn.isDefaultExport()) return true;
    const name = fn.getName();
    if (name && HANDLER_NAME_RE.test(name)) return true;
  }
  for (const statement of sf.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const decl of statement.getDeclarations()) {
      if (HANDLER_NAME_RE.test(decl.getName())) return true;
    }
  }
  return false;
}

/** Does it read the incoming request body, as a real handler must? */
function readsRequestBody(sf: SourceFile): boolean {
  return /\breq(uest)?\s*\.\s*(json|text|body|arrayBuffer)\b|\brawBody\b|bodyParser/.test(
    sf.getFullText(),
  );
}

function pickGateway(gateways: Set<Gateway>, text: string): Gateway | null {
  if (/razorpay/i.test(text)) return 'razorpay';
  if (/stripe/i.test(text)) return 'stripe';
  if (gateways.has('razorpay')) return 'razorpay';
  if (gateways.has('stripe')) return 'stripe';
  return null;
}

/**
 * MP006 — a payment webhook that never checks the signature.
 *
 * Scoped to files that both look like a webhook route and mention a payment
 * gateway, so unrelated webhooks (GitHub, Slack, Clerk) are left alone.
 */
export const webhookSignatureDetector: Detector = (ctx): Finding[] => {
  const sf = ctx.sourceFile;
  const text = sf.getFullText();

  const gateways = getGatewayContext(sf);
  if (gateways.size === 0) return [];

  // Three independent signals must agree before this fires: it is named or
  // shaped like a webhook, it serves requests, and it consumes the body.
  const looksLikeWebhook = /webhook/i.test(ctx.relPath) || SIGNATURE_HEADER_RE.test(text);
  if (!looksLikeWebhook) return [];
  if (!hasRequestHandler(sf)) return [];
  if (!readsRequestBody(sf)) return [];

  if (hasVerification(sf)) return [];

  const gateway = pickGateway(gateways, text);
  const gatewayName = gateway === 'stripe' ? 'Stripe' : 'Razorpay';

  return [
    buildFinding({
      rule: 'MP006',
      node: findAnchor(sf),
      ctx,
      confidence: 'confirmed',
      gateway,
      impact: `This handler acts on webhook payloads without verifying they came from ${gatewayName}. The endpoint is public, so anyone who guesses the URL can POST a fake \`payment.captured\` event and mark orders paid for free.`,
      fix:
        gateway === 'stripe'
          ? `Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)\` as the first statement in the handler, and return 400 if it throws. Read the raw body — a parsed body will not verify.`
          : `Compute \`crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')\` and compare it against the \`x-razorpay-signature\` header with \`crypto.timingSafeEqual\` before touching any business logic.`,
    }),
  ];
};

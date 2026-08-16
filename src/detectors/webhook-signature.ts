import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding, Gateway } from '../types';
import { getGatewayContext } from '../analysis/sinks';
import { buildFinding, hasVerification, type Detector } from './util';

const SIGNATURE_HEADER_RE =
  /x-razorpay-signature|stripe-signature|razorpay_signature|x-webhook-signature|x-webhook-timestamp/i;
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
/**
 * Does a route registration expose an HTTP webhook handler?
 *
 * Supports:
 *   app.post('/webhooks/razorpay', handler)
 *   router.post('/webhooks/razorpay', handler)
 *   app.use('/webhooks/razorpay', handler)
 *   fastify.post('/webhooks/razorpay', handler)
 *   fastify.route({
 *     method: 'POST',
 *     url: '/webhooks/razorpay',
 *     handler,
 *   })
 */
function hasRouteHandler(sf: SourceFile): boolean {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();

    if (!Node.isPropertyAccessExpression(expression)) continue;

    const receiver = expression.getExpression().getText();
    const method = expression.getName();

    // Express / Router / Fastify:
    // app.post('/webhooks/razorpay', ...)
    // router.post('/webhooks/razorpay', ...)
    // fastify.post('/webhooks/razorpay', ...)
    const normalizedMethod = method.toLowerCase();

    if (
      normalizedMethod === 'post' ||
      normalizedMethod === 'use' ||
      normalizedMethod === 'all'
    ) {
      const args = call.getArguments();

      if (args.length < 2) continue;

      const path = args[0];

      if (
        Node.isStringLiteral(path) &&
        /webhook/i.test(path.getLiteralValue())
      ) {
        return true;
      }
    }

    // Fastify object form:
    //
    // fastify.route({
    //   method: 'POST',
    //   url: '/webhooks/razorpay',
    //   handler,
    // })
    if (normalizedMethod === 'route') {
      const firstArg = call.getArguments()[0];

      if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) {
        continue;
      }

      const methodProp = firstArg.getProperty('method');
      const urlProp = firstArg.getProperty('url');
      const handlerProp = firstArg.getProperty('handler');

      if (
        !methodProp ||
        !urlProp ||
        !handlerProp
      ) {
        continue;
      }

      const methodValue = Node.isPropertyAssignment(methodProp)
        ? methodProp.getInitializer()
        : undefined;

      const urlValue = Node.isPropertyAssignment(urlProp)
        ? urlProp.getInitializer()
        : undefined;

      if (
        methodValue &&
        Node.isStringLiteral(methodValue) &&
        methodValue.getLiteralValue().toUpperCase() === 'POST' &&
        urlValue &&
        Node.isStringLiteral(urlValue) &&
        /webhook/i.test(urlValue.getLiteralValue())
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasRequestHandler(sf: SourceFile): boolean {
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    if (fn.isDefaultExport()) return true;

    const name = fn.getName();

    if (name && HANDLER_NAME_RE.test(name)) {
      return true;
    }
  }

  for (const statement of sf.getVariableStatements()) {
    if (!statement.isExported()) continue;

    for (const decl of statement.getDeclarations()) {
      if (HANDLER_NAME_RE.test(decl.getName())) {
        return true;
      }
    }
  }

  return hasRouteHandler(sf);
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
  if (/cashfree/i.test(text)) return 'cashfree';
  for (const candidate of ['razorpay', 'stripe', 'cashfree'] as const) {
    if (gateways.has(candidate)) return candidate;
  }
  return null;
}

function fixFor(gateway: Gateway | null): string {
  if (gateway === 'stripe') {
    return `Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)\` as the first statement in the handler, and return 400 if it throws. Read the raw body — a parsed body will not verify.`;
  }
  if (gateway === 'cashfree') {
    return `Concatenate the \`x-webhook-timestamp\` header with the raw body, HMAC it with \`crypto.createHmac('sha256', CASHFREE_CLIENT_SECRET)\`, base64 encode the digest, and compare it against \`x-webhook-signature\` before any business logic. Note Cashfree base64 encodes rather than hex, and signs timestamp plus body rather than the body alone.`;
  }
  return `Compute \`crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')\` and compare it against the \`x-razorpay-signature\` header with \`crypto.timingSafeEqual\` before touching any business logic.`;
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
  const hasWebhookRoute = hasRouteHandler(sf);
  const looksLikeWebhook = /webhook/i.test(ctx.relPath) || SIGNATURE_HEADER_RE.test(text) || hasWebhookRoute;

  if (!looksLikeWebhook) return [];
  if (!hasRequestHandler(sf)) return [];
  if (!readsRequestBody(sf)) return [];
  if (hasVerification(sf)) return [];

  const gateway = pickGateway(gateways, text);
  const gatewayName =
    gateway === 'stripe' ? 'Stripe' : gateway === 'cashfree' ? 'Cashfree' : 'Razorpay';

  return [
    buildFinding({
      rule: 'MP006',
      node: findAnchor(sf),
      ctx,
      confidence: 'confirmed',
      gateway,
      impact: `This handler acts on webhook payloads without verifying they came from ${gatewayName}. The endpoint is public, so anyone who guesses the URL can POST a fake \`payment.captured\` event and mark orders paid for free.`,
      fix: fixFor(gateway),
    }),
  ];
};

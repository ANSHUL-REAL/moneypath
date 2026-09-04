import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding, Gateway } from '../types';
import { getGatewayContext } from '../analysis/sinks';
import { buildFinding, type Detector } from './util';

const SIGNATURE_HEADER_RE =
  /x-razorpay-signature|stripe-signature|razorpay_signature|x-webhook-signature|x-webhook-timestamp/i;

const HANDLER_NAME_RE = /^(POST|PUT|handler|webhook|default)$/;

interface HandlerInfo {
  node: Node;
  text: string;
  route?: string;
}

/**
 * Find exported Next.js-style handlers.
 */
function findExportedHandlers(sf: SourceFile): HandlerInfo[] {
  const handlers: HandlerInfo[] = [];

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;

    const name = fn.getName();

    if (fn.isDefaultExport() || (name && HANDLER_NAME_RE.test(name))) {
      handlers.push({
        node: fn,
        text: fn.getText(),
      });
    }
  }

  for (const statement of sf.getVariableStatements()) {
    if (!statement.isExported()) continue;

    for (const decl of statement.getDeclarations()) {
      if (!HANDLER_NAME_RE.test(decl.getName())) continue;

      handlers.push({
        node: decl,
        text: decl.getText(),
      });
    }
  }

  return handlers;
}

/**
 * Find Express/Fastify webhook routes and keep
 * the route + handler together.
 */
function findWebhookRoutes(sf: SourceFile): HandlerInfo[] {
  const handlers: HandlerInfo[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression().getText();
    const args = call.getArguments();

    /*
     * Express:
     *
     * app.post('/webhooks/razorpay', handler)
     * router.post('/webhooks/stripe', handler)
     */
    if (/^(app|router)\.(post|put|use)$/.test(expression)) {
      const routeArg = args[0];

      if (!routeArg) continue;

      const route = routeArg
        .getText()
        .replace(/^['"`]|['"`]$/g, '');

      if (!/webhook/i.test(route)) continue;

      const handler = args.slice(1).find(
        (arg) =>
          arg.isKind(SyntaxKind.ArrowFunction) ||
          arg.isKind(SyntaxKind.FunctionExpression),
      );

      if (!handler) continue;

      handlers.push({
        node: handler,
        text: handler.getText(),
        route,
      });

      continue;
    }

    /*
     * Fastify:
     *
     * fastify.post('/webhooks/razorpay', handler)
     */
    if (expression === 'fastify.post') {
      const routeArg = args[0];

      if (!routeArg) continue;

      const route = routeArg
        .getText()
        .replace(/^['"`]|['"`]$/g, '');

      if (!/webhook/i.test(route)) continue;

      const handler = args.slice(1).find(
        (arg) =>
          arg.isKind(SyntaxKind.ArrowFunction) ||
          arg.isKind(SyntaxKind.FunctionExpression),
      );

      if (!handler) continue;

      handlers.push({
        node: handler,
        text: handler.getText(),
        route,
      });

      continue;
    }

    /*
     * Fastify route object:
     *
     * fastify.route({
     *   method: 'POST',
     *   url: '/webhooks/razorpay',
     *   handler: async (...) => {}
     * })
     */
    if (expression === 'fastify.route') {
      const config = args[0];

      if (!config || !Node.isObjectLiteralExpression(config)) {
        continue;
      }

      const configText = config.getText();

      const methodMatches =
        /method\s*:\s*['"`](POST|PUT)['"`]/i.test(configText);

      const routeMatch =
        /url\s*:\s*['"`]([^'"`]*)['"`]/i.exec(configText);

      /*
       * IMPORTANT:
       *
       * routeMatch may be undefined.
       * Use optional chaining so routeMatch[1]
       * is never accessed unsafely.
       */
      const route = routeMatch?.[1];

      if (!methodMatches || !route || !/webhook/i.test(route)) {
        continue;
      }

      const handlerProperty = config.getProperty('handler');

      if (!handlerProperty) continue;

      let handler: Node | undefined;

      if (Node.isPropertyAssignment(handlerProperty)) {
        const initializer = handlerProperty.getInitializer();

        if (
          initializer &&
          (initializer.isKind(SyntaxKind.ArrowFunction) ||
            initializer.isKind(SyntaxKind.FunctionExpression))
        ) {
          handler = initializer;
        }
      }

      if (!handler) continue;

      handlers.push({
        node: handler,
        text: handler.getText(),
        route,
      });
    }
  }

  return handlers;
}

/**
 * Does this handler read the incoming request body?
 */
function readsRequestBody(text: string): boolean {
  return (
    /\breq(uest)?\s*\.\s*(json|text|body|arrayBuffer)\b/i.test(text) ||
    /\brawBody\b/i.test(text) ||
    /\bbodyParser\b/i.test(text)
  );
}

/**
 * Detect gateway evidence only from the route and handler.
 *
 * An SDK import alone is not enough to prove that
 * a specific webhook belongs to that gateway.
 */
function pickGateway(
  gateways: Set<Gateway>,
  handlerText: string,
  route?: string,
): Gateway | null {
  const text = `${route ?? ''}\n${handlerText}`;

  if (/razorpay/i.test(text) && gateways.has('razorpay')) {
    return 'razorpay';
  }

  if (/stripe/i.test(text) && gateways.has('stripe')) {
    return 'stripe';
  }

  if (/cashfree/i.test(text) && gateways.has('cashfree')) {
    return 'cashfree';
  }

  return null;
}

/**
 * Gateway-specific remediation.
 */
function fixFor(gateway: Gateway): string {
  if (gateway === 'stripe') {
    return `Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)\` as the first statement in the handler, and return 400 if it throws. Read the raw body — a parsed body will not verify.`;
  }

  if (gateway === 'cashfree') {
    return `Concatenate the \`x-webhook-timestamp\` header with the raw body, HMAC it with \`crypto.createHmac('sha256', CASHFREE_CLIENT_SECRET)\`, base64 encode the digest, and compare it against \`x-webhook-signature\` before any business logic. Note Cashfree base64 encodes rather than hex, and signs timestamp plus body rather than the body alone.`;
  }

  return `Compute \`crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')\` and compare it against the \`x-razorpay-signature\` header with \`crypto.timingSafeEqual\` before touching any business logic.`;
}

/**
 * Check whether the specific handler performs
 * webhook/signature verification.
 */
function hasVerificationForText(text: string): boolean {
  const sdkVerification =
    /validateWebhookSignature|verifyPaymentSignature|verifyWebhookSignature|constructEvent|constructEventAsync|createHmac|timingSafeEqual|new\s+Webhook\s*\(/i;

  const helperVerification =
    /\b\w*(?:verif|valid|check|assert|ensure)\w*(?:signature|webhook|hmac)\w*\s*\(|\b\w*(?:signature|webhook|hmac)\w*(?:verif|valid|check)\w*\s*\(/i;

  return (
    sdkVerification.test(text) ||
    helperVerification.test(text)
  );
}

function gatewayName(gateway: Gateway): string {
  if (gateway === 'razorpay') return 'Razorpay';
  if (gateway === 'stripe') return 'Stripe';
  return 'Cashfree';
}

export const webhookSignatureDetector: Detector = (
  ctx,
): Finding[] => {
  const sf = ctx.sourceFile;

  /*
   * Collect payment gateway context at file level only
   * as a payment-code guard.
   *
   * Gateway context is NOT enough to classify an individual
   * handler as a payment webhook.
   */
  const gateways = getGatewayContext(sf);

  if (gateways.size === 0) {
    return [];
  }

  /*
   * Express/Fastify routes.
   *
   * Route and handler are analyzed together.
   *
   * This avoids false positives such as:
   *
   * Stripe SDK import
   * +
   * GitHub webhook
   * +
   * req.body
   *
   * becoming MP006.
   */
  const routes = findWebhookRoutes(sf);

  for (const route of routes) {
    const gateway = pickGateway(
      gateways,
      route.text,
      route.route,
    );

    if (!gateway) continue;

    if (!readsRequestBody(route.text)) continue;

    if (hasVerificationForText(route.text)) continue;

    return [
      buildFinding({
        rule: 'MP006',
        node: route.node,
        ctx,
        confidence: 'confirmed',
        gateway,
        impact:
          `This handler acts on webhook payloads without verifying ` +
          `they came from ${gatewayName(gateway)}. The endpoint is ` +
          `public, so anyone who guesses the URL can POST a fake ` +
          `\`payment.captured\` event and mark orders paid for free.`,
        fix: fixFor(gateway),
      }),
    ];
  }

  /*
   * Next.js / framework-style exported handlers.
   *
   * These handlers do not necessarily have an Express/Fastify
   * route call, so the file path can provide webhook evidence.
   */
  const handlers = findExportedHandlers(sf);

  for (const handler of handlers) {
    const handlerText = handler.text;

    if (!readsRequestBody(handlerText)) continue;

    /*
     * Webhook evidence must be associated with this handler.
     *
     * Accepted evidence:
     *
     * 1. webhook in the file path
     * 2. webhook in the handler
     * 3. a known webhook signature header in the handler
     */
    const looksLikeWebhook =
      /webhook/i.test(ctx.relPath) ||
      /webhook/i.test(handlerText) ||
      SIGNATURE_HEADER_RE.test(handlerText);

    if (!looksLikeWebhook) continue;

    /*
     * Gateway evidence must also belong to this handler/path.
     *
     * Do not use the entire file path as gateway evidence unless
     * the path actually contains "webhook".
     */
    const gateway = pickGateway(
      gateways,
      handlerText,
      /webhook/i.test(ctx.relPath)
        ? ctx.relPath
        : undefined,
    );

    if (!gateway) continue;

    if (hasVerificationForText(handlerText)) continue;

    return [
      buildFinding({
        rule: 'MP006',
        node: handler.node,
        ctx,
        confidence: 'confirmed',
        gateway,
        impact:
          `This handler acts on webhook payloads without verifying ` +
          `they came from ${gatewayName(gateway)}. The endpoint is ` +
          `public, so anyone who guesses the URL can POST a fake ` +
          `\`payment.captured\` event and mark orders paid for free.`,
        fix: fixFor(gateway),
      }),
    ];
  }

  return [];
};
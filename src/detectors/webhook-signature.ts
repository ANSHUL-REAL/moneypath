import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding, Gateway } from '../types';
import { getGatewayContext } from '../analysis/sinks';
import { buildFinding, hasVerification, type Detector } from './util';

const SIGNATURE_HEADER_RE =
  /x-razorpay-signature|stripe-signature|razorpay_signature|x-webhook-signature|x-webhook-timestamp/i;
const HANDLER_NAME_RE = /^(POST|PUT|handler|webhook|default)$/;

/** Anchor the finding on the request handler when we can find one. */
function findAnchor(sf: SourceFile, route: Node | null): Node {
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && HANDLER_NAME_RE.test(name)) return fn;
  }
  for (const decl of sf.getVariableDeclarations()) {
    if (HANDLER_NAME_RE.test(decl.getName())) return decl;
  }
  // A route registration is the handler in an Express or Fastify app, and
  // pointing at it beats falling through to whatever import happens to be
  // first in the file.
  if (route) return route;
  const exported = sf.getFirstDescendantByKind(SyntaxKind.ExportAssignment);
  return exported ?? sf.getStatements()[0] ?? sf;
}

/** Route-registration methods that can serve a webhook POST. */
const ROUTE_METHOD_RE = /^(post|use|all)$/;

/**
 * Read a route path argument as text, following same-file constants.
 *
 * `app.post(WEBHOOK_PATH, handler)` is as common as the inline literal, and a
 * template literal is how anyone with a URL prefix writes it. Bounded depth
 * because `const a = b; const b = a;` is legal enough to parse.
 */
function routePathText(node: Node | undefined, depth = 0): string | null {
  if (!node || depth > 3) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isTemplateExpression(node)) return node.getText();
  if (Node.isIdentifier(node)) {
    const initializer = node.getSourceFile().getVariableDeclaration(node.getText())?.getInitializer();
    if (initializer) return routePathText(initializer, depth + 1);
  }
  return null;
}

function isWebhookPath(node: Node | undefined): boolean {
  const text = routePathText(node);
  return text !== null && /webhook/i.test(text);
}

/** `'POST'` or `['POST', 'PUT']`, as Fastify's object form accepts both. */
function declaresPost(node: Node | undefined): boolean {
  if (!node) return false;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText().toUpperCase() === 'POST';
  }
  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().some((element) => declaresPost(element));
  }
  return false;
}

/**
 * Walk up the callee side of a chain, stopping at whatever consumes the value.
 *
 * `app.route('/x').post(h)` keeps going through the property access; sitting in
 * an argument list or on the right of an `await` does not, because that means
 * something is using the result rather than registering a route.
 */
function walkCallChain(call: Node, visit: (parent: Node) => boolean | undefined): boolean {
  let node: Node = call;
  for (let parent = node.getParent(); parent; parent = node.getParent()) {
    const verdict = visit(parent);
    if (verdict !== undefined) return verdict;

    const continuesChain =
      (Node.isPropertyAccessExpression(parent) || Node.isCallExpression(parent)) &&
      parent.getExpression() === node;
    if (!continuesChain) return false;

    node = parent;
  }
  return false;
}

/**
 * Is this call a route registration rather than an outbound request?
 *
 * `app.post('/webhooks/razorpay', handler)` is a statement whose value is
 * discarded. `await axios.post('/webhooks/razorpay', body)` posts *to* a
 * webhook and consumes the response. Both are `.post()` with a string path, so
 * once the receiver name stops being checked this is what tells them apart —
 * without it, a webhook relay or replay script reads as a vulnerable endpoint.
 */
function isRouteRegistration(call: Node): boolean {
  return walkCallChain(call, (parent) => (Node.isExpressionStatement(parent) ? true : undefined));
}

/** Express chained form: `app.route('/webhooks/razorpay').post(handler)`. */
function isChainedIntoRouteMethod(call: Node): boolean {
  return walkCallChain(call, (parent) =>
    Node.isPropertyAccessExpression(parent) && ROUTE_METHOD_RE.test(parent.getName().toLowerCase())
      ? true
      : undefined,
  );
}

/**
 * Does a route registration expose an HTTP webhook handler?
 *
 * Supports:
 *   app.post('/webhooks/razorpay', handler)
 *   router.post('/webhooks/razorpay', handler)
 *   app.use('/webhooks/razorpay', handler)
 *   fastify.post('/webhooks/razorpay', handler)
 *   app.route('/webhooks/razorpay').post(handler)
 *   fastify.route({
 *     method: 'POST',
 *     url: '/webhooks/razorpay',
 *     handler,
 *   })
 *
 * The receiver is deliberately not checked. `app`, `router`, `fastify`,
 * `server`, `api` and `expressApp` are all ordinary names, and the shape of the
 * call plus the `/webhook/i` test on the path does the real filtering.
 */
function findWebhookRoute(sf: SourceFile): Node | null {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();

    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (!isRouteRegistration(call)) continue;

    const method = expression.getName().toLowerCase();
    const args = call.getArguments();

    // Express / Router / Fastify:
    // app.post('/webhooks/razorpay', handler)
    if (ROUTE_METHOD_RE.test(method) && args.length >= 2 && isWebhookPath(args[0])) {
      return call;
    }

    if (method === 'route') {
      // Express chained form, where the path arrives one call earlier.
      if (isWebhookPath(args[0]) && isChainedIntoRouteMethod(call)) return call;

      // Fastify object form.
      const options = args[0];
      if (!options || !Node.isObjectLiteralExpression(options)) continue;
      if (!options.getProperty('handler')) continue;

      const methodProp = options.getProperty('method');
      const urlProp = options.getProperty('url');
      const methodValue =
        methodProp && Node.isPropertyAssignment(methodProp) ? methodProp.getInitializer() : undefined;
      const urlValue = urlProp && Node.isPropertyAssignment(urlProp) ? urlProp.getInitializer() : undefined;

      if (declaresPost(methodValue) && isWebhookPath(urlValue)) return call;
    }
  }

  return null;
}

/**
 * Does this file actually expose an HTTP handler?
 *
 * Without this check, any file that merely *discusses* webhooks — a security
 * util, a comment, a fix string in a scanner like this one — reads as a
 * vulnerable endpoint. Mentioning a header name is not the same as serving a
 * request.
 */
function hasRequestHandler(sf: SourceFile, hasWebhookRoute: boolean): boolean {
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

  return hasWebhookRoute;
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
  const webhookRoute = findWebhookRoute(sf);
  const looksLikeWebhook =
    /webhook/i.test(ctx.relPath) || SIGNATURE_HEADER_RE.test(text) || webhookRoute !== null;

  if (!looksLikeWebhook) return [];
  if (!hasRequestHandler(sf, webhookRoute !== null)) return [];
  if (!readsRequestBody(sf)) return [];
  if (hasVerification(sf)) return [];

  const gateway = pickGateway(gateways, text);
  const gatewayName =
    gateway === 'stripe' ? 'Stripe' : gateway === 'cashfree' ? 'Cashfree' : 'Razorpay';

  return [
    buildFinding({
      rule: 'MP006',
      node: findAnchor(sf, webhookRoute),
      ctx,
      confidence: 'confirmed',
      gateway,
      impact: `This handler acts on webhook payloads without verifying they came from ${gatewayName}. The endpoint is public, so anyone who guesses the URL can POST a fake \`payment.captured\` event and mark orders paid for free.`,
      fix: fixFor(gateway),
    }),
  ];
};

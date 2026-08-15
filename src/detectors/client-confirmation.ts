import type { Finding, Gateway } from '../types';
import { isClientComponent } from '../analysis/ast';
import { getGatewayContext } from '../analysis/sinks';
import {
  buildFinding,
  findPaidStatusWrites,
  hasVerification,
  readsRedirectParams,
  type Detector,
} from './util';

function pickGateway(gateways: Set<Gateway>): Gateway | null {
  if (gateways.has('razorpay')) return 'razorpay';
  if (gateways.has('stripe')) return 'stripe';
  return null;
}

/**
 * MP005 — an order is marked paid without the server ever confirming with the
 * gateway.
 *
 * Two shapes are reported, both of which reduce to "the browser said it paid,
 * so we believed it":
 *   a) the write happens in a `'use client'` file;
 *   b) the write happens in a server file driven by redirect parameters, with
 *      no signature check anywhere in that file.
 */
export const clientConfirmationDetector: Detector = (ctx): Finding[] => {
  const sf = ctx.sourceFile;
  const writes = findPaidStatusWrites(sf);
  if (writes.length === 0) return [];

  const gateways = getGatewayContext(sf);
  const viaRedirect = readsRedirectParams(sf);
  if (gateways.size === 0 && !viaRedirect) return [];

  const onClient = isClientComponent(sf);
  const unverifiedRedirect = !onClient && viaRedirect && !hasVerification(sf);
  if (!onClient && !unverifiedRedirect) return [];

  const gateway = pickGateway(gateways);

  return writes.map((write) =>
    buildFinding({
      rule: 'MP005',
      node: write.node,
      ctx,
      confidence: 'confirmed',
      gateway,
      title: onClient
        ? 'Order marked paid from browser code'
        : 'Order marked paid from an unverified redirect',
      impact: onClient
        ? `This write runs in the browser, where the user controls everything. Anyone can call it from the console and mark an order paid without money changing hands.`
        : `The handler trusts redirect parameters the browser supplied and never verifies them against ${gateway ?? 'the gateway'}. Forging that redirect URL marks any order paid.`,
      fix: onClient
        ? `Move the state change to the server and drive it from a signature-verified webhook. The browser may report success for UI purposes, but it must never be what writes the paid state.`
        : `Verify before you write. For Razorpay, HMAC the \`order_id|payment_id\` pair with your key secret and compare against \`razorpay_signature\`; for Stripe, retrieve the session server-side. Treat the redirect as a hint to refresh the UI, and let the webhook be the source of truth.`,
    }),
  );
};

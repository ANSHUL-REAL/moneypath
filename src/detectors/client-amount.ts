import type { Finding } from '../types';
import { traceClientTaint } from '../analysis/taint';
import { buildFinding, gatewayName, type Detector } from './util';

/**
 * MP001 — the amount sent to the gateway traces back to attacker-controlled input.
 *
 * This is the finding the whole tool exists for: if the server does not derive
 * the price from its own records, a single edited request buys anything at any
 * price.
 */
export const clientAmountDetector: Detector = (ctx): Finding[] => {
  const findings: Finding[] = [];

  for (const sink of ctx.sinks) {
    if (!sink.amountNode) continue;

    const taint = traceClientTaint(sink.amountNode);
    if (!taint.tainted) continue;

    const confidence = taint.viaOpaqueCall ? 'review' : 'confirmed';
    const name = gatewayName(sink.gateway);
    const impact = taint.viaOpaqueCall
      ? `The \`${sink.amountProp}\` sent to ${name} derives from ${taint.source}, but passes through a function this analyzer cannot see into. If that function does not re-price the order against the database, the customer sets their own price.`
      : `The \`${sink.amountProp}\` sent to ${name} is taken from ${taint.source} and never recomputed server-side. An attacker edits the request and pays whatever they like — one rupee for a ten thousand rupee order.`;

    findings.push(
      buildFinding({
        rule: 'MP001',
        node: sink.amountNode,
        ctx,
        confidence,
        gateway: sink.gateway,
        impact,
        fix: `Look the price up server-side. Accept only identifiers from the client (a product id, a cart id) and compute \`${sink.amountProp}\` from your own database rows before calling ${name}. Never accept a price, discount, quantity subtotal, or delivery fee as an input you trust.`,
        trace: taint.trace,
      }),
    );
  }

  return findings;
};

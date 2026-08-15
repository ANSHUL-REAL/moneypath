import { CallExpression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Gateway } from '../types';
import { findNestedPropertyValue, getPropertyValue } from './ast';

export type SinkKind =
  | 'razorpay-order'
  | 'stripe-payment-intent'
  | 'stripe-checkout-session';

export interface PaymentSink {
  gateway: Gateway;
  kind: SinkKind;
  call: CallExpression;
  /** The expression supplying the charged amount, when one is present. */
  amountNode: Node | undefined;
  /** Property name the gateway expects: `amount` or `unit_amount`. */
  amountProp: string;
  /** The options object literal passed to the call, when present. */
  options: Node | undefined;
}

/**
 * Which gateways this file actually talks to.
 *
 * This exists purely as a false-positive guard. Plenty of apps have their own
 * `orders.create(...)` service that has nothing to do with payments; without
 * this check every one of them would light up red.
 */
export function getGatewayContext(sf: SourceFile): Set<Gateway> {
  // The route path counts as evidence too: a vulnerable webhook at
  // `app/api/webhooks/razorpay/route.ts` may never spell the gateway's name in
  // its body, precisely because it does no verification.
  const haystack = `${sf.getFilePath()}\n${sf.getFullText()}`.toLowerCase();
  const gateways = new Set<Gateway>();
  if (haystack.includes('razorpay')) gateways.add('razorpay');
  if (haystack.includes('stripe')) gateways.add('stripe');
  return gateways;
}

export function findPaymentSinks(sf: SourceFile): PaymentSink[] {
  const context = getGatewayContext(sf);
  if (context.size === 0) return [];

  const sinks: PaymentSink[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText().replace(/\s+/g, '');
    const firstArg = call.getArguments()[0];
    const options =
      firstArg && Node.isObjectLiteralExpression(firstArg) ? firstArg : undefined;

    let kind: SinkKind | undefined;
    let gateway: Gateway | undefined;

    if (/(^|\.)orders\.create$/.test(callee) && context.has('razorpay')) {
      kind = 'razorpay-order';
      gateway = 'razorpay';
    } else if (/(^|\.)paymentIntents\.create$/.test(callee) && context.has('stripe')) {
      kind = 'stripe-payment-intent';
      gateway = 'stripe';
    } else if (/(^|\.)sessions\.create$/.test(callee) && context.has('stripe')) {
      kind = 'stripe-checkout-session';
      gateway = 'stripe';
    }

    if (!kind || !gateway) continue;

    const amountProp = kind === 'stripe-checkout-session' ? 'unit_amount' : 'amount';
    let amountNode: Node | undefined;
    if (options) {
      amountNode =
        kind === 'stripe-checkout-session'
          ? findNestedPropertyValue(options, 'unit_amount')
          : getPropertyValue(options, 'amount');
    }

    sinks.push({ gateway, kind, call, amountNode, amountProp, options });
  }

  return sinks;
}

import {
  CallExpression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { Gateway } from '../types';
import { findNestedPropertyValue, getPropertyValue } from './ast';

/** The property each gateway expects the charged amount in. */
const AMOUNT_PROP: Record<SinkKind, string> = {
  'razorpay-order': 'amount',
  'stripe-payment-intent': 'amount',
  'stripe-checkout-session': 'unit_amount',
  'cashfree-order': 'order_amount',
};

export type SinkKind =
  | 'razorpay-order'
  | 'stripe-payment-intent'
  | 'stripe-checkout-session'
  | 'cashfree-order';

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
  if (haystack.includes('cashfree')) gateways.add('cashfree');
  return gateways;
}

export function findPaymentSinks(sf: SourceFile): PaymentSink[] {
  const context = getGatewayContext(sf);
  if (context.size === 0) return [];

  const sinks: PaymentSink[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText().replace(/\s+/g, '');

    // Take the first object literal among the arguments rather than argument
    // zero: older Cashfree SDKs put an API version string first.
    const options = call
      .getArguments()
      .find((arg): arg is ObjectLiteralExpression => Node.isObjectLiteralExpression(arg));

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
    } else if (/(^|\.)PGCreateOrder$/.test(callee) && context.has('cashfree')) {
      kind = 'cashfree-order';
      gateway = 'cashfree';
    }

    if (!kind || !gateway) continue;

    const amountProp = AMOUNT_PROP[kind];
    let amountNode: Node | undefined;
    if (options) {
      amountNode =
        kind === 'stripe-checkout-session'
          ? findNestedPropertyValue(options, amountProp)
          : getPropertyValue(options, amountProp);
    }

    sinks.push({ gateway, kind, call, amountNode, amountProp, options });
  }

  return sinks;
}

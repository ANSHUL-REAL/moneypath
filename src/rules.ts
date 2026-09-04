import type { RuleId, Severity } from './types';

export interface RuleMeta {
  id: RuleId;
  slug: string;
  severity: Severity;
  title: string;
  /** Rendered in the HTML report as the rule's explainer. */
  description: string;
}

export const RULES: Record<RuleId, RuleMeta> = {
  MP001: {
    id: 'MP001',
    slug: 'client-controlled-amount',
    severity: 'critical',
    title: 'Payment amount comes from the client',
    description:
      'The amount handed to the payment gateway traces back to the HTTP request body or query string. ' +
      'The server never recomputes it from its own data, so whoever controls the browser controls the price.',
  },
  MP002: {
    id: 'MP002',
    slug: 'missing-minor-unit-conversion',
    severity: 'high',
    title: 'Amount is not converted to the gateway minor unit',
    description:
      'Razorpay bills in paise and Stripe bills in cents. Passing a rupee or dollar figure straight through ' +
      'charges the customer one hundredth of the intended price.',
  },
  MP003: {
    id: 'MP003',
    slug: 'unrounded-minor-unit-conversion',
    severity: 'high',
    title: 'Minor-unit conversion is not rounded',
    description:
      'Multiplying a floating point price by 100 produces values like 49999.00000000001. Gateways reject ' +
      'non-integer amounts, and naive truncation elsewhere in the flow silently loses money.',
  },
  MP004: {
    id: 'MP004',
    slug: 'double-minor-unit-conversion',
    severity: 'high',
    title: 'Amount is converted to the minor unit twice',
    description:
      'The value is multiplied by 100 more than once on its way to the gateway, overcharging the customer 100x.',
  },
  MP005: {
    id: 'MP005',
    slug: 'client-confirmed-payment',
    severity: 'critical',
    title: 'Payment marked successful without server-side verification',
    description:
      'An order is flipped to a paid state from browser code or from an unverified redirect. Anyone can ' +
      'replay that call and receive goods without paying.',
  },
  MP007: {
    id: 'MP007',
    slug: 'unnecessary-minor-unit-conversion',
    severity: 'high',
    title: 'Amount converted to minor units for a gateway that bills in major units',
    description:
      'Cashfree takes a decimal amount in rupees, not an integer count of paise. Multiplying by 100 ' +
      'before handing it over charges the customer one hundred times the intended price.',
  },
    MP008: {
    id: 'MP008',
    slug: 'unvalidated-client-quantity',
    severity: 'critical',
    title: 'Client quantity is not validated before price calculation',
    description:
      'A quantity derived from client input is multiplied into a value that reaches a payment gateway without a visible validation guard. ' +
      'Negative, zero, fractional, or otherwise invalid quantities can alter the amount charged.',
  },
  MP006: {
    id: 'MP006',
    slug: 'unverified-webhook',
    severity: 'critical',
    title: 'Payment webhook does not verify its signature',
    description:
      'The handler acts on webhook payloads without checking the gateway signature, so a forged POST can mark ' +
      'any order paid.',
  },
  
};

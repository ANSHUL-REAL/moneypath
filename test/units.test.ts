import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { findPaymentSinks } from '../src/analysis/sinks';
import { clientAmountDetector } from '../src/detectors/client-amount';
import { clientConfirmationDetector } from '../src/detectors/client-confirmation';
import { currencyUnitDetector } from '../src/detectors/currency-units';
import { webhookSignatureDetector } from '../src/detectors/webhook-signature';
import type { DetectorContext } from '../src/detectors/util';
import type { Finding, RuleId } from '../src/types';

function analyze(code: string, filePath = '/app/api/checkout/route.ts'): Finding[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      noLib: true,
      noResolve: true,
    },
  });
  const sourceFile = project.createSourceFile(filePath, code);
  const ctx: DetectorContext = {
    sourceFile,
    relPath: filePath.replace(/^\//, ''),
    sinks: findPaymentSinks(sourceFile),
  };
  return [
    ...clientAmountDetector(ctx),
    ...currencyUnitDetector(ctx),
    ...clientConfirmationDetector(ctx),
    ...webhookSignatureDetector(ctx),
  ];
}

const rules = (findings: Finding[]): RuleId[] => findings.map((f) => f.rule);

const RAZORPAY_HEAD = `import Razorpay from 'razorpay';
const razorpay = new Razorpay({ key_id: 'k', key_secret: 's' });
`;

describe('minor-unit conversion', () => {
  it('accepts a rounded single conversion', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      const total = 10;
      razorpay.orders.create({ amount: Math.round(total * 100), currency: 'INR' });
    `);
    expect(rules(found)).toEqual([]);
  });

  it('accepts an integer literal times 100', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      razorpay.orders.create({ amount: 499 * 100, currency: 'INR' });
    `);
    expect(rules(found)).toEqual([]);
  });

  it('accepts a value already named in paise', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      const amountInPaise = 49900;
      razorpay.orders.create({ amount: amountInPaise, currency: 'INR' });
    `);
    expect(rules(found)).toEqual([]);
  });

  it('flags an unrounded conversion of a variable', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      const total = 10.5;
      razorpay.orders.create({ amount: total * 100, currency: 'INR' });
    `);
    expect(rules(found)).toContain('MP003');
    expect(found[0]!.confidence).toBe('review');
  });

  it('confirms an unrounded conversion of a float literal', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      razorpay.orders.create({ amount: 1499.99 * 100, currency: 'INR' });
    `);
    const mp003 = found.find((f) => f.rule === 'MP003');
    expect(mp003?.confidence).toBe('confirmed');
  });

  it('flags a doubled conversion', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      const total = 10;
      razorpay.orders.create({ amount: Math.round(total * 100) * 100, currency: 'INR' });
    `);
    expect(rules(found)).toContain('MP004');
  });

  it('flags a rupee-looking literal with no conversion', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      razorpay.orders.create({ amount: 499, currency: 'INR' });
    `);
    expect(rules(found)).toContain('MP002');
  });

  it('leaves a large integer alone — it may already be paise', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      razorpay.orders.create({ amount: 49900, currency: 'INR' });
    `);
    expect(rules(found)).toEqual([]);
  });
});

describe('client-controlled amount', () => {
  it('traces through object destructuring', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      export async function POST(request: Request) {
        const { amount } = await request.json();
        return razorpay.orders.create({ amount, currency: 'INR' });
      }
    `);
    const mp001 = found.find((f) => f.rule === 'MP001');
    expect(mp001?.confidence).toBe('confirmed');
  });

  it('traces through an intermediate alias', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      export async function POST(req) {
        const body = req.body;
        const price = body.price;
        return razorpay.orders.create({ amount: price, currency: 'INR' });
      }
    `);
    expect(rules(found)).toContain('MP001');
  });

  it('does not flag a price loaded from the database', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      import { prisma } from './db';
      export async function POST(request: Request) {
        const { productId } = await request.json();
        const product = await prisma.product.findUnique({ where: { id: productId } });
        const amountInPaise = Math.round(product.priceRupees * 100);
        return razorpay.orders.create({ amount: amountInPaise, currency: 'INR' });
      }
    `);
    expect(rules(found)).toEqual([]);
  });

  it('downgrades to review when the value crosses an unknown function', () => {
    const found = analyze(`${RAZORPAY_HEAD}
      import { computeTotal } from './cart';
      export async function POST(request: Request) {
        const { items } = await request.json();
        const total = computeTotal(items);
        return razorpay.orders.create({ amount: total, currency: 'INR' });
      }
    `);
    const mp001 = found.find((f) => f.rule === 'MP001');
    expect(mp001?.confidence).toBe('review');
  });
});

describe('scope guards', () => {
  it('ignores orders.create when no gateway is present', () => {
    const found = analyze(`
      import { prisma } from './db';
      const orders = { create: async (i) => prisma.order.create({ data: i }) };
      export async function place(req) {
        return orders.create({ amount: req.body.amount });
      }
    `, '/lib/orders.ts');
    expect(rules(found)).toEqual([]);
  });

  it('ignores a module that merely discusses webhook signatures', () => {
    // Regression: moneypath's own detector source was flagged as a vulnerable
    // webhook because it contains the string `razorpay_signature` in advice
    // text. Talking about a header is not serving a request.
    const found = analyze(`
      export const ADVICE = {
        razorpay: 'compare against the razorpay_signature field',
        stripe: 'verify the stripe-signature header',
      };
      export function describeWebhookRisk(gateway: string) {
        return ADVICE[gateway];
      }
    `, '/lib/security-advice.ts');
    expect(rules(found)).toEqual([]);
  });

  it('ignores a webhook-named file with no request handler', () => {
    const found = analyze(`
      import Razorpay from 'razorpay';
      export const WEBHOOK_EVENTS = ['payment.captured', 'payment.failed'];
      export function isPaymentEvent(name: string) {
        return WEBHOOK_EVENTS.includes(name);
      }
    `, '/lib/webhook-events.ts');
    expect(rules(found)).toEqual([]);
  });

  it('ignores a non-payment webhook', () => {
    const found = analyze(`
      export async function POST(request: Request) {
        const event = await request.json();
        return Response.json({ received: event.type });
      }
    `, '/app/api/webhooks/github/route.ts');
    expect(rules(found)).toEqual([]);
  });
});

describe('webhook signature', () => {
  it('flags a payment webhook with no verification', () => {
    const found = analyze(`
      import { prisma } from './db';
      export async function POST(request: Request) {
        const event = await request.json();
        await prisma.order.update({ where: { id: event.id }, data: { status: 'paid' } });
        return Response.json({ ok: true });
      }
    `, '/app/api/webhooks/razorpay/route.ts');
    expect(rules(found)).toContain('MP006');
  });

  it('accepts a webhook that verifies with an HMAC', () => {
    const found = analyze(`
      import crypto from 'node:crypto';
      export async function POST(request: Request) {
        const raw = await request.text();
        const sig = request.headers.get('x-razorpay-signature');
        const expected = crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
        if (expected !== sig) return new Response('no', { status: 400 });
        return Response.json({ ok: true });
      }
    `, '/app/api/webhooks/razorpay/route.ts');
    expect(rules(found)).toEqual([]);
  });

  it('accepts a Stripe webhook using constructEvent', () => {
    const found = analyze(`
      import Stripe from 'stripe';
      const stripe = new Stripe('sk');
      export async function POST(request: Request) {
        const raw = await request.text();
        const event = stripe.webhooks.constructEvent(raw, request.headers.get('stripe-signature'), 'whsec');
        return Response.json({ type: event.type });
      }
    `, '/app/api/webhooks/stripe/route.ts');
    expect(rules(found)).toEqual([]);
  });

  it('flags an Express payment webhook with no verification', () => {
    const found = analyze(`
      import express from 'express';

      const app = express();

      app.post('/webhooks/razorpay', async (req, res) => {
        const event = req.body;
        await markOrderPaid(event.payload.payment.entity.notes.order_id);
        res.json({ ok: true });
      });
    `, '/app/webhooks/razorpay.ts');

    expect(rules(found)).toContain('MP006');
  });

  it('accepts an Express payment webhook with verification', () => {
    const found = analyze(`
      import express from 'express';
      import crypto from 'node:crypto';

      const app = express();

      app.post('/webhooks/razorpay', async (req, res) => {
        const event = req.body;
        const signature = req.headers['x-razorpay-signature'];

        const expected = crypto
          .createHmac('sha256', 'secret')
          .update(JSON.stringify(event))
          .digest('hex');

        if (expected !== signature) {
          return res.status(400).json({ ok: false });
        }

        res.json({ ok: true });
      });
    `, '/app/webhooks/razorpay.ts');

    expect(rules(found)).not.toContain('MP006');
  });

  it('flags a Fastify payment webhook with no verification', () => {
    const found = analyze(`
      import Fastify from 'fastify';

      const fastify = Fastify();

      fastify.post('/webhooks/razorpay', async (request, reply) => {
        const event = request.body;
        await markOrderPaid(event.payload.payment.entity.notes.order_id);
        return reply.send({ ok: true });
      });
    `, '/app/webhooks/razorpay.ts');

    expect(rules(found)).toContain('MP006');
  });

  it('flags a Fastify object-form payment webhook with no verification', () => {
    const found = analyze(`
      import Fastify from 'fastify';

      const fastify = Fastify();

      fastify.route({
        method: 'POST',
        url: '/webhooks/razorpay',
        handler: async (request, reply) => {
          const event = request.body;
          await markOrderPaid(event.payload.payment.entity.notes.order_id);
          return reply.send({ ok: true });
        },
      });
    `, '/app/webhooks/razorpay.ts');

    expect(rules(found)).toContain('MP006');
  });

  it('ignores a non-payment Express webhook', () => {
    const found = analyze(`
      import express from 'express';

      const app = express();

      app.post('/webhooks/github', async (req, res) => {
        const event = req.body;
        console.log(event);
        res.json({ ok: true });
      });
    `, '/app/webhooks/github.ts');

    expect(rules(found)).not.toContain('MP006');
  });
});

describe('client-side confirmation', () => {
  it('flags a paid write in a client component', () => {
    const found = analyze(`'use client';
      import { useSearchParams } from 'next/navigation';
      import { supabase } from './supabase';
      export default function Page() {
        c~onst searchParams = useSearchParams();
        const id = searchParams.get('razorpay_order_id');
        void supabase.from('orders').update({ status: 'paid' }).eq('id', id);
        return null;
      }
    `, '/app/success/page.tsx');
    expect(rules(found)).toContain('MP005');
  });

  it('ignores presentation state that merely mentions a paid status', () => {
    const found = analyze(`'use client';
      const BADGES = [{ status: 'paid', label: 'Paid' }];
      export function RazorpayBadge() {
        return BADGES[0].label;
      }
    `, '/components/badge.tsx');
    expect(rules(found)).toEqual([]);
  });
});

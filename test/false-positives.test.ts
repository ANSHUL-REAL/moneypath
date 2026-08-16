import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { findPaymentSinks } from '../src/analysis/sinks';
import { clientAmountDetector } from '../src/detectors/client-amount';
import { clientConfirmationDetector } from '../src/detectors/client-confirmation';
import { currencyUnitDetector } from '../src/detectors/currency-units';
import { webhookSignatureDetector } from '../src/detectors/webhook-signature';
import type { DetectorContext } from '../src/detectors/util';

function analyze(code: string, filePath = '/app/page.tsx'): string[] {
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
  ].map((f) => f.rule);
}

/**
 * Correct code that must stay silent.
 *
 * Every case here was a real false positive, found by attacking the detectors
 * with ordinary correct code rather than by imagining what might break. They
 * are kept as regressions because each one is a way a user would have been
 * wrongly accused, which is the failure this project cannot afford.
 *
 * MP005 fired on `setOrder(...)` and `setPlan(...)` because the mutation check
 * matched "set" as a substring, and on `dispatch(...)` because it contains
 * "patch". MP006 fired on webhooks that extract signature checking into a
 * helper, punishing exactly the people who did the right thing.
 */
describe('false positives on correct code', () => {
  it('React state setter holding a paid status', () => {
    expect(
      analyze(`'use client';
        import { useState } from 'react';
        export function RazorpayPanel() {
          const [order, setOrder] = useState(null);
          function onDone() {
            setOrder({ status: 'paid', id: 1 });
          }
          return null;
        }
      `),
    ).toEqual([]);
  });

  it('a reducer dispatch describing a paid order', () => {
    expect(
      analyze(`'use client';
        export function RazorpayReducerView({ dispatch }) {
          dispatch({ type: 'ORDER', payload: { status: 'paid' } });
          return null;
        }
      `),
    ).toEqual([]);
  });

  it('a subscription set to active in browser UI state', () => {
    expect(
      analyze(`'use client';
        import { useState } from 'react';
        export function StripeBadge() {
          const [, setPlan] = useState(null);
          setPlan({ status: 'active' });
          return null;
        }
      `),
    ).toEqual([]);
  });

  it('MP006: webhook that verifies via an imported helper', () => {
    expect(
      analyze(`
        import { verifyRazorpaySignature } from '../../lib/verify';
        export async function POST(request: Request) {
          const raw = await request.text();
          const sig = request.headers.get('x-razorpay-signature');
          if (!verifyRazorpaySignature(raw, sig)) {
            return new Response('bad signature', { status: 400 });
          }
          return Response.json({ ok: true });
        }
      `, '/app/api/webhooks/razorpay/route.ts'),
    ).toEqual([]);
  });

  it('MP006: webhook guarded by a checkWebhookSignature helper', () => {
    expect(
      analyze(`
        import { assertWebhookSignature } from '../../lib/security';
        export async function POST(request: Request) {
          const raw = await request.text();
          assertWebhookSignature(raw, request.headers.get('x-razorpay-signature'));
          return Response.json({ ok: true });
        }
      `, '/app/api/webhooks/razorpay/route.ts'),
    ).toEqual([]);
  });

  it('MP006: a non-webhook Stripe route that reads a body', () => {
    expect(
      analyze(`
        import Stripe from 'stripe';
        const stripe = new Stripe('sk');
        export async function POST(request: Request) {
          const { priceId } = await request.json();
          return Response.json({ priceId });
        }
      `, '/app/api/stripe/create-session/route.ts'),
    ).toEqual([]);
  });

  it('MP002: an amount already named in paise, read from an order row', () => {
    expect(
      analyze(`
        import Razorpay from 'razorpay';
        import { prisma } from './db';
        const razorpay = new Razorpay({ key_id: 'k', key_secret: 's' });
        export async function POST(request: Request) {
          const { orderId } = await request.json();
          const order = await prisma.order.findUnique({ where: { id: orderId } });
          return razorpay.orders.create({ amount: order.amountInPaise, currency: 'INR' });
        }
      `, '/app/api/checkout/route.ts'),
    ).toEqual([]);
  });

  it('a test factory building a paid order fixture', () => {
    expect(
      analyze(`
        import { prisma } from './db';
        export function makeRazorpayOrder() {
          return prisma.order.create({ data: { status: 'paid', amount: 100 } });
        }
      `, '/test/factories.ts'),
    ).toEqual([]);
  });
});

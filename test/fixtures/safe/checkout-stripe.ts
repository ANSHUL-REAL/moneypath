// Correct Stripe Checkout session. Price comes from the database, rounded once.
import Stripe from 'stripe';
import { prisma } from './db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request) {
  const { planId } = await request.json();

  const plan = await prisma.plan.findFirst({ where: { id: planId } });
  if (!plan) return new Response('Not found', { status: 404 });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(plan.priceUsd * 100),
          product_data: { name: plan.name },
        },
      },
    ],
    success_url: 'https://example.com/success',
    cancel_url: 'https://example.com/cancel',
  });

  return Response.json({ url: session.url });
}

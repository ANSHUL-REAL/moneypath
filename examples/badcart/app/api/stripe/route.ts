// MP003 — float arithmetic on the way to Stripe.
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  const paymentIntent = await stripe.paymentIntents.create({
    // 1499.99 * 100 is 149998.99999999999, not 149999.
    amount: 1499.99 * 100,
    currency: 'usd',
  });

  return Response.json({ clientSecret: paymentIntent.client_secret });
}

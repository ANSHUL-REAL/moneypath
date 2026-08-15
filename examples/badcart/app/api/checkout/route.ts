// MP001 + MP002 — the checkout takes the price straight from the browser.
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function POST(request: Request) {
  const body = await request.json();

  // The client tells us what to charge. It is never checked against anything.
  const { amount, productId } = body;

  const order = await razorpay.orders.create({
    amount,
    currency: 'INR',
    receipt: `rcpt_${productId}`,
  });

  return Response.json({ orderId: order.id });
}

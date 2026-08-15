// Correct Razorpay checkout. The client picks a product; the server prices it.
import Razorpay from 'razorpay';
import { prisma } from './db';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function POST(request: Request) {
  const { productId } = await request.json();

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return new Response('Not found', { status: 404 });

  const amountInPaise = Math.round(product.priceRupees * 100);

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `rcpt_${product.id}`,
  });

  return Response.json({ orderId: order.id });
}

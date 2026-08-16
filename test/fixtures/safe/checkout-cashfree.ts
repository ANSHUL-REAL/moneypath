// Correct Cashfree checkout. The amount is a plain decimal in rupees, loaded
// from the database. No conversion, because Cashfree does not want one.
//
// This fixture matters: the paise conversion that MP002 demands for Razorpay
// would be a 100x overcharge here, so the currency rules must invert.
import { Cashfree } from 'cashfree-pg';
import { prisma } from './db';

export async function POST(request: Request) {
  const { productId } = await request.json();

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return new Response('Not found', { status: 404 });

  const order = await Cashfree.PGCreateOrder({
    order_amount: product.priceRupees,
    order_currency: 'INR',
    order_id: `order_${product.id}`,
    customer_details: {
      customer_id: product.ownerId,
      customer_phone: product.ownerPhone,
    },
  });

  return Response.json({ orderId: order.data.order_id });
}

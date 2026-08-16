// The correct version of the same flow. The client picks the product; the
// server prices it. Cross-file tracing must stay silent here.
import { prisma } from '../lib/db';
import { createOrder } from '../lib/payments';

export async function POST(request: Request) {
  const { productId } = await request.json();

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return new Response('Not found', { status: 404 });

  const order = await createOrder(Math.round(product.priceRupees * 100), product.id);

  return Response.json({ orderId: order.id });
}

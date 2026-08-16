// A different `createOrder` that has nothing to do with payments. It is local
// to this file and never imported from lib/payments, so matching on the name
// alone would produce a false accusation here.
import { prisma } from './db';

async function createOrder(amount: number) {
  return prisma.order.create({ data: { amount } });
}

export async function POST(request: Request) {
  const { amount } = await request.json();
  return createOrder(amount);
}

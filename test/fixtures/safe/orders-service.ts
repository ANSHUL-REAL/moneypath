// An `orders.create` that has nothing to do with payments.
// The analyzer must ignore this: no payment gateway is involved anywhere.
import { prisma } from './db';

export const orders = {
  create: async (input: { userId: string; total: number }) =>
    prisma.order.create({ data: input }),
};

export async function placeOrder(userId: string, total: number) {
  return orders.create({ amount: total, userId, total });
}

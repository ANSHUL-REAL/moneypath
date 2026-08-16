// The bug lives here: the client's number is handed straight to the helper.
// Neither file looks wrong in isolation, which is exactly why this is missed.
import { createOrder } from '../lib/payments';

export async function POST(request: Request) {
  const { amount, receipt } = await request.json();

  const order = await createOrder(amount, receipt);

  return Response.json({ orderId: order.id });
}

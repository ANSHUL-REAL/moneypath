// Correct Razorpay webhook: verify first, act second.
import crypto from 'node:crypto';
import { prisma } from './db';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return new Response('invalid signature', { status: 400 });
  }

  const event = JSON.parse(rawBody);
  if (event.event === 'payment.captured') {
    await prisma.order.update({
      where: { id: event.payload.payment.entity.notes.order_id },
      data: { status: 'paid' },
    });
  }

  return Response.json({ ok: true });
}

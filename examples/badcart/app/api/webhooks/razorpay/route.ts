// MP006 — a Razorpay webhook that never checks the signature.
import { supabase } from '../../../../lib/supabase';

export async function POST(request: Request) {
  const event = await request.json();

  // Anyone who can reach this URL can post this exact payload.
  if (event.event === 'payment.captured') {
    await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('id', event.payload.payment.entity.notes.order_id);
  }

  return Response.json({ ok: true });
}

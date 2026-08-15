// MP005 — the browser decides that the order was paid.
'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../lib/supabase';

export default function PaymentSuccessPage() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const orderId = searchParams.get('order_id');
    const paymentId = searchParams.get('razorpay_payment_id');
    if (!orderId || !paymentId) return;

    // Runs in the browser. Anyone can call it from the console with any order id.
    void supabase.from('orders').update({ status: 'paid' }).eq('id', orderId);
  }, [searchParams]);

  return <p>Thanks! Your payment was successful.</p>;
}

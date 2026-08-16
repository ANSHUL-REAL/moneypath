// MP007 — converting to paise for a gateway that bills in rupees.
//
// This is the mirror image of the Razorpay bug in pricing.ts. Cashfree takes a
// decimal rupee amount, so multiplying by 100 here bills the customer 100x.
import { Cashfree } from 'cashfree-pg';

export async function createCashfreeOrder(totalRupees: number, customerId: string) {
  return Cashfree.PGCreateOrder({
    order_amount: totalRupees * 100,
    order_currency: 'INR',
    customer_details: {
      customer_id: customerId,
      customer_phone: '9999999999',
    },
  });
}

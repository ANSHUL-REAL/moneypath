// MP004 — the total is converted to paise twice.
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

/** `totalRupees` is already in rupees, so this bills the customer 100x. */
export async function createOrderForTotal(totalRupees: number) {
  return razorpay.orders.create({
    amount: Math.round(totalRupees * 100) * 100,
    currency: 'INR',
  });
}

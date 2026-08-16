// Same wrapper shape as the vulnerable fixture. Identical code.
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function createOrder(amountInPaise: number, receipt: string) {
  return razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt,
  });
}

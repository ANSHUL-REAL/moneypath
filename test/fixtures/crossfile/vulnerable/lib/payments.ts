// The gateway call lives here, wrapped in a helper. Nothing in this file is
// wrong on its own: `amountInPaise` is just a parameter.
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

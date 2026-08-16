// A real wrapper, but nothing ever calls it with client data.
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function createOrder(amountInPaise: number) {
  return razorpay.orders.create({ amount: amountInPaise, currency: 'INR' });
}

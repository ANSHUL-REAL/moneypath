import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: 'test',
  key_secret: 'test',
});

// 1. Number.isInteger + positive guard
export async function integerGuard(req: any) {
  const { quantity } = await req.json();

  if (!Number.isInteger(quantity) || quantity < 1) {
    return new Response('Invalid quantity', { status: 400 });
  }

  const product = await getProduct();
  const amount = product.price * quantity;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

// 2. Normalisation to a positive integer
export async function normalisedQuantity(req: any) {
  const { quantity } = await req.json();

  const qty = Math.max(1, Math.floor(Number(quantity)));

  const product = await getProduct();
  const amount = product.price * qty;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

// 3. Schema parse
export async function schemaParse(req: any) {
  const body = await req.json();
  const { quantity } = schema.parse(body);

  const product = await getProduct();
  const amount = product.price * quantity;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

// 4. Schema safeParse
export async function schemaSafeParse(req: any) {
  const body = await req.json();
  const result = schema.safeParse(body);

  if (!result.success) {
    return new Response('Invalid quantity', { status: 400 });
  }

  const product = await getProduct();
  const amount = product.price * result.data.quantity;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

// 5. Schema validate
export async function schemaValidate(req: any) {
  const body = await req.json();
  const { quantity } = await schema.validate(body);

  const product = await getProduct();
  const amount = product.price * quantity;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

// 6. Explicit rejection of zero/negative quantities
export async function explicitGuard(req: any) {
  const { quantity } = await req.json();

  if (quantity <= 0) {
    return new Response('Invalid quantity', { status: 400 });
  }

  const product = await getProduct();
  const amount = product.price * quantity;

  return razorpay.orders.create({
    amount,
    currency: 'INR',
  });
}

async function getProduct() {
  return { price: 1000 };
}

const schema = {
  parse(value: any) {
    return value;
  },
  safeParse(value: any) {
    return { success: true, data: value };
  },
  validate(value: any) {
    return Promise.resolve(value);
  },
};
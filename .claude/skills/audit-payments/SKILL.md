---
name: audit-payments
description: Audit a Razorpay or Stripe checkout for payment logic flaws — amounts trusted from the client instead of computed server-side, rupee/paise and dollar/cent conversion bugs, orders marked paid by browser code, and webhooks that skip signature verification. Use when reviewing or changing checkout code, before shipping anything that calls a payment gateway, or when the user mentions Razorpay, Stripe, checkout, payments, billing, or orders.
---

# Auditing a checkout for payment logic flaws

Run the analyzer, then act on what it reports. Do not hand-review payment code first —
the tool traces data paths across a whole repository faster and more consistently than
reading files does, and its output tells you where to focus.

## Run it

```bash
npx -y moneypath <path> --json
```

`<path>` is the project root, or the server directory in a monorepo. It needs no install,
no config, no network, and no `node_modules` in the target project.

For a shareable artifact, add `--html report.html`.

## Read the output

Each finding carries `rule`, `severity`, `confidence`, `file`, `line`, `trace`, `impact`
and `fix`.

`confidence` is the field that decides how you speak about it:

- **`confirmed`** — the full path was traced. State it as a fact and fix it.
- **`review`** — the pattern matched but intent needs judgement, usually because the value
  crossed a function the analyzer could not see into. **Open the file and check before
  telling the user it is a bug.** Follow the call it could not resolve and decide whether
  the amount is genuinely recomputed server-side.

Never report a `review` finding as confirmed. Precision is the whole value of this tool.

## The rules

| Rule | Meaning | Typical fix |
| --- | --- | --- |
| MP001 | Amount comes from the request, never recomputed | Accept a product/cart id only; price it from the database |
| MP002 | Missing minor-unit conversion | `Math.round(total * 100)` — Razorpay bills paise, Stripe bills cents |
| MP003 | Unrounded conversion | Wrap in `Math.round`; better, store integer minor units throughout |
| MP004 | Doubled conversion | Convert exactly once, at the gateway boundary |
| MP005 | Browser or unverified redirect marks the order paid | Move the write server-side, drive it from a verified webhook |
| MP006 | Webhook does not verify its signature | Verify before any business logic; return 400 on failure |

## Fixing MP001

The correct shape, which the analyzer recognises as safe:

```ts
const { productId } = await request.json();               // client picks the row
const product = await prisma.product.findUnique({ where: { id: productId } });
if (!product) return new Response('Not found', { status: 404 });

const amountInPaise = Math.round(product.priceRupees * 100); // server owns the price
await razorpay.orders.create({ amount: amountInPaise, currency: 'INR' });
```

The client may choose *what* is being bought. It must never state *what it costs* — not
the price, not the discount, not the delivery fee, not the line-item subtotal.

While fixing MP001, also check the neighbouring authorization question the analyzer does
not cover: does the requesting user actually own the cart or order being priced?

## After fixing

Re-run to confirm the finding is gone, and add it to CI so it cannot come back:

```bash
npx moneypath --sarif moneypath.sarif --fail-on critical
```

## Boundaries

A clean run means these six bugs are absent — not that the checkout is secure. The tool
knows only Razorpay and Stripe, traces about four hops, and does not look at
authorization, injection, rate limiting, or idempotency. Say so rather than implying a
clean scan is a guarantee.

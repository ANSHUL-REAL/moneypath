# badcart

A deliberately broken checkout. Every file here contains a real payment bug that
has shipped to production somewhere, more than once.

Do not copy any of it.

```bash
npx moneypath examples/badcart
```

| File | Rule | Bug |
| --- | --- | --- |
| `app/api/checkout/route.ts` | MP001, MP002 | Price taken from the request body, and never converted to paise |
| `app/api/stripe/route.ts` | MP003 | `1499.99 * 100` is `149998.99999999999` |
| `lib/pricing.ts` | MP004 | Rupees converted to paise twice — bills 100x |
| `lib/cashfree.ts` | MP007 | Converted to paise for Cashfree, which bills in rupees — bills 100x |
| `app/payment-success/page.tsx` | MP005 | Browser code marks the order paid |
| `app/api/webhooks/razorpay/route.ts` | MP006 | Webhook acts on unverified payloads |

It is used as moneypath's own test fixture, so the findings above are asserted
in CI. If a change stops one of them from being reported, the build fails.

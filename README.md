<div align="center">

<img src="assets/mark.svg" alt="" width="76" height="76">

# moneypath

**Your checkout trusts the browser. This tells you where.**

A static analyzer that finds payment logic flaws in Razorpay and Stripe integrations —
the class of bug that lets a customer pay ₹1 for a ₹10,000 order.

[![npm](https://img.shields.io/npm/v/moneypath.svg)](https://www.npmjs.com/package/moneypath)
[![CI](https://github.com/ANSHUL-REAL/moneypath/actions/workflows/ci.yml/badge.svg)](https://github.com/ANSHUL-REAL/moneypath/actions)
[![license](https://img.shields.io/npm/l/moneypath.svg)](./LICENSE)

</div>

```bash
npx moneypath
```

No install, no account, no config, no network. It reads your source and exits.

---

## Why I built this

I shipped a checkout that trusted the browser for the delivery fee. The server took
whatever number arrived and handed it to Razorpay. Recomputing it server-side was a
small fix — noticing it was the hard part.

So I went looking for something that would have caught it, and there wasn't anything.
Generic scanners see a valid POST with valid parameters and move on. Plenty of people
will tell you not to trust the client; nobody had written the thing that checks whether
you did.

So: this. Narrow on purpose — one class of bug, done without lying to you.

## Why generic scanners miss this

Generic security scanners cannot find payment bugs. They see a structurally valid
`POST /api/checkout` with well-formed parameters and move on. The flaw is not in the
syntax — it is in *where the number came from*.

So these ship, constantly:

```js
// The client tells the server what to charge.
const { amount } = await request.json();
await razorpay.orders.create({ amount, currency: 'INR' });
```

One edited request and the order costs whatever the attacker types.

moneypath traces the amount backwards from the gateway call to its source, and tells
you when that source is the browser.

## What it finds

| Rule | Severity | Flaw |
| --- | --- | --- |
| **MP001** | Critical | Payment amount comes from the request body or query string, never recomputed server-side |
| **MP002** | High | Amount not converted to the gateway minor unit — Razorpay bills **paise**, Stripe bills **cents**, so a rupee figure collects 1/100th of the price |
| **MP003** | High | Minor-unit conversion not rounded — `1499.99 * 100` is `149998.99999999999`, which gateways reject |
| **MP004** | High | Amount converted twice — bills the customer 100x |
| **MP005** | Critical | Order marked paid by browser code or an unverified redirect |
| **MP006** | Critical | Payment webhook acts on payloads without verifying the signature |

MP002–MP004 are the rupee/paise family. They are the most common Razorpay integration
mistake in India and, unlike most logic flaws, they are decidable from the syntax alone.

## What it looks like

```
  moneypath · 6 files in 97ms

   CRITICAL  Payment amount comes from the client  MP001 confirmed
  app/api/checkout/route.ts:16:5

      │ amount,

      ↳ amount  ⟵  body
      ↳ body  ⟵  await request.json()
      ↳ await request.json()  ⟵  client input via await req.json()

      The `amount` sent to Razorpay is taken from await req.json() and never
      recomputed server-side. An attacker edits the request and pays whatever
      they like — one rupee for a ten thousand rupee order.

      Fix: Look the price up server-side. Accept only identifiers from the
      client (a product id, a cart id) and compute `amount` from your own
      database rows before calling Razorpay.

  ────────────────────────────────────────────────────────────
  3 critical · 3 high  (1 needing review)
```

Every finding shows the traced path. If moneypath cannot show you the path, it does
not claim the bug.

Try it on the deliberately broken example:

```bash
npx moneypath examples/badcart --html report.html
```

## Use it with AI agents

moneypath ships an **MCP server**, so an agent can audit a checkout as a tool call
instead of scraping CLI output.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add moneypath -- npx -y moneypath-mcp
```
</details>

<details>
<summary><b>Claude Desktop / Cursor / any MCP client</b></summary>

```json
{
  "mcpServers": {
    "moneypath": {
      "command": "npx",
      "args": ["-y", "moneypath-mcp"]
    }
  }
}
```
</details>

Two tools are exposed:

- `scan_payment_code({ path, confirmedOnly? })` — returns structured findings with file,
  line, traced path, impact and fix
- `list_payment_rules()` — returns the rule catalog

Agents working inside this repo should read [AGENTS.md](./AGENTS.md).

## Use it in CI

```yaml
- run: npx moneypath --sarif moneypath.sarif --fail-on critical
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: moneypath.sarif
```

SARIF 2.1.0 puts every finding in your repository's **Security** tab with the line
highlighted.

## Options

```
  --html <file>        write a shareable HTML report
  --json               print findings as JSON
  --sarif <file>       write SARIF 2.1.0 for GitHub code scanning
  --fail-on <level>    exit 1 at or above: critical | high | medium | none  (default: critical)
  --confirmed-only     hide findings the analyzer could not fully prove
  --no-color           disable ANSI colour
```

Exit codes: `0` clean or below threshold, `1` findings at or above it, `2` bad usage.

## How it decides what to report

Every finding is labelled **confirmed** or **needs review**.

- **confirmed** — the analyzer traced the whole path and stands behind it.
- **needs review** — the pattern matched, but intent has to be judged by a human.
  Typically the value crossed a function moneypath cannot see into.

A value loaded from your database is treated as **safe**, even when the client chose
which row to load. That is the pattern moneypath tells you to adopt, so flagging it
would fire on every correct implementation:

```js
const { productId } = await request.json();          // client picks the product
const product = await prisma.product.findUnique(...); // server owns the price
const amountInPaise = Math.round(product.price * 100);
await razorpay.orders.create({ amount: amountInPaise }); // clean
```

This deliberately trades false negatives for precision. On payment code a wrong
accusation costs more trust than a missed edge case, and you only get one chance to
spend that trust.

## What it does not do

Being straight about the boundaries:

- It is **syntactic**, not a full dataflow engine. It follows a value about four hops
  and stops. Deeply indirected code will be missed.
- **Cross-file tracing is narrow.** If you wrap the gateway call in a helper, moneypath
  follows the amount from the caller into that helper and reports at the call site. It
  does this by matching the exported function name and checking the caller imports it,
  not by resolving modules properly, so a wrapper reached through a class method, an
  object property, or a re-export is still missed.
- It only knows **Razorpay and Stripe**. PayPal, Paddle, Lemon Squeezy, Cashfree and
  PhonePe are not covered yet.
- It does **not** replace a security review, a pentest, or reading your own checkout.
- It finds **logic** flaws, not injection, XSS, or dependency CVEs. Use it alongside
  `npm audit` and a general scanner, not instead of them.
- A clean run means *these six bugs* are absent. It is not a certificate.

## Roadmap

Rough order, no dates. Opinions welcome in the issues.

- [x] [**Cross-file tracing**](https://github.com/ANSHUL-REAL/moneypath/issues/1) — done
      for the common case: an amount passed into an exported wrapper that calls the
      gateway. Module-path resolution and method-call wrappers are still open.
- [ ] [**Cashfree**](https://github.com/ANSHUL-REAL/moneypath/issues/2) — note it takes
      rupees rather than paise, which inverts MP002
- [ ] [**Express and Fastify**](https://github.com/ANSHUL-REAL/moneypath/issues/3) —
      webhook detection currently assumes Next.js route shapes
- [ ] [**Quantity abuse**](https://github.com/ANSHUL-REAL/moneypath/issues/4) — negative
      and fractional quantities that subtract from a total
- [ ] **Coupon logic** — client-applied discounts, and redemption with no server-side counter
- [ ] **Idempotency** — webhook retries that double-credit a wallet
- [ ] **PhonePe, PayPal, Paddle, Lemon Squeezy** — lower priority, different failure modes

Not planned: a general dataflow engine, a hosted dashboard, or a paid tier. If it grows
past "one thing, done carefully" it stops being useful.

## Contributing

New rules are welcome, especially other gateways. The bar is precision: a rule must
come with a vulnerable fixture in `examples/badcart` **and** a correct one in
`test/fixtures/safe`, and the safe fixture must stay silent.

```bash
npm install
npm test          # 32 tests: detection, false positives, unit cases
npm run build
npm run check:mcp # MCP protocol smoke test
```

## License

MIT

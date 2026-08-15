# AGENTS.md

Instructions for coding agents working in this repository.

## What this project is

`moneypath` is a static analyzer that finds payment logic flaws in Razorpay and Stripe
integrations. It parses source with `ts-morph`, traces the amount handed to a payment
gateway backwards to its origin, and reports when that origin is attacker-controlled.

It is a security tool. Its only asset is being believed.

## The rule that governs every change

**A false positive is more expensive than a false negative.**

Someone runs this on their live checkout. If it accuses correct code, they uninstall it
and never come back. If it misses an edge case, they are no worse off than before.

So when you are unsure whether a pattern is a bug: do not report it, or report it with
`confidence: 'review'`. Never widen a rule to catch more cases without adding a safe
fixture proving it stays quiet on correct code.

## Layout

```
src/
  analysis/
    ast.ts       location helpers, property lookup, identifier extraction
    sinks.ts     finds payment gateway calls (the "sinks")
    taint.ts     backward tracer: does this value come from the client?
  detectors/
    client-amount.ts        MP001
    currency-units.ts       MP002, MP003, MP004
    client-confirmation.ts  MP005
    webhook-signature.ts    MP006
    util.ts                 finding construction, shared predicates
  report/
    terminal.ts  human output
    html.ts      shareable report
    sarif.ts     SARIF 2.1.0 for GitHub code scanning
  scan.ts        orchestration, file discovery
  cli.ts         argument parsing, exit codes
  mcp.ts         MCP server (JSON-RPC 2.0 over stdio, no SDK dependency)
examples/badcart/     deliberately vulnerable fixture — every rule fires here
test/fixtures/safe/   correct implementations — nothing may fire here
```

## Adding a rule

1. Add it to `src/rules.ts` with a stable `MP0NN` id. Ids are permanent; never renumber.
2. Write the detector in `src/detectors/`, returning findings via `buildFinding`.
3. Register it in the `DETECTORS` array in `src/scan.ts`.
4. Add a vulnerable case to `examples/badcart/` and assert it in `test/badcart.test.ts`.
5. **Add a correct case to `test/fixtures/safe/`.** `test/safe.test.ts` asserts the whole
   directory produces zero findings. This is the important step.
6. Add unit cases to `test/units.test.ts` covering the boundary — especially the nearby
   correct code the rule must not touch.

## Verifying

```bash
npm run typecheck   # strict TS, noUncheckedIndexedAccess on
npm test            # 32 tests
npm run build
npm run check:mcp   # real JSON-RPC handshake against the built server
node dist/cli.js src   # self-scan: must stay clean
```

The self-scan matters. This repo's own source discusses webhooks and signatures at
length, which has already caused one false positive (a detector file was flagged as a
vulnerable webhook because it contained the string `razorpay_signature` in advice text).
If `node dist/cli.js src` reports anything, a rule is matching on prose.

## Conventions

- CommonJS output, Node 18+. Do not introduce ESM-only dependencies.
- Two runtime dependencies (`ts-morph`, `picocolors`). Adding a third needs a real reason.
- The analysis is syntactic on purpose: no type checker, no `node_modules` resolution, so
  it runs on projects that have never been installed.
- `stdout` in `src/mcp.ts` carries the protocol. Never log to it.
- Finding prose is user-facing. State what an attacker gets and what to do, in plain
  words, with a worked money example where it helps.

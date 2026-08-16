# Changelog

Notable changes. Follows [semver](https://semver.org) — rule ids never change once
published, and removing or renaming one is a breaking change.

## [Unreleased]

### Fixed

- **MP005 fired on ordinary React state.** The mutation check matched method names as
  substrings, so `setOrder(...)` and `setPlan(...)` matched on "set" and `dispatch(...)`
  matched on "patch". It would also have matched `input`, `asset` and `createElement`.
  Method names are now matched exactly against the final segment of the callee.
- **MP006 fired on webhooks that verify correctly.** Only the SDK spellings and raw
  crypto primitives counted as verification, so extracting the check into
  `verifyRazorpaySignature()` or `assertWebhookSignature()` was reported as an
  unverified webhook. That punished the people doing the right thing. Locally named
  verification helpers now count.
- **Scans silently truncated at 5000 files.** A large monorepo produced a partial result
  presented as a complete one, which on a security tool is worse than no result at all.
  `ScanResult` now carries `filesSkipped`, and both the terminal and HTML reports say
  plainly that the scan was incomplete.
- `renderSarif` and `GATEWAY_USES_MINOR_UNIT` were missing from the public API, so
  programmatic users could not produce SARIF even though the CLI could.

### Added

- **Cashfree support** ([#2](https://github.com/ANSHUL-REAL/moneypath/issues/2)), with the
  unit inversion it requires. Cashfree bills in decimal rupees, not paise, so the
  conversion MP002 demands for Razorpay is a 100x overcharge here. MP002 and MP003 no
  longer fire for Cashfree, and a new rule catches the opposite mistake:

  - **MP007** (high) — amount converted to minor units for a gateway that bills in major
    units.

  Gateway units are now modelled explicitly rather than assumed, so adding a gateway
  means declaring which unit it takes. Also handles the older SDK signature where
  `PGCreateOrder` receives an API version string before the options object, and the
  Cashfree webhook scheme, which base64 encodes an HMAC over timestamp plus body rather
  than hex encoding the body alone.

- **Cross-file tracing for MP001** ([#1](https://github.com/ANSHUL-REAL/moneypath/issues/1)).
  Wrapping the gateway call in a helper is how most projects are laid out, and it hid
  the bug completely: the file with the sink sees only a parameter, and the route
  calling it contains no sink at all. The scan now runs a second pass that records
  exported functions feeding a parameter straight into a gateway call, then checks what
  callers pass in. Findings are anchored at the call site, where the fix belongs, and
  the trace spans both files.

  Deliberately narrow. Wrappers are matched by exported name plus an import check in the
  calling file rather than by resolving module paths, and two exported functions sharing
  a name are dropped rather than guessed at. These findings are reported as `review`,
  never `confirmed`, because the chain crosses a boundary resolved by name.

### Security

- Upgraded vitest from 2.x to 4.x, clearing five advisories in the transitive
  vite/esbuild chain (one critical, one high, three moderate). All were
  devDependencies, so no published version of moneypath was affected: the package
  ships with `ts-morph` and `picocolors` only.

### Changed

- **Minimum Node is now 20.** vitest 4 requires `^20 || ^22 || >=24`, so Node 18 can no
  longer be tested. Rather than claim support that CI does not exercise, 18 is dropped.
  It went end of life in April 2025. The CI matrix is now 20, 22 and 24.
- Added a security policy and enabled private vulnerability reporting.

## [0.1.1] — 2026-08-15

### Changed

- Rewrote the origin note in the README to describe only what actually happened.
  The published 0.1.0 text carried invented specifics — a discovery timeline and a
  line count — that were never true. No code changes.

## [0.1.0] — 2026-08-15

First release.

### Rules

- **MP001** payment amount originates in the HTTP request and is never recomputed
- **MP002** amount not converted to the gateway minor unit (rupees vs paise, dollars vs cents)
- **MP003** minor-unit conversion is unrounded, producing non-integer amounts
- **MP004** amount converted twice, overcharging 100x
- **MP005** order marked paid from browser code or an unverified redirect
- **MP006** payment webhook with no signature verification

### Added

- CLI with terminal, HTML, JSON and SARIF 2.1.0 output
- MCP server (`moneypath-mcp`) exposing `scan_payment_code` and `list_payment_rules`
- `examples/badcart`, a deliberately broken checkout used as the test fixture
- `test/fixtures/safe`, correct implementations asserted to produce zero findings

### Notes on precision

Two decisions worth recording, because both were reversals during development:

- Values read from the application's own database are treated as **safe**, even when the
  client chose which row to read. The first implementation flagged these, which meant it
  fired on every correct checkout — the exact pattern the tool recommends. Tracing stops
  at a data-store read.
- MP006 originally matched any file mentioning a signature header. That flagged
  moneypath's own detector source, which contains `razorpay_signature` inside advice
  text. It now requires an exported request handler and a body read as well.

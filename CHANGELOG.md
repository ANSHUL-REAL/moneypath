# Changelog

Notable changes. Follows [semver](https://semver.org) — rule ids never change once
published, and removing or renaming one is a breaking change.

## [Unreleased]

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

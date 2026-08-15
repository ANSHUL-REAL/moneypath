# Security policy

## Supported versions

moneypath is pre-1.0. Only the latest published version receives fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/ANSHUL-REAL/moneypath/security/advisories/new)**

That opens a private thread visible only to the maintainers. Please do not open a
public issue for a security problem in moneypath itself.

Expect a first response within 5 days. I am one person, so a fix may take longer than
an acknowledgement. If a report is valid you will be credited in the advisory unless
you would rather not be.

## What counts as a vulnerability in moneypath

moneypath reads source code it is pointed at, which may be untrusted. Things that are
in scope:

- Executing any code from a scanned project. moneypath parses source, it never
  evaluates it, and it does not resolve or load the target's dependencies. A path to
  execution is a serious bug.
- Escaping the scan directory, or reading files outside it.
- Writing a report to an unintended location via a crafted path.
- Injecting content into an HTML report that escapes the intended context. Report
  fields are escaped before rendering, so a bypass is in scope.
- A crash or hang that a crafted source file can trigger reliably.
- Leaking scanned source, findings, or environment data anywhere off the machine.
  moneypath makes no network requests at all, so any outbound traffic is a bug.
- Anything in the published npm package that is not built from this repository.

## What does not count

Two things get reported as security issues but are not:

**A bug moneypath fails to find.** False negatives are expected and documented. The
tool traces a value about four hops within a single file, knows only Razorpay and
Stripe, and the README lists what it does not do. If you have found a payment flaw it
misses, that is very welcome, but please open a normal issue using the
[missed detection](https://github.com/ANSHUL-REAL/moneypath/issues/new?template=missed-bug.yml)
template so it can be discussed in the open.

**A false positive.** Also very welcome, also a normal issue, using the
[false positive](https://github.com/ANSHUL-REAL/moneypath/issues/new?template=false-positive.yml)
template. These are the highest priority non-security bugs in this project.

Neither is a vulnerability in moneypath. A scanner that misses something leaves you
exactly where you were before you ran it.

## Scope note

A clean moneypath run is not a security assessment of your checkout. It means the six
rules it implements found nothing. Please do not report the absence of a rule as a
vulnerability in your own application's dependency chain.

## Dependencies

Two runtime dependencies, `ts-morph` and `picocolors`. Advisories against either are
worth flagging, though report those upstream first. If a fix requires a version bump
here, open a normal issue.

import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scan } from '../src/scan';
import type { Finding, RuleId, ScanResult } from '../src/types';

const BADCART = resolve(process.cwd(), 'examples', 'badcart');

let result: ScanResult;
const byRule = (rule: RuleId): Finding[] => result.findings.filter((f) => f.rule === rule);

beforeAll(() => {
  result = scan({ cwd: BADCART });
});

describe('badcart — every planted bug is found', () => {
  it('recognises the project as payment code', () => {
    expect(result.noPaymentCodeFound).toBe(false);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('MP001 — traces the amount back to the request body', () => {
    const findings = byRule('MP001');
    expect(findings).toHaveLength(1);

    const finding = findings[0]!;
    expect(finding.file).toBe('app/api/checkout/route.ts');
    expect(finding.severity).toBe('critical');
    expect(finding.confidence).toBe('confirmed');
    expect(finding.gateway).toBe('razorpay');
    // The trace has to end at the client source, or the report is unverifiable.
    expect(finding.trace?.at(-1)).toContain('client input');
  });

  it('MP002 — flags the missing paise conversion', () => {
    const findings = byRule('MP002');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('app/api/checkout/route.ts');
    expect(findings[0]!.severity).toBe('high');
  });

  it('MP003 — flags unrounded float arithmetic', () => {
    const findings = byRule('MP003');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('app/api/stripe/route.ts');
    expect(findings[0]!.confidence).toBe('confirmed');
    expect(findings[0]!.gateway).toBe('stripe');
  });

  it('MP004 — flags the doubled conversion', () => {
    const findings = byRule('MP004');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('lib/pricing.ts');
    expect(findings[0]!.confidence).toBe('confirmed');
  });

  it('MP007 — flags a paise conversion sent to Cashfree', () => {
    const findings = byRule('MP007');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('lib/cashfree.ts');
    expect(findings[0]!.gateway).toBe('cashfree');
    expect(findings[0]!.confidence).toBe('confirmed');
  });

  it('MP005 — flags the browser marking an order paid', () => {
    const findings = byRule('MP005');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('app/payment-success/page.tsx');
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.title).toContain('browser');
  });

  it('MP006 — flags the unverified webhook', () => {
    const findings = byRule('MP006');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('app/api/webhooks/razorpay/route.ts');
    expect(findings[0]!.severity).toBe('critical');
  });

  it('sorts critical findings first', () => {
    const severities = result.findings.map((f) => f.severity);
    const firstHigh = severities.indexOf('high');
    const lastCritical = severities.lastIndexOf('critical');
    if (firstHigh !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstHigh);
    }
  });

  it('gives every finding a location, an impact and a fix', () => {
    for (const finding of result.findings) {
      expect(finding.line).toBeGreaterThan(0);
      expect(finding.column).toBeGreaterThan(0);
      expect(finding.snippet.length).toBeGreaterThan(0);
      expect(finding.impact.length).toBeGreaterThan(20);
      expect(finding.fix.length).toBeGreaterThan(20);
      expect(finding.file).not.toContain('\\');
    }
  });
});

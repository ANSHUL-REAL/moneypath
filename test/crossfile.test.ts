import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scan';

const fixture = (name: string): string =>
  resolve(process.cwd(), 'test', 'fixtures', 'crossfile', name);

/**
 * Cross-file tracing.
 *
 * Wrapping the gateway call in a helper is the most common way a real project
 * is laid out, and it used to hide the bug completely: the sink file only sees
 * a parameter, and the route file has no sink in it. Neither half looks wrong
 * alone.
 */
describe('cross-file tracing', () => {
  it('finds a client amount passed into a wrapper in another file', () => {
    const result = scan({ cwd: fixture('vulnerable') });
    const mp001 = result.findings.filter((f) => f.rule === 'MP001');

    expect(mp001).toHaveLength(1);

    const finding = mp001[0]!;
    // The bug is at the call site, not inside the wrapper: that is where the
    // client's number is handed over, and where the fix belongs.
    expect(finding.file).toBe('api/checkout.ts');
    expect(finding.severity).toBe('critical');
    expect(finding.gateway).toBe('razorpay');

    // The trace has to name the wrapper and end at the client source, or a
    // reader cannot check the claim.
    const trace = (finding.trace ?? []).join('\n');
    expect(trace).toContain('createOrder');
    expect(trace).toContain('lib/payments.ts');
    expect(trace).toContain('client input');
  });

  it('does not accuse a same-named local function that is never imported', () => {
    // Matching on the callee name alone would fire here: `createOrder` is
    // called with a request body, but it is a local database helper, not the
    // payment wrapper of the same name in lib/payments.ts.
    const result = scan({ cwd: fixture('shadow') });
    const rendered = result.findings
      .map((f) => `${f.rule} ${f.file}:${f.line} ${f.title}`)
      .join('\n');
    expect(rendered).toBe('');
  });

  it('stays silent when the wrapper is called with a database price', () => {
    const result = scan({ cwd: fixture('safe') });
    const rendered = result.findings
      .map((f) => `${f.rule} ${f.file}:${f.line} ${f.title}`)
      .join('\n');
    expect(rendered).toBe('');
  });
});

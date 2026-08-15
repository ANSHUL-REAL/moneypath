import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scan';

const SAFE = resolve(process.cwd(), 'test', 'fixtures', 'safe');

/**
 * The false-positive suite.
 *
 * This matters more than the badcart suite. Missing a bug costs one finding;
 * accusing correct payment code costs the user's trust, and they only extend it
 * once.
 */
describe('safe fixtures — nothing is reported', () => {
  const result = scan({ cwd: SAFE });

  it('reports no findings at all', () => {
    const rendered = result.findings
      .map((f) => `${f.rule} ${f.file}:${f.line} — ${f.title}`)
      .join('\n');
    expect(rendered).toBe('');
  });

  it('still recognises the project as payment code', () => {
    // A silent pass because nothing was parsed would be a false negative
    // dressed up as a clean bill of health.
    expect(result.noPaymentCodeFound).toBe(false);
    expect(result.filesScanned).toBeGreaterThanOrEqual(5);
  });
});

import { RULES } from '../rules';
import type { Finding, ScanResult, Severity } from '../types';

/**
 * SARIF 2.1.0 output.
 *
 * This is the interchange format GitHub code scanning ingests, and the one
 * agents and IDEs already know how to read. Emitting it means moneypath shows
 * up in the Security tab of any repo that runs it in CI, without anyone having
 * to write a parser.
 */

const HOMEPAGE = 'https://github.com/ANSHUL-REAL/moneypath';

function levelFor(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical') return 'error';
  if (severity === 'high') return 'warning';
  return 'note';
}

export function renderSarif(result: ScanResult, version: string): string {
  const usedRuleIds = [...new Set(result.findings.map((f) => f.rule))].sort();

  const rules = usedRuleIds.map((id) => {
    const meta = RULES[id];
    return {
      id: meta.id,
      name: meta.slug.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()),
      shortDescription: { text: meta.title },
      fullDescription: { text: meta.description },
      helpUri: `${HOMEPAGE}#${meta.id.toLowerCase()}`,
      help: { text: meta.description },
      defaultConfiguration: { level: levelFor(meta.severity) },
      properties: {
        tags: ['security', 'payments', 'business-logic'],
        precision: 'high',
        'problem.severity': meta.severity === 'medium' ? 'warning' : 'error',
      },
    };
  });

  const results = result.findings.map((finding) => ({
    ruleId: finding.rule,
    level: levelFor(finding.severity),
    message: { text: `${finding.title}. ${finding.impact} Fix: ${finding.fix}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.file },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
            snippet: { text: finding.snippet },
          },
        },
      },
    ],
    properties: {
      confidence: finding.confidence,
      gateway: finding.gateway ?? 'unknown',
      ...(finding.trace ? { trace: finding.trace } : {}),
    },
  }));

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'moneypath',
            version,
            semanticVersion: version,
            informationUri: HOMEPAGE,
            rules,
          },
        },
        results,
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              filesScanned: result.filesScanned,
              durationMs: result.durationMs,
            },
          },
        ],
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

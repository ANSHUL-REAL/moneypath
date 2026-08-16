export { scan } from './scan';
export { renderHtml } from './report/html';
export { renderSarif } from './report/sarif';
export { renderTerminal } from './report/terminal';
export { RULES, type RuleMeta } from './rules';
export {
  compareFindings,
  GATEWAY_USES_MINOR_UNIT,
  SEVERITY_RANK,
  type Confidence,
  type Finding,
  type Gateway,
  type RuleId,
  type ScanOptions,
  type ScanResult,
  type Severity,
} from './types';

import { Project, ts, type SourceFile } from 'ts-morph';
import { toRelative } from './analysis/ast';
import { findPaymentSinks, getGatewayContext } from './analysis/sinks';
import { clientAmountDetector } from './detectors/client-amount';
import { clientConfirmationDetector } from './detectors/client-confirmation';
import { currencyUnitDetector } from './detectors/currency-units';
import { webhookSignatureDetector } from './detectors/webhook-signature';
import type { Detector, DetectorContext } from './detectors/util';
import { compareFindings, type Finding, type ScanOptions, type ScanResult } from './types';

const DETECTORS: Detector[] = [
  clientAmountDetector,
  currencyUnitDetector,
  clientConfirmationDetector,
  webhookSignatureDetector,
];

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

const DEFAULT_IGNORES = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.git',
  'vendor',
  '.turbo',
];

const DEFAULT_MAX_FILES = 5000;

function buildGlobs(cwd: string, ignore: string[]): string[] {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const include = SOURCE_EXTENSIONS.map((ext) => `${root}/**/*.${ext}`);
  const exclude = [...DEFAULT_IGNORES, ...ignore].map((dir) => `!${root}/**/${dir}/**`);
  // Minified and generated bundles produce noise and no actionable line numbers.
  exclude.push(`!${root}/**/*.min.js`, `!${root}/**/*.d.ts`);
  return [...include, ...exclude];
}

function createProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      // The analysis is purely syntactic, so skip lib loading entirely. It
      // makes scans fast and lets the tool run on projects with no
      // node_modules installed.
      noLib: true,
      noResolve: true,
    },
  });
}

function analyzeFile(sourceFile: SourceFile, cwd: string): { findings: Finding[]; hasGateway: boolean; sinkCount: number } {
  const relPath = toRelative(sourceFile.getFilePath(), cwd);
  const gateways = getGatewayContext(sourceFile);

  if (gateways.size === 0) {
    return { findings: [], hasGateway: false, sinkCount: 0 };
  }

  const sinks = findPaymentSinks(sourceFile);
  const ctx: DetectorContext = { sourceFile, relPath, sinks };
  const findings: Finding[] = [];

  for (const detector of DETECTORS) {
    try {
      findings.push(...detector(ctx));
    } catch {
      // A single malformed file must never abort the scan. Skipping it loses
      // one file's coverage; throwing loses the user's entire run.
    }
  }

  return { findings, hasGateway: true, sinkCount: sinks.length };
}

export function scan(options: ScanOptions): ScanResult {
  const started = Date.now();
  const cwd = options.cwd;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const project = createProject();
  project.addSourceFilesAtPaths(buildGlobs(cwd, options.ignore ?? []));

  const sourceFiles = project.getSourceFiles().slice(0, maxFiles);

  const findings: Finding[] = [];
  let gatewayFiles = 0;
  let totalSinks = 0;

  for (const sourceFile of sourceFiles) {
    const result = analyzeFile(sourceFile, cwd);
    findings.push(...result.findings);
    if (result.hasGateway) gatewayFiles += 1;
    totalSinks += result.sinkCount;
  }

  findings.sort(compareFindings);

  return {
    findings,
    filesScanned: sourceFiles.length,
    durationMs: Date.now() - started,
    noPaymentCodeFound: gatewayFiles === 0 && totalSinks === 0,
  };
}

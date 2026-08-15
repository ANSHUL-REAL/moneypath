#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { renderHtml } from './report/html';
import { renderSarif } from './report/sarif';
import { renderTerminal } from './report/terminal';
import { scan } from './scan';
import { SEVERITY_RANK, type Severity } from './types';

type FailOn = Severity | 'none';

interface Options {
  target: string;
  json: boolean;
  html: string | null;
  sarif: string | null;
  failOn: FailOn;
  confirmedOnly: boolean;
  color: boolean;
}

const HELP = `
  moneypath — find payment logic flaws in Razorpay and Stripe checkouts

  Usage
    $ npx moneypath [path]

  Options
    --html <file>        write a shareable HTML report
    --json               print findings as JSON
    --sarif <file>       write SARIF 2.1.0 for GitHub code scanning
    --fail-on <level>    exit 1 at or above: critical | high | medium | none  (default: critical)
    --confirmed-only     hide findings the analyzer could not fully prove
    --no-color           disable ANSI colour
    -v, --version        print version
    -h, --help           print this help

  Examples
    $ npx moneypath
    $ npx moneypath ./apps/api --html report.html
    $ npx moneypath --fail-on high --confirmed-only

  Exit codes
    0  clean, or findings below the --fail-on threshold
    1  findings at or above the threshold
    2  bad usage or an internal error
`;

function readVersion(): string {
  for (const candidate of [
    resolve(__dirname, '..', 'package.json'),
    resolve(__dirname, '..', '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'moneypath' && parsed.version) return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

function parseArgs(argv: string[]): Options | { help: true } | { version: true } | { error: string } {
  const options: Options = {
    target: process.cwd(),
    json: false,
    html: null,
    sarif: null,
    failOn: 'critical',
    confirmedOnly: false,
    color: process.env.NO_COLOR === undefined,
  };

  let targetSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case '-h':
      case '--help':
        return { help: true };
      case '-v':
      case '--version':
        return { version: true };
      case '--json':
        options.json = true;
        break;
      case '--confirmed-only':
        options.confirmedOnly = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--html': {
        const value = argv[i + 1];
        if (!value || value.startsWith('-')) return { error: '--html needs a file path' };
        options.html = value;
        i += 1;
        break;
      }
      case '--sarif': {
        const value = argv[i + 1];
        if (!value || value.startsWith('-')) return { error: '--sarif needs a file path' };
        options.sarif = value;
        i += 1;
        break;
      }
      case '--fail-on': {
        const value = argv[i + 1];
        if (!value || !['critical', 'high', 'medium', 'none'].includes(value)) {
          return { error: '--fail-on must be one of: critical, high, medium, none' };
        }
        options.failOn = value as FailOn;
        i += 1;
        break;
      }
      default: {
        if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
        if (targetSeen) return { error: 'only one path may be given' };
        options.target = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
        targetSeen = true;
      }
    }
  }

  return options;
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));

  if ('help' in parsed) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if ('version' in parsed) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`moneypath: ${parsed.error}\n\nRun 'moneypath --help'.\n`);
    return 2;
  }

  const options = parsed;

  if (!existsSync(options.target)) {
    process.stderr.write(`moneypath: no such directory: ${options.target}\n`);
    return 2;
  }

  const result = scan({ cwd: options.target });

  const visible = options.confirmedOnly
    ? result.findings.filter((f) => f.confidence === 'confirmed')
    : result.findings;

  if (options.html) {
    const target = isAbsolute(options.html) ? options.html : resolve(process.cwd(), options.html);
    writeFileSync(
      target,
      renderHtml({ ...result, findings: visible }, basename(options.target)),
      'utf8',
    );
    if (!options.json) process.stdout.write(`\n  HTML report written to ${target}\n`);
  }

  if (options.sarif) {
    const target = isAbsolute(options.sarif) ? options.sarif : resolve(process.cwd(), options.sarif);
    writeFileSync(target, renderSarif({ ...result, findings: visible }, readVersion()), 'utf8');
    if (!options.json) process.stdout.write(`  SARIF written to ${target}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, findings: visible }, null, 2)}\n`);
  } else {
    process.stdout.write(
      renderTerminal(result, { color: options.color, confirmedOnly: options.confirmedOnly }),
    );
  }

  if (options.failOn === 'none') return 0;
  const threshold = SEVERITY_RANK[options.failOn];
  const breached = visible.some((f) => SEVERITY_RANK[f.severity] >= threshold);
  return breached ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`moneypath: unexpected error: ${message}\n`);
  process.exitCode = 2;
}

#!/usr/bin/env node
/**
 * Model Context Protocol server for moneypath.
 *
 * Lets a coding agent audit a checkout directly: "check this repo for payment
 * logic flaws" becomes a tool call rather than a shell command whose output
 * has to be scraped.
 *
 * The protocol is line-delimited JSON-RPC 2.0 over stdio and the surface here
 * is three methods, so it is implemented directly rather than pulling in an
 * ESM-only SDK that this CommonJS build would have to interop with.
 *
 * stdout carries the protocol. Anything human-readable goes to stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { scan } from './scan';
import { RULES } from './rules';
import type { Finding } from './types';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function readVersion(): string {
  for (const candidate of [
    resolve(__dirname, '..', 'package.json'),
    resolve(__dirname, '..', '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === 'moneypath' && parsed.version) return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

const VERSION = readVersion();

const TOOLS = [
  {
    name: 'scan_payment_code',
    description:
      'Audit a Razorpay, Stripe or Cashfree checkout for payment logic flaws that let a customer pay less than they owe. ' +
      'Detects: payment amounts taken from the HTTP request instead of recomputed server-side (MP001), including amounts ' +
      'passed across files into a wrapper function that calls the gateway; ' +
      'currency unit bugs, which differ per gateway because Razorpay bills in paise, Stripe in cents, and Cashfree in ' +
      'decimal rupees, covering missing, unrounded, doubled and unnecessary conversions (MP002-MP004, MP007); ' +
      'orders marked paid by browser code or an unverified redirect (MP005); ' +
      'and payment webhooks that never verify their signature (MP006). ' +
      'Returns structured findings with a file, a line, the traced data path, the impact, and the fix. ' +
      'Use this before shipping any checkout, and whenever changing code that calls a payment gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory to scan. Point it at the project root, or at the server directory if the repo is a monorepo.',
        },
        confirmedOnly: {
          type: 'boolean',
          description:
            'When true, return only findings the analyzer fully traced, omitting ones flagged for human review. Defaults to false.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_payment_rules',
    description:
      'List the payment logic flaws moneypath can detect, with each rule id, severity and description. ' +
      'Use this to explain what was checked, or to decide whether moneypath covers a concern before scanning.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function respondError(
  id: number | string | null | undefined,
  code: number,
  message: string,
): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function summarise(findings: Finding[]): string {
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
  };
  if (findings.length === 0) return 'No payment logic flaws found.';
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return `Found ${findings.length} issue(s): ${parts.join(', ')}.`;
}

function handleScan(args: Record<string, unknown>): Record<string, unknown> {
  const rawPath = typeof args.path === 'string' ? args.path : '';
  if (!rawPath) return textResult('Error: `path` is required.', true);

  const target = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  if (!existsSync(target)) return textResult(`Error: no such directory: ${target}`, true);

  const result = scan({ cwd: target });
  const findings =
    args.confirmedOnly === true
      ? result.findings.filter((f) => f.confidence === 'confirmed')
      : result.findings;

  if (result.noPaymentCodeFound) {
    return textResult(
      JSON.stringify(
        {
          summary: 'No Razorpay or Stripe usage found in this directory.',
          filesScanned: result.filesScanned,
          findings: [],
        },
        null,
        2,
      ),
    );
  }

  return textResult(
    JSON.stringify(
      {
        summary: summarise(findings),
        filesScanned: result.filesScanned,
        durationMs: result.durationMs,
        findings,
      },
      null,
      2,
    ),
  );
}

function handleListRules(): Record<string, unknown> {
  return textResult(JSON.stringify({ rules: Object.values(RULES) }, null, 2));
}

function handle(request: JsonRpcRequest): void {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      respond(id, {
        protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'moneypath', version: VERSION },
      });
      return;
    }
    case 'notifications/initialized':
    case 'initialized':
      return; // Notification: no reply.
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === 'scan_payment_code') {
          respond(id, handleScan(args));
        } else if (name === 'list_payment_rules') {
          respond(id, handleListRules());
        } else {
          respondError(id, -32602, `Unknown tool: ${String(name)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(id, textResult(`Scan failed: ${message}`, true));
      }
      return;
    }
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handle(JSON.parse(trimmed) as JsonRpcRequest);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
  });

  rl.on('close', () => process.exit(0));
}

main();

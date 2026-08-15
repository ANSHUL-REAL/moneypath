#!/usr/bin/env node
/**
 * Smoke test for the MCP server: performs a real handshake over stdio and
 * asserts the three methods behave. Run with `npm run check:mcp`.
 */
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');

const server = spawn(process.execPath, [resolve(__dirname, '..', 'dist', 'mcp.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const responses = [];
let buffer = '';

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) responses.push(JSON.parse(line));
  }
});

server.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));

const send = (msg) => server.stdin.write(`${JSON.stringify(msg)}\n`);

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'scan_payment_code', arguments: { path: resolve(__dirname, '..', 'examples', 'badcart') } },
});
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_payment_rules', arguments: {} } });
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });

setTimeout(() => {
  server.stdin.end();

  const failures = [];
  const byId = (id) => responses.find((r) => r.id === id);

  const init = byId(1);
  if (init?.result?.serverInfo?.name !== 'moneypath') failures.push('initialize did not identify the server');
  if (!init?.result?.capabilities?.tools) failures.push('initialize did not advertise tools');

  if (responses.some((r) => r.id === undefined || r.id === null && !r.error)) {
    failures.push('a notification produced a reply');
  }

  const list = byId(2);
  if (!Array.isArray(list?.result?.tools) || list.result.tools.length !== 2) {
    failures.push('tools/list did not return 2 tools');
  }

  const scan = byId(3);
  const payload = scan?.result?.content?.[0]?.text;
  if (!payload) {
    failures.push('scan returned no content');
  } else {
    const parsed = JSON.parse(payload);
    if (parsed.findings.length !== 6) failures.push(`scan found ${parsed.findings.length} findings, expected 6`);
    if (!parsed.summary.includes('critical')) failures.push('scan summary missing severity counts');
  }

  const rules = byId(4);
  if (!rules?.result?.content?.[0]?.text?.includes('MP001')) failures.push('list_payment_rules missing MP001');

  const bad = byId(5);
  if (!bad?.error) failures.push('unknown tool did not produce an error');

  if (failures.length > 0) {
    console.error('MCP smoke test FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`MCP smoke test passed (${responses.length} responses).`);
  process.exit(0);
}, 4000);

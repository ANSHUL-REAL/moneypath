import type { Finding, ScanResult, Severity } from '../types';
import { RULES } from '../rules';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
};

export function renderHtml(result: ScanResult, projectName: string): string {
  const { findings } = result;
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
  };
  const confirmed = findings.filter((f) => f.confidence === 'confirmed').length;

  const verdict = verdictFor(result, counts.critical);
  const rulesUsed = [...new Set(findings.map((f) => f.rule))].sort();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>moneypath — ${esc(projectName)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e1116;
    --surface: #161b22;
    --surface-2: #1c2430;
    --border: #2a323d;
    --text: #e6edf3;
    --muted: #8b949e;
    --critical: #ff6b6b;
    --high: #f0a020;
    --medium: #58a6ff;
    --ok: #3fb950;
    --accent: #7c8cff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa; --surface: #ffffff; --surface-2: #f0f3f6; --border: #d7dee6;
      --text: #1c2128; --muted: #5b6672; --critical: #cf222e; --high: #9a6700;
      --medium: #0969da; --ok: #1a7f37; --accent: #4a5bd4;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--sans); line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .logo { font-family: var(--mono); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .logo span { color: var(--accent); }
  .meta { color: var(--muted); font-size: 13px; }
  .verdict {
    margin: 28px 0 40px; padding: 28px 32px; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--border);
    border-left: 4px solid var(--verdict-color);
  }
  .verdict h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.25; letter-spacing: -0.02em; color: var(--verdict-color); }
  .verdict p { margin: 0; color: var(--muted); font-size: 15px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
  .stat {
    font-family: var(--mono); font-size: 12px; padding: 5px 11px;
    border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2);
  }
  .stat.critical { color: var(--critical); border-color: color-mix(in srgb, var(--critical) 40%, transparent); }
  .stat.high { color: var(--high); border-color: color-mix(in srgb, var(--high) 40%, transparent); }
  .stat.medium { color: var(--medium); }
  .finding {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 22px 24px; margin-bottom: 18px;
  }
  .finding.critical { border-left: 3px solid var(--critical); }
  .finding.high { border-left: 3px solid var(--high); }
  .finding.medium { border-left: 3px solid var(--medium); }
  .fhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  .chip {
    font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; padding: 3px 8px; border-radius: 5px;
  }
  .chip.critical { background: color-mix(in srgb, var(--critical) 18%, transparent); color: var(--critical); }
  .chip.high { background: color-mix(in srgb, var(--high) 18%, transparent); color: var(--high); }
  .chip.medium { background: color-mix(in srgb, var(--medium) 18%, transparent); color: var(--medium); }
  .rule { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .conf { font-size: 11.5px; color: var(--muted); font-style: italic; margin-left: auto; }
  .ftitle { font-size: 17px; font-weight: 650; margin: 0 0 10px; letter-spacing: -0.01em; }
  .loc { font-family: var(--mono); font-size: 12.5px; color: var(--accent); margin-bottom: 14px; word-break: break-all; }
  pre {
    margin: 0 0 14px; padding: 13px 15px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px;
    font-family: var(--mono); font-size: 12.5px; overflow-x: auto; line-height: 1.5;
  }
  .trace { margin: 0 0 14px; padding: 12px 15px; background: var(--surface-2); border-radius: 8px; }
  .trace div { font-family: var(--mono); font-size: 11.5px; color: var(--muted); padding: 2px 0; }
  .block { margin-bottom: 12px; font-size: 14.5px; }
  .block:last-child { margin-bottom: 0; }
  .label {
    display: block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 3px;
  }
  .fix .label { color: var(--ok); }
  code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
  .warn {
    margin-top: 14px; padding: 12px 16px; border-radius: 8px; font-size: 13.5px;
    background: color-mix(in srgb, var(--high) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--high) 45%, transparent);
    color: var(--text);
  }
  .clean { text-align: center; padding: 60px 20px; color: var(--muted); }
  .clean .big { font-size: 40px; margin-bottom: 12px; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12.5px; }
  footer h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 12px; }
  footer dl { margin: 0; }
  footer dt { font-family: var(--mono); font-size: 12px; color: var(--text); margin-top: 10px; }
  footer dd { margin: 2px 0 0; }
  @media (max-width: 600px) { .wrap { padding: 32px 16px 60px; } .verdict { padding: 22px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">money<span>path</span></div>
    <div class="meta">${esc(projectName)}</div>
  </header>
  <div class="meta">${result.filesScanned} files scanned in ${result.durationMs}ms</div>
  ${
    result.filesSkipped > 0
      ? `<div class="warn"><b>Incomplete scan.</b> ${result.filesSkipped} files were not analyzed because the file limit was reached. Scan a subdirectory, or raise <code>maxFiles</code>.</div>`
      : ''
  }

  <div class="verdict" style="--verdict-color: ${verdict.color}">
    <h1>${esc(verdict.headline)}</h1>
    <p>${esc(verdict.detail)}</p>
    ${
      findings.length > 0
        ? `<div class="stats">
      ${counts.critical > 0 ? `<span class="stat critical">${counts.critical} critical</span>` : ''}
      ${counts.high > 0 ? `<span class="stat high">${counts.high} high</span>` : ''}
      ${counts.medium > 0 ? `<span class="stat medium">${counts.medium} medium</span>` : ''}
      <span class="stat">${confirmed} confirmed</span>
    </div>`
        : ''
    }
  </div>

  ${
    findings.length === 0
      ? `<div class="clean"><div class="big">✔</div><div>Nothing found. Re-run this on every change to your checkout.</div></div>`
      : findings.map(renderFinding).join('\n')
  }

  ${rulesUsed.length > 0 ? renderRuleCatalog(rulesUsed) : ''}

  <footer>
    <p>Generated by moneypath. Findings marked <em>needs review</em> matched a risky pattern
    the analyzer could not fully prove — read them, do not assume them.</p>
  </footer>
</div>
</body>
</html>`;
}

function renderFinding(f: Finding): string {
  return `  <div class="finding ${f.severity}">
    <div class="fhead">
      <span class="chip ${f.severity}">${SEVERITY_LABEL[f.severity]}</span>
      <span class="rule">${f.rule}</span>
      ${f.gateway ? `<span class="rule">${esc(f.gateway)}</span>` : ''}
      <span class="conf">${f.confidence === 'confirmed' ? 'confirmed' : 'needs review'}</span>
    </div>
    <p class="ftitle">${esc(f.title)}</p>
    <div class="loc">${esc(f.file)}:${f.line}:${f.column}</div>
    <pre>${esc(f.snippet)}</pre>
    ${
      f.trace && f.trace.length > 0
        ? `<div class="trace">${f.trace.map((t) => `<div>↳ ${esc(t)}</div>`).join('')}</div>`
        : ''
    }
    <div class="block"><span class="label">What an attacker gets</span>${esc(f.impact)}</div>
    <div class="block fix"><span class="label">Fix</span>${esc(f.fix)}</div>
  </div>`;
}

function renderRuleCatalog(ruleIds: string[]): string {
  const items = ruleIds
    .map((id) => {
      const meta = RULES[id as keyof typeof RULES];
      if (!meta) return '';
      return `<dt>${meta.id} · ${esc(meta.slug)}</dt><dd>${esc(meta.description)}</dd>`;
    })
    .join('');
  return `<footer><h2>Rules triggered</h2><dl>${items}</dl></footer>`;
}

function verdictFor(
  result: ScanResult,
  criticalCount: number,
): { headline: string; detail: string; color: string } {
  if (result.noPaymentCodeFound) {
    return {
      headline: 'No payment code found',
      detail:
        'Nothing in this project calls Razorpay or Stripe. Point moneypath at the directory containing your server code.',
      color: 'var(--muted)',
    };
  }
  if (result.findings.length === 0) {
    return {
      headline: 'No payment logic flaws found',
      detail: 'Every amount reaching the gateway is computed server-side, and webhooks verify their signatures.',
      color: 'var(--ok)',
    };
  }
  if (criticalCount > 0) {
    return {
      headline:
        criticalCount === 1
          ? 'There is one path to your money'
          : `There are ${criticalCount} paths to your money`,
      detail: 'Each critical finding below lets someone pay less than they owe, or nothing at all.',
      color: 'var(--critical)',
    };
  }
  return {
    headline: 'Your checkout has arithmetic bugs',
    detail: 'Nothing here hands money away outright, but customers are being charged the wrong amount.',
    color: 'var(--high)',
  };
}

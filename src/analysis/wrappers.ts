import { Node, SourceFile, SyntaxKind, type CallExpression } from 'ts-morph';
import { RULES } from '../rules';
import type { Finding, Gateway } from '../types';
import { locate, toRelative } from './ast';
import { findPaymentSinks } from './sinks';
import { findBoundValue, resolvableIdentifiers, traceClientTaint } from './taint';

/**
 * Cross-file tracing.
 *
 * Wrapping the gateway call in a helper is how most real projects are laid
 * out, and it used to hide MP001 entirely. The file holding the sink sees only
 * a parameter, and the route calling it contains no sink at all, so neither
 * half looks wrong on its own.
 *
 * This closes that gap in the one direction that matters. Rather than walking
 * the whole module graph, it records exported functions that feed a parameter
 * straight into a gateway call, then checks what callers actually pass. That
 * covers the common shape without the cost or the imprecision of full
 * interprocedural analysis.
 */

export interface SinkWrapper {
  /** Repo-relative path of the file containing the gateway call. */
  relPath: string;
  /** Exported function name, as callers will refer to it. */
  functionName: string;
  /** Which parameter carries the amount. */
  paramIndex: number;
  paramName: string;
  gateway: Gateway;
  amountProp: string;
  /** Line of the gateway call, for the trace. */
  sinkLine: number;
}

function short(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface EnclosingFunction {
  name: string;
  paramNames: string[];
  exported: boolean;
}

/** The nearest enclosing function, with its name and whether it is exported. */
function getEnclosingFunction(node: Node): EnclosingFunction | null {
  const fn = node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
  if (!fn) return null;

  const paramNames = (Node.isFunctionDeclaration(fn) ||
  Node.isArrowFunction(fn) ||
  Node.isFunctionExpression(fn) ||
  Node.isMethodDeclaration(fn)
    ? fn.getParameters()
    : []
  ).map((p) => p.getName());

  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getName();
    if (!name) return null;
    return { name, paramNames, exported: fn.isExported() };
  }

  // `export const createOrder = async (amount) => { ... }`
  const declaration = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!declaration) return null;
  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  return {
    name: declaration.getName(),
    paramNames,
    exported: statement?.isExported() ?? false,
  };
}

/**
 * Does this expression resolve to one of the function's parameters?
 *
 * Requires that no local binding shadows the name, so a local `const amount`
 * is never mistaken for the parameter of the same name.
 */
function resolveToParameter(
  start: Node,
  paramNames: string[],
  maxDepth = 4,
): { index: number; name: string } | null {
  const seen = new Set<string>();

  function walk(node: Node, depth: number): { index: number; name: string } | null {
    for (const name of resolvableIdentifiers(node)) {
      const index = paramNames.indexOf(name);
      if (index !== -1 && findBoundValue(name, node) === undefined) {
        return { index, name };
      }
    }

    if (depth >= maxDepth) return null;

    for (const name of resolvableIdentifiers(node)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const bound = findBoundValue(name, node);
      if (!bound) continue;
      const result = walk(bound, depth + 1);
      if (result) return result;
    }

    return null;
  }

  return walk(start, 0);
}

/** Exported functions in this file that hand a parameter to a payment gateway. */
export function collectSinkWrappers(sf: SourceFile, relPath: string): SinkWrapper[] {
  const wrappers: SinkWrapper[] = [];

  for (const sink of findPaymentSinks(sf)) {
    if (!sink.amountNode) continue;

    const fn = getEnclosingFunction(sink.amountNode);
    if (!fn || !fn.exported || fn.paramNames.length === 0) continue;

    const param = resolveToParameter(sink.amountNode, fn.paramNames);
    if (!param) continue;

    wrappers.push({
      relPath,
      functionName: fn.name,
      paramIndex: param.index,
      paramName: param.name,
      gateway: sink.gateway,
      amountProp: sink.amountProp,
      sinkLine: locate(sink.amountNode).line,
    });
  }

  return wrappers;
}

/** Is `name` brought into this file by an import? */
function importsName(sf: SourceFile, name: string): boolean {
  for (const declaration of sf.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      if (named.getName() === name) return true;
      if (named.getAliasNode()?.getText() === name) return true;
    }
    if (declaration.getDefaultImport()?.getText() === name) return true;
  }
  return false;
}

function calleeName(call: CallExpression): string | null {
  const expression = call.getExpression();
  return Node.isIdentifier(expression) ? expression.getText() : null;
}

/**
 * Check every call site of a recorded wrapper for a client-controlled argument.
 *
 * Findings are anchored at the call site rather than inside the wrapper. That
 * is where the untrusted number is handed over, and where the fix belongs.
 */
export function findCrossFileFindings(
  sourceFiles: SourceFile[],
  wrappers: SinkWrapper[],
  cwd: string,
): Finding[] {
  if (wrappers.length === 0) return [];

  // Two exported functions sharing a name cannot be told apart without real
  // module resolution, so drop them rather than guess wrong.
  const byName = new Map<string, SinkWrapper>();
  const ambiguous = new Set<string>();
  for (const wrapper of wrappers) {
    if (byName.has(wrapper.functionName)) ambiguous.add(wrapper.functionName);
    byName.set(wrapper.functionName, wrapper);
  }
  for (const name of ambiguous) byName.delete(name);
  if (byName.size === 0) return [];

  const meta = RULES.MP001;
  const findings: Finding[] = [];

  for (const sf of sourceFiles) {
    const relPath = toRelative(sf.getFilePath(), cwd);

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const name = calleeName(call);
      if (!name) continue;

      const wrapper = byName.get(name);
      if (!wrapper) continue;

      // Called from another file, so it must actually be imported here.
      // Without this, any same-named local helper would match.
      if (relPath !== wrapper.relPath && !importsName(sf, name)) continue;

      const argument = call.getArguments()[wrapper.paramIndex];
      if (!argument) continue;

      const taint = traceClientTaint(argument);
      if (!taint.tainted) continue;

      const { line, column, snippet } = locate(argument);
      const gatewayName = wrapper.gateway === 'stripe' ? 'Stripe' : 'Razorpay';

      findings.push({
        rule: meta.id,
        slug: meta.slug,
        severity: meta.severity,
        // The chain crosses a function boundary the analyzer resolved by name
        // rather than by module path, so it is offered for review.
        confidence: 'review',
        gateway: wrapper.gateway,
        title: `Client-controlled amount passed to ${wrapper.functionName}()`,
        file: relPath,
        line,
        column,
        snippet,
        impact:
          `\`${short(argument.getText())}\` comes from ${taint.source} and is passed as ` +
          `\`${wrapper.paramName}\` to ${wrapper.functionName}(), which hands it to ${gatewayName} ` +
          `as \`${wrapper.amountProp}\` at ${wrapper.relPath}:${wrapper.sinkLine}. Neither file looks ` +
          `wrong on its own, but together they let the customer set their own price.`,
        fix:
          `Price the order server-side before calling ${wrapper.functionName}(). Accept only an ` +
          `identifier from the client and compute the amount from your own database rows. ` +
          `Consider naming the parameter for its unit and validating it inside the wrapper too, ` +
          `so a future caller cannot reintroduce this.`,
        trace: [
          ...taint.trace,
          `passed as \`${wrapper.paramName}\` to ${wrapper.functionName}()`,
          `${wrapper.relPath}:${wrapper.sinkLine}  reaches ${gatewayName} as \`${wrapper.amountProp}\``,
        ],
      });
    }
  }

  return findings;
}

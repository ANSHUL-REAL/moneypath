import { Node, ObjectLiteralExpression, SourceFile, SyntaxKind } from 'ts-morph';

export interface Location {
  line: number;
  column: number;
  snippet: string;
}

/** Resolve a node to a 1-indexed line/column plus the trimmed source line. */
export function locate(node: Node): Location {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  return { line, column, snippet: getLineText(sf, line) };
}

export function getLineText(sf: SourceFile, line: number): string {
  const lines = sf.getFullText().split(/\r?\n/);
  return (lines[line - 1] ?? '').trim();
}

/**
 * Read a property off an object literal, transparently handling shorthand.
 * For `{ amount }` the returned node is the `amount` identifier itself, which
 * is exactly what callers want to trace.
 */
export function getPropertyValue(
  obj: ObjectLiteralExpression,
  name: string,
): Node | undefined {
  const prop = obj.getProperty(name);
  if (!prop) return undefined;
  if (Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  return undefined;
}

/** Find a named property anywhere beneath a node (used for nested Stripe price_data). */
export function findNestedPropertyValue(root: Node, name: string): Node | undefined {
  for (const prop of root.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() === name) return prop.getInitializer();
  }
  for (const prop of root.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
    if (prop.getName() === name) return prop.getNameNode();
  }
  return undefined;
}

/** Nearest enclosing function-like node, or the source file when at top level. */
export function getEnclosingFunction(node: Node): Node {
  const fn = node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
  return fn ?? node.getSourceFile();
}

/** True when the file carries a `'use client'` / `"use client"` directive. */
export function isClientComponent(sf: SourceFile): boolean {
  const head = sf.getFullText().slice(0, 200);
  return /^\s*['"]use client['"]/m.test(head);
}

/** Distinct identifier names appearing in an expression. */
export function identifiersIn(node: Node): string[] {
  const names = new Set<string>();
  if (Node.isIdentifier(node)) names.add(node.getText());
  for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    names.add(id.getText());
  }
  return [...names];
}

/**
 * Normalise a path for display: repo-relative with forward slashes, so reports
 * read the same on Windows and CI.
 */
export function toRelative(filePath: string, cwd: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.startsWith(base + '/')
    ? normalized.slice(base.length + 1)
    : normalized;
}

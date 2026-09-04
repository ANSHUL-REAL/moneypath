import { Node, SyntaxKind } from 'ts-morph';

/** Expressions that are, by definition, attacker-controlled. */
const CLIENT_SOURCES: { re: RegExp; label: string }[] = [
  { re: /\breq(uest)?\s*\.\s*body\b/, label: 'req.body' },
  { re: /\breq(uest)?\s*\.\s*query\b/, label: 'req.query' },
  { re: /\breq(uest)?\s*\.\s*params\b/, label: 'req.params' },
  { re: /\breq(uest)?\s*\.\s*json\s*\(/, label: 'await req.json()' },
  { re: /\breq(uest)?\s*\.\s*formData\s*\(/, label: 'await req.formData()' },
  { re: /\bsearchParams\s*\.\s*get\s*\(/, label: 'searchParams.get()' },
  { re: /\buseSearchParams\s*\(/, label: 'useSearchParams()' },
  { re: /\bformData\s*\.\s*get\s*\(/, label: 'formData.get()' },
];

/**
 * Calls that read the application's own data store.
 *
 * These are sanitizers, not conduits. When a price is loaded from the database
 * the client only chose *which row* to read, not what the price is — which is
 * precisely the pattern this tool tells people to adopt. Treating a lookup as
 * tainting would fire MP001 on every correct implementation, so the analyzer
 * stops following a value the moment it comes out of a data store.
 *
 * The cost is a false negative when client input is written to the database and
 * read straight back. That trade is deliberate: on payment code, a wrong
 * accusation costs more trust than a missed edge case.
 */
const SERVER_DATA_READ_RE =
  /\.\s*(findUnique|findFirst|findMany|findOne|findById|findAll|select|query|aggregate|lookup|load|fetchOne|getOne|getById|maybeSingle|single)\s*\(|\b(prisma|supabase|drizzle|mongoose|knex|sequelize|typeorm)\b/i;

export interface TaintResult {
  tainted: boolean;
  /** Human label for the originating client source. */
  source: string | null;
  /** Readable backward chain, outermost first. */
  trace: string[];
  /**
   * True when the path crossed a call the analyzer could not see through and
   * could not classify as a data-store read. The value might be recomputed
   * inside that call, so the finding is downgraded to `review`.
   */
  viaOpaqueCall: boolean;
}

const CLEAN: TaintResult = {
  tainted: false,
  source: null,
  trace: [],
  viaOpaqueCall: false,
};

export function matchClientSource(text: string): string | null {
  for (const { re, label } of CLIENT_SOURCES) {
    if (re.test(text)) return label;
  }
  return null;
}

export function isServerDataRead(node: Node): boolean {
  const inner = Node.isAwaitExpression(node) ? node.getExpression() : node;
  return SERVER_DATA_READ_RE.test(inner.getText());
}

function short(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Identifiers that could name a variable.
 *
 * Excludes the property half of member expressions and object keys: in
 * `product.price` only `product` is resolvable, and treating `price` as a
 * variable would let an unrelated local of the same name hijack the trace.
 */
export function resolvableIdentifiers(node: Node): string[] {
  const names = new Set<string>();

  const consider = (id: Node): void => {
    const parent = id.getParent();
    if (parent) {
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return;
      if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return;
      if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === id) return;
      if (Node.isCallExpression(parent) && parent.getExpression() === id) return;
    }
    names.add(id.getText());
  };

  if (Node.isIdentifier(node)) consider(node);
  for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) consider(id);
  return [...names];
}

/**
 * Find the value most recently bound to `name` before the use site.
 *
 * Deliberately scope-approximate: it prefers the nearest preceding binding in
 * the file rather than doing full symbol resolution, because the type checker
 * needs installed dependencies and a real tsconfig, neither of which can be
 * assumed when someone runs this against a half-finished project.
 */
export function findBoundValue(name: string, from: Node): Node | undefined {
  const sf = from.getSourceFile();
  const pos = from.getStart();
  const candidates: Node[] = [];

  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (vd.getStart() >= pos) continue;
    const nameNode = vd.getNameNode();
    if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
      const init = vd.getInitializer();
      if (init) candidates.push(init);
    }
  }

  for (const be of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    if (be.getStart() >= pos) continue;
    if (be.getName() !== name) continue;
    const vd = be.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const init = vd?.getInitializer();
    if (init) candidates.push(init);
  }

  return candidates.at(-1);
}

/** A call the analyzer cannot see through and cannot classify as a data read. */
function isOpaqueCall(node: Node): boolean {
  const inner = Node.isAwaitExpression(node) ? node.getExpression() : node;
  if (!Node.isCallExpression(inner)) return false;
  if (matchClientSource(inner.getText()) !== null) return false;
  return !isServerDataRead(inner);
}

/**
 * Walk an expression backwards looking for attacker-controlled input.
 *
 * `maxDepth` is intentionally small. Chasing a value across ten hops produces
 * chains nobody can verify by eye, and an unverifiable finding on payment code
 * is worse than no finding at all.
 */

function isServerOwnedExpression(node: Node): boolean {
  const text = node.getText();

  // Direct database lookup.
  if (isServerDataRead(node)) {
    return true;
  }

  // Walk identifiers and see whether any identifier resolves
  // to a server-side data-store read.
  for (const name of resolvableIdentifiers(node)) {
    const bound = findBoundValue(name, node);

    if (bound && isServerDataRead(bound)) {
      return true;
    }
  }

  return false;
}


export function traceClientTaint(start: Node, maxDepth = 4): TaintResult {
  const seen = new Set<string>();

  function walk(
    node: Node,
    depth: number,
    trace: string[],
    viaCall: boolean,
  ): TaintResult | null {
    const text = node.getText();

    // Direct client-controlled source.
    const hit = matchClientSource(text);
    if (hit) {
      return {
        tainted: true,
        source: hit,
        trace: [
          ...trace,
          `${short(text)}  ⟵  client input via ${hit}`,
        ],
        viaOpaqueCall: viaCall,
      };
    }

    if (depth >= maxDepth) return null;

    /*
     * If this expression is a multiplication, inspect its operands
     * independently.
     *
     * This is important for payment calculations such as:
     *
     *   product.price * quantity
     *
     * `quantity` is client-controlled, but `product.price` is
     * server-owned. The entire payment amount must NOT therefore
     * become MP001-tainted.
     *
     * MP008 is responsible for detecting unsafe client-controlled
     * quantities.
     */
    if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.AsteriskToken
    ) {
      const left = node.getLeft();
      const right = node.getRight();

      const leftServerOwned = isServerOwnedExpression(left);
      const rightServerOwned = isServerOwnedExpression(right);

      // A multiplication containing a server-owned value is not
      // automatically a client-controlled payment amount.
      if (leftServerOwned || rightServerOwned) {
        return null;
      }
    }

    for (const name of resolvableIdentifiers(node)) {
      if (seen.has(name)) continue;
      seen.add(name);

      const bound = findBoundValue(name, node);
      if (!bound) continue;

      // Database/store reads are server-owned.
      if (isServerDataRead(bound)) continue;

      const result = walk(
        bound,
        depth + 1,
        [...trace, `${name}  ⟵  ${short(bound.getText())}`],
        viaCall || isOpaqueCall(bound),
      );

      if (result) return result;
    }

    return null;
  }

  return walk(start, 0, [], false) ?? CLEAN;
}

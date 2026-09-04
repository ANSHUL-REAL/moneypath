import type { Finding } from '../types';
import { Node, SyntaxKind } from 'ts-morph';
import {
  findBoundValue,
  traceClientTaint,
} from '../analysis/taint';
import { buildFinding, gatewayName, type Detector } from './util';

/**
 * Resolve an identifier such as:
 *
 *   amount
 *
 * to:
 *
 *   product.price * quantity
 */
function resolveExpression(node: Node): Node {
  if (!Node.isIdentifier(node)) return node;

  return findBoundValue(node.getText(), node) ?? node;
}

/**
 * Check whether a multiplication is a server-owned price multiplied by
 * a validated quantity.
 *
 * Examples:
 *
 *   product.price * quantity
 *   product.price * qty
 *   product.price * result.data.quantity
 */
function isSafeQuantityPricingExpression(start: Node): boolean {
  const node = resolveExpression(start);

  if (!Node.isBinaryExpression(node)) return false;

  if (
    node.getOperatorToken().getKind() !==
    SyntaxKind.AsteriskToken
  ) {
    return false;
  }

  const left = node.getLeft();
  const right = node.getRight();

  const leftText = left.getText();
  const rightText = right.getText();

  const quantitySide =
    /\bquantity\b/i.test(leftText) ||
    /\bquantity\b/i.test(rightText)
      ? (/\bquantity\b/i.test(leftText) ? left : right)
      : undefined;

  let quantityNode = quantitySide;

  // Handle:
  //   const qty = Math.max(1, Math.floor(Number(quantity)));
  //   product.price * qty
  if (!quantityNode) {
    for (const candidate of [left, right]) {
      if (!Node.isIdentifier(candidate)) continue;

      const bound = findBoundValue(candidate.getText(), candidate);

      if (
        bound &&
        /Math\s*\.\s*max\s*\(\s*1\s*,\s*Math\s*\.\s*floor\s*\(\s*Number\s*\(/.test(
          bound.getText(),
        )
      ) {
        quantityNode = candidate;
        break;
      }
    }
  }

  // Handle schema result.data.quantity.
  if (!quantityNode) {
    for (const candidate of [left, right]) {
      if (/\.quantity\b/.test(candidate.getText())) {
        quantityNode = candidate;
        break;
      }
    }
  }

  if (!quantityNode) return false;

  const functionBody =
    node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getBody() ??
    node.getFirstAncestorByKind(SyntaxKind.ArrowFunction)?.getBody();

  if (!functionBody) return false;

  const bodyText = functionBody.getText();

  // Explicit integer + positive validation.
  if (
    bodyText.includes('Number.isInteger(quantity)') &&
    (
      bodyText.includes('quantity < 1') ||
      bodyText.includes('quantity <= 0')
    )
  ) {
    return true;
  }

  // Normalisation:
  // Math.max(1, Math.floor(Number(quantity)))
  if (
    /Math\s*\.\s*max\s*\(\s*1\s*,\s*Math\s*\.\s*floor\s*\(\s*Number\s*\(\s*quantity\s*\)\s*\)\s*\)/.test(
      bodyText,
    )
  ) {
    return true;
  }

  // Schema validation.
  if (
    /\.parse\s*\(/.test(bodyText) ||
    /\.safeParse\s*\(/.test(bodyText) ||
    /\.validate\s*\(/.test(bodyText)
  ) {
    return true;
  }

  // Explicit positive guard.
  if (
    /quantity\s*<=\s*0/.test(bodyText) ||
    /quantity\s*<\s*1/.test(bodyText)
  ) {
    return true;
  }

  // For qty normalization.
  if (
    quantityNode &&
    Node.isIdentifier(quantityNode)
  ) {
    const bound = findBoundValue(
      quantityNode.getText(),
      quantityNode,
    );

    if (
      bound &&
      /Math\s*\.\s*max\s*\(\s*1\s*,\s*Math\s*\.\s*floor\s*\(\s*Number\s*\(\s*quantity\s*\)/.test(
        bound.getText(),
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * MP001
 */
export const clientAmountDetector: Detector = (ctx): Finding[] => {
  const findings: Finding[] = [];

  for (const sink of ctx.sinks) {
    if (!sink.amountNode) continue;

    // IMPORTANT:
    // amountNode is often `amount`, while the actual expression is
    // `product.price * quantity`.
    if (isSafeQuantityPricingExpression(sink.amountNode)) {
      continue;
    }

    const taint = traceClientTaint(sink.amountNode);

    if (!taint.tainted) continue;

    const confidence = taint.viaOpaqueCall
      ? 'review'
      : 'confirmed';

    const name = gatewayName(sink.gateway);

    const impact = taint.viaOpaqueCall
      ? `The \`${sink.amountProp}\` sent to ${name} derives from ${taint.source}, but passes through a function this analyzer cannot see into. If that function does not re-price the order against the database, the customer sets their own price.`
      : `The \`${sink.amountProp}\` sent to ${name} is taken from ${taint.source} and never recomputed server-side. An attacker edits the request and pays whatever they like — one rupee for a ten thousand rupee order.`;

    findings.push(
      buildFinding({
        rule: 'MP001',
        node: sink.amountNode,
        ctx,
        confidence,
        gateway: sink.gateway,
        impact,
        fix: `Look the price up server-side. Accept only identifiers from the client (a product id, a cart id) and compute \`${sink.amountProp}\` from your own database rows before calling ${name}. Never accept a price, discount, quantity subtotal, or delivery fee as an input you trust.`,
        trace: taint.trace,
      }),
    );
  }

  return findings;
};
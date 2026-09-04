import { Node, SyntaxKind } from 'ts-morph';

import {
  GATEWAY_USES_MINOR_UNIT,
  type Finding,
  type Gateway,
} from '../types';

import { identifiersIn } from '../analysis/ast';
import { traceClientTaint } from '../analysis/taint';
import { buildFinding, gatewayName, type Detector } from './util';

/**
 * Explicit major-unit money names.
 *
 * `amount`, `price`, and `total` are intentionally NOT included here because
 * they are ambiguous. They may already represent paise/cents.
 */
const MAJOR_UNIT_NAME_RE =
  /^(priceRupees|amountRupees|totalRupees|feeRupees|costRupees|mrpRupees|payableRupees|inr|rupees?|dollars?|usd|priceUsd|amountUsd|totalUsd|priceDollars)$/i;

/**
 * Explicit minor-unit names.
 */
const MINOR_UNIT_NAME_RE =
  /(paise|paisa|cents?|minor|smallest|inPaise|inCents|_p\b)/i;

/**
 * Operations that guarantee integer conversion.
 */
const ROUNDING_RE =
  /Math\s*\.\s*(round|trunc|floor|ceil)|toFixed|BigInt|\|\s*0/;

/**
 * Information about the gateway's monetary representation.
 */
interface Units {
  major: string;
  minor: string;
  under: string;
  over: string;
}

const RUPEES: Units = {
  major: 'rupees',
  minor: 'paise',
  under: 'a ₹2,000 order collects ₹20',
  over: 'a ₹500 order bills ₹50,000',
};

function units(gateway: Gateway): Units {
  if (gateway === 'stripe') {
    return {
      major: 'dollars',
      minor: 'cents',
      under: 'a $20.00 order collects $0.20',
      over: 'a $5.00 order bills $500.00',
    };
  }

  return RUPEES;
}

/**
 * Count explicit multiplication by 100.
 *
 * Handles:
 *
 *   value * 100
 *   100 * value
 */
function countConversions(text: string): number {
  const flat = text.replace(/\s+/g, '');

  const trailing =
    flat.match(/\*100(?![0-9.])/g)?.length ?? 0;

  const leading =
    flat.match(/(?<![0-9.])100\*/g)?.length ?? 0;

  return trailing + leading;
}

/**
 * Find the expression paired with *100.
 */
function operandPairedWith100(node: Node): Node | undefined {
  const candidates: Node[] = [
    node,
    ...node.getDescendantsOfKind(SyntaxKind.BinaryExpression),
  ];

  for (const candidate of candidates) {
    if (!Node.isBinaryExpression(candidate)) {
      continue;
    }

    if (
      candidate.getOperatorToken().getKind() !==
      SyntaxKind.AsteriskToken
    ) {
      continue;
    }

    const left = candidate.getLeft();
    const right = candidate.getRight();

    if (
      Node.isNumericLiteral(right) &&
      right.getLiteralValue() === 100
    ) {
      return left;
    }

    if (
      Node.isNumericLiteral(left) &&
      left.getLiteralValue() === 100
    ) {
      return right;
    }
  }

  return undefined;
}

/**
 * Does this expression explicitly identify major-unit money?
 */
function explicitlyMajorUnit(node: Node): boolean {
  const text = node.getText();
  const names = identifiersIn(node);

  if (MAJOR_UNIT_NAME_RE.test(text)) {
    return true;
  }

  return names.some((name) =>
    MAJOR_UNIT_NAME_RE.test(name),
  );
}

/**
 * Does this expression explicitly identify minor-unit money?
 */
function explicitlyMinorUnit(node: Node): boolean {
  const text = node.getText();
  const names = identifiersIn(node);

  if (MINOR_UNIT_NAME_RE.test(text)) {
    return true;
  }

  return names.some((name) =>
    MINOR_UNIT_NAME_RE.test(name),
  );
}

/**
 * Detect obvious server/database price expressions.
 *
 * Examples:
 *
 *   product.price
 *   plan.price
 *   item.cost
 *   product.amount
 *
 * These are trusted server-side expressions and should not be considered
 * client-controlled merely because they are later multiplied by quantity.
 */
function isServerPriceExpression(node: Node): boolean {
  const text = node.getText();

  if (
    /\b(product|plan|item|record|row)\s*\.\s*(price|priceRupees|priceUsd|amount|amountRupees|amountUsd|cost|total)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /\b(product|plan|item)\b/i.test(text) &&
    /\.(price|priceRupees|priceUsd|cost|amount)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Does this node look like a quantity expression?
 */
function isQuantityExpression(node: Node): boolean {
  const text = node.getText();
  const names = identifiersIn(node);

  if (
    /\b(quantity|qty|count|units?|items?)\b/i.test(text)
  ) {
    return true;
  }

  return names.some((name) =>
    /^(quantity|qty|count|units?|items?)$/i.test(name),
  );
}

/**
 * Detect:
 *
 *   product.price * quantity
 *   quantity * product.price
 *
 * The important part is that one side is a trusted server-side price and
 * the other side is a quantity.
 */
function isPriceTimesQuantityExpression(
  node: Node,
): boolean {
  if (!Node.isBinaryExpression(node)) {
    return false;
  }

  if (
    node.getOperatorToken().getKind() !==
    SyntaxKind.AsteriskToken
  ) {
    return false;
  }

  const left = node.getLeft();
  const right = node.getRight();

  const leftPrice =
    isServerPriceExpression(left) ||
    explicitlyMajorUnit(left) ||
    /\b(price|priceRupees|priceUsd|cost)\b/i.test(
      left.getText(),
    );

  const rightPrice =
    isServerPriceExpression(right) ||
    explicitlyMajorUnit(right) ||
    /\b(price|priceRupees|priceUsd|cost)\b/i.test(
      right.getText(),
    );

  const leftQuantity = isQuantityExpression(left);
  const rightQuantity = isQuantityExpression(right);

  return (
    (leftPrice && rightQuantity) ||
    (rightPrice && leftQuantity)
  );
}

/**
 * Resolve a local variable to its initializer.
 *
 * This is the important part of the permanent fix.
 *
 * Example:
 *
 *   const amount = product.price * quantity;
 *
 * At the payment sink the amount node is:
 *
 *   amount
 *
 * not:
 *
 *   product.price * quantity
 *
 * So we follow `amount` back to its initializer.
 *
 * A small depth limit prevents accidental infinite recursion.
 */
function resolveLocalExpression(
  node: Node,
  depth = 0,
): Node {
  if (depth >= 8) {
    return node;
  }

  if (Node.isParenthesizedExpression(node)) {
    return resolveLocalExpression(
      node.getExpression(),
      depth + 1,
    );
  }

  if (Node.isIdentifier(node)) {
    const definitions = node.getDefinitions();

    for (const definition of definitions) {
      const declaration = definition.getDeclarationNode();

      if (!declaration) {
        continue;
      }

      if (Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();

        if (initializer) {
          return resolveLocalExpression(
            initializer,
            depth + 1,
          );
        }
      }
    }
  }

  return node;
}

/**
 * Detect server-side price * quantity even when the result is stored in
 * one or more local variables.
 *
 * Examples:
 *
 *   const amount = product.price * quantity;
 *
 *   const subtotal = product.price * quantity;
 *   const amount = subtotal;
 *
 *   const lineTotal = item.price * qty;
 *   const amount = lineTotal;
 */
function isPriceTimesQuantity(node: Node): boolean {
  const resolved = resolveLocalExpression(node);

  if (isPriceTimesQuantityExpression(resolved)) {
    return true;
  }

  return false;
}

/**
 * Determine whether a value is directly client-controlled.
 *
 * This is used only after safe server-side expressions have been excluded.
 */
function isClientControlled(
  node: Node,
): ReturnType<typeof traceClientTaint> {
  return traceClientTaint(node);
}

/**
 * MP002 / MP003 / MP004 / MP007
 *
 * Currency-unit detector.
 */
export const currencyUnitDetector: Detector = (
  ctx,
): Finding[] => {
  const findings: Finding[] = [];

  for (const sink of ctx.sinks) {
    if (!sink.amountNode) {
      continue;
    }

    const node = sink.amountNode;
    const text = node.getText();

    const conversions = countConversions(text);
    const { major, minor, under, over } =
      units(sink.gateway);

    const name = gatewayName(sink.gateway);

    /*
     * ============================================================
     * 1. Explicit minor-unit value
     * ============================================================
     *
     * Examples:
     *
     *   amountInPaise
     *   amountInCents
     *   smallestUnit
     */
    if (explicitlyMinorUnit(node)) {
      continue;
    }

    /*
     * ============================================================
     * 2. Server-side price * quantity
     * ============================================================
     *
     * IMPORTANT:
     *
     * Check this BEFORE client taint.
     *
     * Example:
     *
     *   const quantity = Number(body.quantity);
     *   const amount = product.price * quantity;
     *
     * The quantity can legitimately be client-controlled.
     * That does NOT make the entire price expression a client-controlled
     * payment amount.
     *
     * MP008 is responsible for validating the quantity.
     */
    const serverPriceTimesQuantity =
      isPriceTimesQuantity(node);

    if (serverPriceTimesQuantity) {
      /*
       * For Cashfree, major-unit multiplication is valid because
       * Cashfree expects rupees/dollars rather than minor units.
       */
      if (!GATEWAY_USES_MINOR_UNIT[sink.gateway]) {
        continue;
      }

      /*
       * For a minor-unit gateway, we still need to inspect whether the
       * complete expression contains an explicit conversion.
       *
       * Example:
       *
       *   Math.round(product.price * quantity * 100)
       *
       * is safe.
       */
      if (ROUNDING_RE.test(text)) {
        continue;
      }

      /*
       * If the resolved expression itself contains the conversion,
       * don't report it as MP002.
       */
      const resolved = resolveLocalExpression(node);
      const resolvedText = resolved.getText();

      if (countConversions(resolvedText) > 0) {
        continue;
      }

      /*
       * Server-side price * quantity without *100 is not automatically
       * a client-controlled amount.
       *
       * However, for Razorpay/Stripe it may still represent a unit
       * conversion problem. We deliberately leave this to the existing
       * unit rules rather than MP002.
       *
       * Most importantly, do not allow taint from `quantity` to turn
       * this into a false MP002.
       */
    }

    /*
     * ============================================================
     * 3. Cashfree / major-unit gateways
     * ============================================================
     *
     * Cashfree expects:
     *
     *   order_amount: 499.00
     *
     * not:
     *
     *   order_amount: 49900
     */
    if (!GATEWAY_USES_MINOR_UNIT[sink.gateway]) {
      if (conversions === 0) {
        continue;
      }

      findings.push(
        buildFinding({
          rule: 'MP007',
          node,
          ctx,
          confidence: 'confirmed',
          gateway: sink.gateway,
          impact:
            `${name} bills in ${major} as a decimal, not in ${minor}. ` +
            `Multiplying by 100 here charges the customer 100x the intended price — ${over}.`,
          fix:
            `Pass the ${major} value straight through: ` +
            `\`order_amount: total\`, not \`total * 100\`. ` +
            `If your codebase stores money in ${minor}, divide at this boundary rather than multiplying.`,
        }),
      );

      continue;
    }

    /*
     * ============================================================
     * 4. Double conversion
     * ============================================================
     */
    if (conversions >= 2) {
      findings.push(
        buildFinding({
          rule: 'MP004',
          node,
          ctx,
          confidence: 'confirmed',
          gateway: sink.gateway,
          impact:
            `The value is multiplied by 100 ` +
            `${
              conversions === 2
                ? 'twice'
                : `${conversions} times`
            } ` +
            `before reaching ${name}, so the customer is charged 100x ` +
            `the intended price — ${over}.`,
          fix:
            `Convert to ${minor} exactly once at the payment boundary. ` +
            `Keep one money representation internally and name variables for their unit.`,
        }),
      );

      continue;
    }

    /*
     * ============================================================
     * 5. Single *100 conversion
     * ============================================================
     */
    if (conversions === 1) {
      /*
       * Explicit rounding makes the conversion safe.
       */
      if (ROUNDING_RE.test(text)) {
        continue;
      }

      const other = operandPairedWith100(node);

      /*
       * Integer literal * 100 is exact.
       *
       * 499 * 100 = 49900
       */
      if (
        other &&
        Node.isNumericLiteral(other) &&
        Number.isInteger(other.getLiteralValue())
      ) {
        continue;
      }

      /*
       * Float literal * 100.
       */
      const isFloatLiteral =
        other !== undefined &&
        Node.isNumericLiteral(other) &&
        !Number.isInteger(
          other.getLiteralValue(),
        );

      findings.push(
        buildFinding({
          rule: 'MP003',
          node,
          ctx,
          confidence: isFloatLiteral
            ? 'confirmed'
            : 'review',
          gateway: sink.gateway,
          impact: isFloatLiteral
            ? `\`${text}\` can produce a non-integer because of floating-point arithmetic. ` +
              `${name} requires an integer count of ${minor}.`
            : `The value is multiplied by 100 without explicit rounding. ` +
              `${name} requires an integer number of ${minor}.`,
          fix:
            `Use \`Math.round(value * 100)\`. ` +
            `Better still, store money as integer ${minor} internally.`,
        }),
      );

      continue;
    }

    /*
     * ============================================================
     * 6. No conversion — trusted server price
     * ============================================================
     */
    if (isServerPriceExpression(node)) {
      continue;
    }

    /*
     * ============================================================
     * 7. Server price * quantity
     * ============================================================
     *
     * If the amount is an intermediate variable, this is the place
     * where the resolved expression is now recognized.
     *
     * Do NOT run client-taint detection against it.
     */
    if (serverPriceTimesQuantity) {
      continue;
    }

    /*
     * ============================================================
     * 8. Client-controlled amount
     * ============================================================
     *
     * Example:
     *
     *   const { amount } = await request.json();
     *
     *   razorpay.orders.create({
     *     amount,
     *   });
     *
     * This should produce MP002.
     *
     * A server price * quantity expression has already been excluded
     * above, so quantity cannot accidentally turn a safe server price
     * calculation into MP002.
     */
    const taint = isClientControlled(node);

    if (taint.tainted) {
      findings.push(
        buildFinding({
          rule: 'MP002',
          node,
          ctx,
          confidence: taint.viaOpaqueCall
            ? 'review'
            : 'confirmed',
          gateway: sink.gateway,
          impact:
            `Client-controlled payment amount reaches ${name} without conversion to ${minor}. ` +
            `A value intended as ${major} can be interpreted as ${minor}, causing the customer ` +
            `to be charged far less than intended — ${under}.`,
          fix:
            `Do not trust the client for the final price. ` +
            `Look the price up server-side and convert it to ${minor} exactly once with ` +
            `\`Math.round(value * 100)\` before calling ${name}.`,
          trace: taint.trace,
        }),
      );

      continue;
    }

    /*
     * ============================================================
     * 9. Numeric literal
     * ============================================================
     *
     * A small literal such as:
     *
     *   amount: 499
     *
     * is probably a rupee amount when sent directly to Razorpay.
     *
     * But:
     *
     *   amount: 49900
     *
     * may already be paise.
     */
    if (Node.isNumericLiteral(node)) {
      const value = node.getLiteralValue();

      if (
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value > 0 &&
        value < 10000
      ) {
        findings.push(
          buildFinding({
            rule: 'MP002',
            node,
            ctx,
            confidence: 'confirmed',
            gateway: sink.gateway,
            impact:
              `\`${sink.amountProp}\` uses the small integer literal ${value}, ` +
              `which looks like a ${major} amount, but ${name} expects ${minor}. ` +
              `The customer can be billed one hundredth of the intended price — ${under}.`,
            fix:
              `Convert the amount exactly once: ` +
              `\`Math.round(value * 100)\`. ` +
              `Better still, store money internally as integer ${minor}.`,
          }),
        );
      }

      continue;
    }

    /*
     * ============================================================
     * 10. Explicit major-unit variable
     * ============================================================
     */
    if (explicitlyMajorUnit(node)) {
      findings.push(
        buildFinding({
          rule: 'MP002',
          node,
          ctx,
          confidence: 'confirmed',
          gateway: sink.gateway,
          impact:
            `\`${sink.amountProp}\` is explicitly represented in ${major}, ` +
            `but ${name} charges in ${minor}. ` +
            `The customer can be billed one hundredth of the intended price — ${under}.`,
          fix:
            `Convert the value exactly once: \`Math.round(value * 100)\`. ` +
            `Better still, store money internally as integer ${minor} ` +
            `and name the variable accordingly.`,
        }),
      );

      continue;
    }

    /*
     * ============================================================
     * 11. Ambiguous amount / price / total
     * ============================================================
     *
     * Intentionally ignored.
     *
     * Examples:
     *
     *   amount
     *   price
     *   total
     *
     * These names alone do not prove the unit.
     */
  }

  return findings;
};
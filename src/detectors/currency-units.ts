import { Node, SyntaxKind } from 'ts-morph';
import { GATEWAY_USES_MINOR_UNIT, type Finding, type Gateway } from '../types';
import { identifiersIn } from '../analysis/ast';
import { buildFinding, gatewayName, type Detector } from './util';

/** Identifier names that read as a major-unit money value. */
const MAJOR_UNIT_NAME_RE =
  /(total|price|amount|subtotal|grand|fee|cost|mrp|charge|payable|rupees?|inr|usd|dollars?)/i;
/** Identifier names that say the value is already in the gateway's minor unit. */
const MINOR_UNIT_NAME_RE = /(paise|paisa|cents?|minor|smallest|_p\b|inPaise|inCents)/i;

const ROUNDING_RE = /Math\s*\.\s*(round|trunc|floor|ceil)|toFixed|BigInt|\|\s*0/;

interface Units {
  major: string;
  minor: string;
  /** Worked example of charging 1/100th of the intended price. */
  under: string;
  /** Worked example of charging 100x the intended price. */
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
  // Razorpay and Cashfree are both rupee gateways. They differ in which unit
  // they accept, not in the currency.
  return RUPEES;
}

/** Count how many times the expression multiplies by 100. */
function countConversions(text: string): number {
  const flat = text.replace(/\s+/g, '');
  const trailing = flat.match(/\*100(?![0-9.])/g)?.length ?? 0;
  const leading = flat.match(/(?<![0-9.])100\*/g)?.length ?? 0;
  return trailing + leading;
}

/** For `x * 100`, return the `x` side so we can tell integers from floats. */
function operandPairedWith100(node: Node): Node | undefined {
  const candidates = Node.isBinaryExpression(node)
    ? [node, ...node.getDescendantsOfKind(SyntaxKind.BinaryExpression)]
    : node.getDescendantsOfKind(SyntaxKind.BinaryExpression);

  for (const bin of candidates) {
    if (!Node.isBinaryExpression(bin)) continue;
    if (bin.getOperatorToken().getKind() !== SyntaxKind.AsteriskToken) continue;
    const left = bin.getLeft();
    const right = bin.getRight();
    if (Node.isNumericLiteral(right) && right.getLiteralValue() === 100) return left;
    if (Node.isNumericLiteral(left) && left.getLiteralValue() === 100) return right;
  }
  return undefined;
}

/**
 * MP002 / MP003 / MP004 / MP007 — currency unit bugs.
 *
 * Razorpay bills in paise and Stripe in cents, so the amount must be an integer
 * count of the minor unit. Cashfree bills in rupees as a decimal, so the same
 * conversion that is required for the first two is a 100x overcharge for the
 * third. This family is the most common integration mistake in Indian
 * checkouts and, unlike most logic flaws, it is decidable from the syntax
 * alone.
 */
export const currencyUnitDetector: Detector = (ctx): Finding[] => {
  const findings: Finding[] = [];

  for (const sink of ctx.sinks) {
    if (!sink.amountNode) continue;

    const node = sink.amountNode;
    const text = node.getText();
    const conversions = countConversions(text);
    const { major, minor, under, over } = units(sink.gateway);
    const name = gatewayName(sink.gateway);
    const names = identifiersIn(node);

    // Gateways that bill in the major unit invert this whole family. Cashfree
    // wants a decimal in rupees, so a fractional value is correct and the
    // conversion itself is the bug.
    if (!GATEWAY_USES_MINOR_UNIT[sink.gateway]) {
      if (conversions === 0) continue;

      findings.push(
        buildFinding({
          rule: 'MP007',
          node,
          ctx,
          confidence: 'confirmed',
          gateway: sink.gateway,
          impact: `${name} bills in ${major} as a decimal, not in ${minor}. Multiplying by 100 here charges the customer 100x the intended price — ${over}.`,
          fix: `Pass the rupee value straight through: \`order_amount: total\`, not \`total * 100\`. If your codebase stores money in ${minor}, divide at this boundary rather than multiplying.`,
        }),
      );
      continue;
    }

    if (conversions >= 2) {
      findings.push(
        buildFinding({
          rule: 'MP004',
          node,
          ctx,
          confidence: 'confirmed',
          gateway: sink.gateway,
          impact: `The value is multiplied by 100 ${conversions === 2 ? 'twice' : `${conversions} times`} before reaching ${name}, so the customer is charged 100x the intended price — ${over}.`,
          fix: `Convert to ${minor} exactly once, at the boundary where you call ${name}. Keep one representation internally and name the variable for its unit.`,
        }),
      );
      continue;
    }

    if (conversions === 1) {
      if (ROUNDING_RE.test(text)) continue;

      const other = operandPairedWith100(node);
      if (other && Node.isNumericLiteral(other) && Number.isInteger(other.getLiteralValue())) {
        continue; // `499 * 100` is exact.
      }

      const isFloatLiteral =
        other !== undefined &&
        Node.isNumericLiteral(other) &&
        !Number.isInteger(other.getLiteralValue());

      findings.push(
        buildFinding({
          rule: 'MP003',
          node,
          ctx,
          confidence: isFloatLiteral ? 'confirmed' : 'review',
          gateway: sink.gateway,
          impact: isFloatLiteral
            ? `\`${text}\` evaluates to a non-integer because of binary floating point. ${name} requires an integer count of ${minor} and will reject or silently mishandle it.`
            : `If this value is ever fractional, multiplying by 100 yields something like 49999.00000000001. ${name} requires an integer number of ${minor}.`,
          fix: `Wrap the conversion: \`Math.round(value * 100)\`. Better still, store money as an integer count of ${minor} everywhere and never convert at all.`,
        }),
      );
      continue;
    }

    // No conversion at all — decide whether the value looks like a major unit.
    if (names.some((n) => MINOR_UNIT_NAME_RE.test(n))) continue;

    let confidence: 'confirmed' | 'review' | null = null;

    if (Node.isNumericLiteral(node)) {
      const value = node.getLiteralValue();
      if (!Number.isInteger(value)) confidence = 'confirmed';
      else if (value > 0 && value < 1000) confidence = 'review';
    } else if (names.some((n) => MAJOR_UNIT_NAME_RE.test(n))) {
      confidence = 'review';
    }

    if (confidence === null) continue;

    findings.push(
      buildFinding({
        rule: 'MP002',
        node,
        ctx,
        confidence,
        gateway: sink.gateway,
        impact: `\`${sink.amountProp}\` looks like a value in ${major}, but ${name} charges in ${minor}. If so, every customer is billed one hundredth of the price — ${under}.`,
        fix: `Multiply by 100 exactly once at the call site and round: \`Math.round(total * 100)\`. If the value is already in ${minor}, rename it (\`amountInPaise\`) so this is obvious to the next reader and to this scanner.`,
      }),
    );
  }

  return findings;
};

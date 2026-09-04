import { Node, SyntaxKind } from 'ts-morph';

import { traceClientTaint } from '../analysis/taint';

import { buildFinding, gatewayName, type Detector } from './util';

/**
 * Determine whether the client-provided quantity is visibly validated.
 *
 * We intentionally use conservative source-text checks here because this
 * detector is a static-analysis rule and does not need to understand the
 * complete semantics of every validation library.
 */
function isValidatedQuantity(quantity: Node): boolean {
  const functionBody =
    quantity.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getBody() ??
    quantity.getFirstAncestorByKind(SyntaxKind.ArrowFunction)?.getBody();

  if (!functionBody) {
    return false;
  }

  const bodyText = functionBody.getText();

  /*
   * ---------------------------------------------------------------
   * 1. Explicit positive-integer validation
   *
   * Examples:
   *
   *   if (!Number.isInteger(quantity) || quantity < 1) {
   *     throw new Error(...);
   *   }
   *
   *   if (!Number.isInteger(quantity) || quantity <= 0) {
   *     throw new Error(...);
   *   }
   * ---------------------------------------------------------------
   */
  const hasIntegerCheck =
    /Number\.isInteger\s*\(\s*quantity\s*\)/.test(bodyText);

  const hasPositiveCheck =
    /quantity\s*<\s*1/.test(bodyText) ||
    /quantity\s*<=\s*0/.test(bodyText) ||
    /quantity\s*>\s*0/.test(bodyText);

  if (hasIntegerCheck && hasPositiveCheck) {
    return true;
  }

  /*
   * ---------------------------------------------------------------
   * 2. Normalisation to a positive integer
   *
   * Example:
   *
   *   const quantity = Math.max(
   *     1,
   *     Math.floor(Number(input.quantity))
   *   );
   *
   * Also allow the same expression without whitespace differences.
   * ---------------------------------------------------------------
   */
  const normalisedQuantity =
    /Math\.max\s*\(\s*1\s*,\s*Math\.floor\s*\(\s*Number\s*\(\s*quantity\s*\)\s*\)\s*\)/.test(
      bodyText,
    );

  if (normalisedQuantity) {
    return true;
  }

  /*
   * ---------------------------------------------------------------
   * 3. Common schema validation
   *
   * Examples:
   *
   *   quantitySchema.parse(quantity)
   *   quantitySchema.safeParse(quantity)
   *   schema.validate(quantity)
   *
   * We only regard a schema call as relevant when the call actually
   * mentions `quantity`. This avoids treating an unrelated `.parse()`
   * elsewhere in the function as quantity validation.
   * ---------------------------------------------------------------
   */
  const schemaValidatesQuantity =
    /[\w$.]+\.(?:parse|safeParse|validate)\s*\(\s*quantity\b/.test(
      bodyText,
    );

  if (schemaValidatesQuantity) {
    return true;
  }

  /*
   * ---------------------------------------------------------------
   * 4. Validation through Number(...) followed by integer/positive
   * checks.
   *
   * Examples:
   *
   *   const q = Number(quantity);
   *   if (!Number.isInteger(q) || q <= 0) ...
   *
   * We already catch direct `quantity` checks above. This additionally
   * handles the common normalized-variable pattern.
   * ---------------------------------------------------------------
   */
  const hasNumberConversion =
    /Number\s*\(\s*quantity\s*\)/.test(bodyText);

  const hasGenericIntegerValidation =
    /Number\.isInteger\s*\(\s*\w+\s*\)/.test(bodyText);

  const hasGenericPositiveValidation =
    /\b\w+\s*<\s*1\b/.test(bodyText) ||
    /\b\w+\s*<=\s*0\b/.test(bodyText);

  if (
    hasNumberConversion &&
    hasGenericIntegerValidation &&
    hasGenericPositiveValidation
  ) {
    return true;
  }

  /*
   * ---------------------------------------------------------------
   * 5. Explicit rejection of invalid quantities.
   *
   * Examples:
   *
   *   if (quantity <= 0) throw ...
   *   if (quantity < 1) throw ...
   *
   * This is intentionally conservative. We do not assume that merely
   * checking `quantity > 0` proves integer-ness.
   * ---------------------------------------------------------------
   */
  if (
    /quantity\s*<=\s*0/.test(bodyText) ||
    /quantity\s*<\s*1/.test(bodyText)
  ) {
    /*
     * A positive-integer check is strongest when combined with
     * Number.isInteger. If only the lower bound exists, it is not
     * sufficient to prove that fractional quantities are rejected.
     *
     * Therefore do not return true here unless the source also gives
     * us evidence of integer validation.
     */
    if (hasIntegerCheck) {
      return true;
    }
  }

  return false;
}

/**
 * Detect client-controlled quantities used in payment amount
 * multiplication.
 *
 * Example:
 *
 *   const quantity = Number(body.quantity);
 *   const amount = product.price * quantity;
 *
 * This produces MP008 when `quantity` is client-controlled and there
 * is no visible validation.
 *
 * Important:
 *
 * MP008 is deliberately separate from MP001/MP002.
 *
 * A server-side price multiplied by a client quantity is NOT itself
 * a client-controlled payment amount:
 *
 *   product.price * quantity
 *
 * The price remains authoritative. MP008 is responsible for the
 * quantity validation problem.
 */
export const clientQuantityDetector: Detector = ({
  sourceFile,
  relPath,
  sinks,
}) => {
  const findings = [];

  for (const sink of sinks) {
    const call = sink.call;

    /*
     * Search identifiers inside the actual payment call.
     *
     * We intentionally only inspect identifiers named quantity here.
     * This keeps MP008 focused and prevents it from becoming a generic
     * arithmetic detector.
     */
    for (const identifier of call.getDescendantsOfKind(
      SyntaxKind.Identifier,
    )) {
      if (identifier.getText() !== 'quantity') {
        continue;
      }

      const parent = identifier.getParent();

      if (!parent || !Node.isBinaryExpression(parent)) {
        continue;
      }

      /*
       * We only care about multiplication:
       *
       *   price * quantity
       *   quantity * price
       */
      if (
        parent.getOperatorToken().getKind() !==
        SyntaxKind.AsteriskToken
      ) {
        continue;
      }

      /*
       * Determine whether this quantity can actually be traced back
       * to request/client input.
       *
       * Server/database quantities should not be reported.
       */
      const taint = traceClientTaint(identifier);

      if (!taint.tainted) {
        continue;
      }

      /*
       * A quantity with visible validation is safe from MP008.
       */
      if (isValidatedQuantity(identifier)) {
        continue;
      }

      const name = gatewayName(sink.gateway);

      const confidence = taint.viaOpaqueCall
        ? 'review'
        : 'confirmed';

      findings.push(
        buildFinding({
          rule: 'MP008',
          node: identifier,
          ctx: {
            sourceFile,
            relPath,
            sinks,
          },
          confidence,
          gateway: sink.gateway,

          impact:
            `The quantity multiplied into the ${sink.amountProp} sent to ${name} ` +
            `comes from ${taint.source} without visible validation. ` +
            `A negative, zero, fractional, or otherwise invalid quantity can ` +
            `alter the amount charged to the customer.`,

          fix:
            `Validate the client-provided quantity before using it in the payment ` +
            `calculation. Require a positive integer or validate the request with ` +
            `a schema such as Zod, Valibot, or Yup.`,

          trace: taint.trace,
        }),
      );
    }
  }

  return findings;
};
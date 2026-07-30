/**
 * Render a constraint expression for humans
 *
 * @module format
 */

import type { BinaryOp, ConstraintExpr } from "./types.ts";

/** Comparison operators rendered with their conventional symbol. */
const OP_SYMBOLS: Partial<Record<BinaryOp, string>> = {
  "<=": "≤",
  ">=": "≥",
  "!=": "≠",
};

/** Precedence, used only to decide where parentheses are needed. */
const PRECEDENCE: Partial<Record<string, number>> = {
  "or": 1,
  "and": 2,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "==": 3,
  "!=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
};

/**
 * Render an expression as a readable string.
 *
 * Examples:
 * - `totalMass ≤ 5 kg`
 * - `operatingTemp ≥ -10 and operatingTemp ≤ 80`
 * - `(a + b) * 2`
 */
export function exprToString(expr: ConstraintExpr): string {
  switch (expr.kind) {
    case "literal":
      return expr.unit ? `${expr.value} ${expr.unit}` : String(expr.value);
    case "ref":
      return expr.featurePath.join(".");
    case "binary": {
      const symbol = OP_SYMBOLS[expr.op] ?? expr.op;
      const precedence = PRECEDENCE[expr.op] ?? 0;
      return `${maybeParen(expr.left, precedence)} ${symbol} ${
        maybeParen(expr.right, precedence)
      }`;
    }
    case "unary":
      return expr.op === "not"
        ? `not(${exprToString(expr.operand)})`
        : `-${exprToString(expr.operand)}`;
    case "call":
      return `${expr.name}(${expr.args.map(exprToString).join(", ")})`;
  }
}

/** Parenthesise a sub-expression that binds more loosely than its parent. */
function maybeParen(expr: ConstraintExpr, parentPrecedence: number): string {
  const rendered = exprToString(expr);
  if (expr.kind === "binary") {
    const own = PRECEDENCE[expr.op] ?? 0;
    if (own < parentPrecedence) return `(${rendered})`;
  }
  return rendered;
}

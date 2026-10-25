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

/** Operators whose right operand cannot shed parentheses at the same level. */
const NON_ASSOCIATIVE = new Set<string>(["-", "/"]);

/**
 * Render an expression as a readable string.
 *
 * Examples:
 * - `totalMass ≤ 5 kg`
 * - `operatingTemp ≥ -10 and operatingTemp ≤ 80`
 * - `(a + b) * 2`
 * - `thrust / (totalMass * 9.81) ≥ 2`
 */
export function exprToString(expr: ConstraintExpr): string {
  switch (expr.kind) {
    case "literal":
      return expr.unit ? `${expr.value} ${expr.unit}` : String(expr.value);
    case "ref":
      return expr.featurePath.join(".");
    case "binary": {
      const symbol = OP_SYMBOLS[expr.op] ?? expr.op;
      return `${operand(expr.left, expr.op, "left")} ${symbol} ${
        operand(expr.right, expr.op, "right")
      }`;
    }
    case "unary": {
      if (expr.op === "not") return `not(${exprToString(expr.operand)})`;
      // A compound or negative operand keeps its parentheses: -(a + b),
      // -(-a), -(-5).
      const rendered = exprToString(expr.operand);
      return expr.operand.kind === "binary" || expr.operand.kind === "unary" ||
          isNegative(expr.operand)
        ? `-(${rendered})`
        : `-${rendered}`;
    }
    case "call":
      return `${expr.name}(${expr.args.map(exprToString).join(", ")})`;
  }
}

/** A negation, or a negative number. */
function isNegative(expr: ConstraintExpr): boolean {
  return (expr.kind === "unary" && expr.op === "-") ||
    (expr.kind === "literal" && expr.value < 0);
}

/**
 * Render an operand of `parentOp`, parenthesised wherever the bare text would
 * read as another expression or another value:
 * - it binds more loosely than its parent;
 * - it sits right of `-` or `/` at the same level (`a - (b - c)`,
 *   `a / (b * c)`);
 * - it is a comparison inside a comparison;
 * - it is a negative right of `-` (`a - (-b)`, `a - (-5)`);
 * - it is a quantity right of `*` or `/` (`5 / (2 kg)` is not `(5 / 2) kg`);
 * - its parent is an operator outside the precedence table.
 */
function operand(
  expr: ConstraintExpr,
  parentOp: BinaryOp,
  side: "left" | "right",
): string {
  const rendered = exprToString(expr);
  const grouped = `(${rendered})`;
  const parent = PRECEDENCE[parentOp];
  if (parent === undefined) {
    return expr.kind === "binary" ? grouped : rendered;
  }
  if (
    expr.kind === "literal" && expr.unit && side === "right" &&
    (parentOp === "*" || parentOp === "/")
  ) return grouped;
  if (isNegative(expr)) {
    return side === "right" && parentOp === "-" ? grouped : rendered;
  }
  if (expr.kind !== "binary") return rendered;
  const own = PRECEDENCE[expr.op] ?? 0;
  const sameLevelNeedsParens = own === parent &&
    (parent === PRECEDENCE["<"] ||
      (side === "right" && NON_ASSOCIATIVE.has(parentOp)));
  return own < parent || sameLevelNeedsParens ? grouped : rendered;
}

/**
 * Static dimensional checking
 *
 * Finds unit problems without needing any resolved values: unknown unit
 * symbols, and comparisons that mix incompatible dimensions. Useful as a
 * pre-flight check on a model before values exist.
 *
 * @module units
 */

import { all, create } from "mathjs";
import { exprToString } from "./format.ts";
import type {
  Constraint,
  ConstraintExpr,
  UnitIssue,
  UnitReport,
} from "./types.ts";

const math = create(all, {});

/** Comparison operators — the places where dimensions must agree. */
const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!="]);

/** Collect the unit symbols a sub-expression carries, literals only. */
function unitsOf(expr: ConstraintExpr): string[] {
  switch (expr.kind) {
    case "literal":
      return expr.unit ? [expr.unit] : [];
    case "ref":
      // A reference's unit is only known once resolved — not a static concern.
      return [];
    case "unary":
      return unitsOf(expr.operand);
    case "call":
      return expr.args.flatMap(unitsOf);
    case "binary":
      return [...unitsOf(expr.left), ...unitsOf(expr.right)];
  }
}

/** Whether mathjs recognises a unit symbol. */
function isKnownUnit(unit: string): boolean {
  try {
    math.unit(1, unit);
    return true;
  } catch {
    return false;
  }
}

/** Whether two unit symbols measure the same physical dimension. */
function sameDimension(a: string, b: string): boolean {
  try {
    // deno-lint-ignore no-explicit-any -- Unit is not in mathjs' exported types
    return (math.unit(1, a) as any).equalBase(math.unit(1, b));
  } catch {
    return false;
  }
}

/**
 * Walk an expression, reporting dimensional problems.
 *
 * Unknown-unit checks fire on the literal that carries the symbol, never via
 * the recursive `unitsOf` — doing both would report the same symbol once per
 * level of the tree.
 */
function checkExpr(
  expr: ConstraintExpr,
  constraint: Constraint,
  issues: UnitIssue[],
): void {
  if (expr.kind === "literal" && expr.unit && !isKnownUnit(expr.unit)) {
    issues.push({
      constraintId: constraint.id,
      constraintName: constraint.name,
      kind: "unknown-unit",
      detail: `Unit '${expr.unit}' is not recognised, in: ${exprToString(expr)}`,
    });
  }

  if (expr.kind === "binary" && COMPARISONS.has(expr.op)) {
    const left = unitsOf(expr.left).filter(isKnownUnit);
    const right = unitsOf(expr.right).filter(isKnownUnit);

    if (left.length > 0 && right.length > 0 && !sameDimension(left[0], right[0])) {
      issues.push({
        constraintId: constraint.id,
        constraintName: constraint.name,
        kind: "mixed-dimensions",
        detail:
          `Comparing '${left[0]}' with '${right[0]}' — different dimensions, ` +
          `in: ${exprToString(expr)}`,
      });
    }
  }

  if (expr.kind === "binary") {
    checkExpr(expr.left, constraint, issues);
    checkExpr(expr.right, constraint, issues);
  } else if (expr.kind === "unary") {
    checkExpr(expr.operand, constraint, issues);
  } else if (expr.kind === "call") {
    for (const arg of expr.args) checkExpr(arg, constraint, issues);
  }
}

/**
 * Check a set of constraints for dimensional problems.
 *
 * Reports only what is statically decidable from literals; a unit carried by
 * an unresolved reference is not an issue, it is simply unknown.
 */
export function checkUnits(constraints: Constraint[]): UnitReport {
  const issues: UnitIssue[] = [];
  for (const constraint of constraints) {
    checkExpr(constraint.expression, constraint, issues);
  }
  return { checked: constraints.length, issues };
}

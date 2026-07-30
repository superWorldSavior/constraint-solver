/**
 * Constraint evaluation over mathjs
 *
 * Numbers carrying units are evaluated as quantities, not as bare numbers:
 * `2.5 kg ≤ 4 lb` is false because 2.5 kg is 5.5 lb. Comparing a quantity to
 * a dimensionless number, or to a quantity of another dimension, is reported
 * as an error rather than silently compared numerically — the failure mode
 * that makes an unsound oracle worse than no oracle.
 *
 * @module evaluate
 */

import { all, create, type MathType } from "mathjs";
import { exprToString } from "./format.ts";
import type {
  Constraint,
  ConstraintExpr,
  ConstraintResult,
  ConstraintStatus,
  EvaluationReport,
  EvaluationSummary,
  ValueMap,
} from "./types.ts";

const math = create(all, {});

/** Raised when an expression cannot be evaluated. */
export class EvalError extends Error {
  constructor(message: string, readonly unresolvedRefs?: string[]) {
    super(message);
    this.name = "EvalError";
  }
}

/** Function names callable from an expression, mapped to mathjs. */
const CALLABLE: Record<string, (...args: MathType[]) => MathType> = {
  abs: (x) => math.abs(x as number),
  min: (...xs) => math.min(...(xs as number[])),
  max: (...xs) => math.max(...(xs as number[])),
  sqrt: (x) => math.sqrt(x as number) as MathType,
  round: (x) => math.round(x as number) as MathType,
  floor: (x) => math.floor(x as number) as MathType,
  ceil: (x) => math.ceil(x as number) as MathType,
};

/**
 * Build a mathjs value from a number and an optional unit.
 * @throws EvalError if the unit symbol is not recognised
 */
function quantity(value: number, unit?: string): MathType {
  if (!unit) return value;
  try {
    return math.unit(value, unit) as MathType;
    // deno-lint-ignore no-explicit-any -- mathjs throws plain Error for unknown units
  } catch (e: any) {
    throw new EvalError(
      `Unknown unit '${unit}': ${e?.message ?? "unrecognised by mathjs"}`,
    );
  }
}

/** True when a mathjs value carries a dimension. */
function isUnit(v: MathType): boolean {
  return math.isUnit(v);
}

/**
 * Apply a comparison, refusing dimensionally incompatible operands.
 *
 * mathjs already throws when comparing a Unit to a number, but its message is
 * generic; this restates it in terms the caller can act on.
 */
function compare(op: string, left: MathType, right: MathType): boolean {
  if (isUnit(left) !== isUnit(right)) {
    const dimensioned = isUnit(left) ? "left" : "right";
    throw new EvalError(
      `Cannot compare a quantity to a dimensionless number ` +
        `(${dimensioned} side has a unit, the other does not). ` +
        `Give both sides a unit, or neither.`,
    );
  }

  try {
    switch (op) {
      case "<":
        return math.smaller(left, right) as boolean;
      case "<=":
        return math.smallerEq(left, right) as boolean;
      case ">":
        return math.larger(left, right) as boolean;
      case ">=":
        return math.largerEq(left, right) as boolean;
      case "==":
        return math.equal(left, right) as boolean;
      case "!=":
        return math.unequal(left, right) as boolean;
      default:
        throw new EvalError(`Unsupported comparison operator '${op}'`);
    }
    // deno-lint-ignore no-explicit-any -- mathjs signals dimension mismatch with a plain Error
  } catch (e: any) {
    if (e instanceof EvalError) throw e;
    throw new EvalError(
      `Incompatible units in '${op}': ${e?.message ?? "dimension mismatch"}`,
    );
  }
}

/**
 * Evaluate an expression against resolved values.
 *
 * @throws EvalError on unresolved references, unknown units, dimension
 *         mismatches or division by zero
 */
export function evaluate(expr: ConstraintExpr, values: ValueMap): MathType | boolean {
  switch (expr.kind) {
    case "literal":
      return quantity(expr.value, expr.unit);

    case "ref": {
      const path = expr.featurePath.join(".");
      const resolved = values.get(path);
      if (resolved === undefined) {
        throw new EvalError(`Unresolved reference: ${path}`, [path]);
      }
      return quantity(resolved.value, resolved.unit);
    }

    case "unary": {
      const operand = evaluate(expr.operand, values);
      if (expr.op === "not") {
        if (typeof operand !== "boolean") {
          throw new EvalError("'not' expects a boolean operand");
        }
        return !operand;
      }
      return math.unaryMinus(operand as MathType) as MathType;
    }

    case "call": {
      const fn = CALLABLE[expr.name];
      if (!fn) {
        throw new EvalError(
          `Unknown function '${expr.name}'. Available: ${
            Object.keys(CALLABLE).join(", ")
          }`,
        );
      }
      const args = expr.args.map((a) => evaluate(a, values) as MathType);
      return fn(...args);
    }

    case "binary": {
      if (expr.op === "and" || expr.op === "or") {
        const left = evaluate(expr.left, values);
        const right = evaluate(expr.right, values);
        if (typeof left !== "boolean" || typeof right !== "boolean") {
          throw new EvalError(`'${expr.op}' expects boolean operands`);
        }
        return expr.op === "and" ? left && right : left || right;
      }

      const left = evaluate(expr.left, values) as MathType;
      const right = evaluate(expr.right, values) as MathType;

      switch (expr.op) {
        case "+":
          return math.add(left, right) as MathType;
        case "-":
          return math.subtract(left, right) as MathType;
        case "*":
          return math.multiply(left, right) as MathType;
        case "/":
          if (!isUnit(right) && right === 0) {
            throw new EvalError("Division by zero");
          }
          return math.divide(left, right) as MathType;
        default:
          return compare(expr.op, left, right);
      }
    }
  }
}

/** Numeric magnitude of a mathjs value, converted into `unit` when given. */
function magnitude(v: MathType, unit?: string): number {
  if (isUnit(v)) {
    // deno-lint-ignore no-explicit-any -- Unit is not in mathjs' exported types
    const u = v as any;
    return unit ? u.toNumber(unit) : u.toNumber();
  }
  return v as number;
}

/**
 * Comparison details for a top-level comparison: the two sides, the distance
 * between them, and the unit they are expressed in.
 *
 * Returns an empty object for non-comparison expressions (a conjunction has no
 * single threshold). This is additive information — its absence never changes
 * the pass/fail verdict.
 */
function comparisonDetail(
  expr: ConstraintExpr,
  values: ValueMap,
): Pick<
  ConstraintResult,
  "computedValue" | "threshold" | "margin" | "marginPercent" | "unit"
> {
  if (expr.kind !== "binary") return {};
  if (!["<", "<=", ">", ">=", "==", "!="].includes(expr.op)) return {};

  const left = evaluate(expr.left, values) as MathType;
  const right = evaluate(expr.right, values) as MathType;

  // Express both sides in the threshold's unit: an engineer reads the margin
  // against the limit they wrote, not against the computed side.
  // deno-lint-ignore no-explicit-any -- Unit is not in mathjs' exported types
  const unit = isUnit(right) ? (right as any).formatUnits() : undefined;
  const computedValue = magnitude(left, unit);
  const threshold = magnitude(right, unit);

  const margin = expr.op === ">" || expr.op === ">="
    ? computedValue - threshold
    : expr.op === "==" || expr.op === "!="
    ? Math.abs(computedValue - threshold)
    : threshold - computedValue;

  const marginPercent = threshold !== 0
    ? Math.round((margin / Math.abs(threshold)) * 10000) / 100
    : undefined;

  return { computedValue, threshold, margin, marginPercent, unit };
}

/** Evaluate one constraint, never throwing — failures become a status. */
export function evaluateConstraint(
  constraint: Constraint,
  values: ValueMap,
): ConstraintResult {
  const base = {
    constraintId: constraint.id,
    constraintName: constraint.name,
    expression: exprToString(constraint.expression),
  };

  let result: MathType | boolean;
  try {
    result = evaluate(constraint.expression, values);
  } catch (e) {
    if (e instanceof EvalError && e.unresolvedRefs) {
      return { ...base, status: "unresolved", unresolvedRefs: e.unresolvedRefs };
    }
    return {
      ...base,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (typeof result !== "boolean") {
    return {
      ...base,
      status: "error",
      error:
        `Expression evaluated to a value (${result}) rather than a condition. ` +
        `A constraint must compare something.`,
    };
  }

  const status: ConstraintStatus = result ? "pass" : "fail";

  // Margin extraction can fail where evaluation succeeded (a conjunction has
  // no single threshold). Report the verdict without it rather than lose it.
  try {
    return { ...base, status, ...comparisonDetail(constraint.expression, values) };
  } catch {
    return { ...base, status };
  }
}

/** Evaluate a set of constraints and summarise the outcome. */
export function evaluateAll(
  constraints: Constraint[],
  values: ValueMap,
): EvaluationReport {
  const results = constraints.map((c) => evaluateConstraint(c, values));

  const summary: EvaluationSummary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    error: results.filter((r) => r.status === "error").length,
    unresolved: results.filter((r) => r.status === "unresolved").length,
  };

  return { results, summary };
}

/** Build a ValueMap from a plain object, for callers that have no Map. */
export function toValueMap(
  values: Record<string, number | { value: number; unit?: string }>,
): ValueMap {
  const map: ValueMap = new Map();
  for (const [path, v] of Object.entries(values)) {
    map.set(path, typeof v === "number" ? { value: v } : v);
  }
  return map;
}

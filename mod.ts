/**
 * @casys/constraint-solver
 *
 * Evaluates parametric constraints, with units treated as part of the value.
 * Nothing here knows about SysML, CAD or FEA — any producer emitting the
 * {@link Constraint} shape can be evaluated, which is what lets a SysML model,
 * an FEA result and a hand-written problem share one solver.
 *
 * ```ts
 * import { evaluateAll, toValueMap } from "@casys/constraint-solver";
 *
 * const report = evaluateAll(
 *   [{
 *     id: "c1",
 *     name: "mass budget",
 *     expression: {
 *       kind: "binary",
 *       op: "<=",
 *       left: { kind: "ref", featurePath: ["totalMass"] },
 *       right: { kind: "literal", value: 4, unit: "lb" },
 *     },
 *   }],
 *   toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
 * );
 * // → status "fail": 2.5 kg is 5.51 lb, over the 4 lb limit
 * ```
 *
 * @module
 */

export { EvalError, evaluate, evaluateAll, evaluateConstraint, toValueMap } from "./src/evaluate.ts";
export { checkUnits } from "./src/units.ts";
export { exprToString } from "./src/format.ts";
export { SmtTranslationError, solve, Z3NotFoundError } from "./src/solve.ts";
export type { SolveOptions, SolveResult } from "./src/solve.ts";
export { toSmtLib } from "./src/smtlib.ts";
export type { SmtOptions, SmtScript } from "./src/smtlib.ts";

export type {
  BinaryExpr,
  BinaryOp,
  CallExpr,
  Constraint,
  ConstraintExpr,
  ConstraintResult,
  ConstraintStatus,
  EvaluationReport,
  EvaluationSummary,
  LiteralExpr,
  QuantityValue,
  RefExpr,
  UnaryExpr,
  UnaryOp,
  UnitIssue,
  UnitReport,
  ValueMap,
} from "./src/types.ts";

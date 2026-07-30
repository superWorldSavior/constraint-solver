/**
 * Constraint types — pure data, no runtime dependencies
 *
 * These mirror a simplified SysML v2 / KerML expression AST, but nothing here
 * is tied to SysML: any producer able to emit this shape can be evaluated.
 * Keeping the contract free of source-specific fields is what lets a SysML
 * model, an FEA result and a hand-written problem share one solver.
 *
 * @module types
 */

// ============================================================================
// Expression AST
// ============================================================================

/** Binary operators: arithmetic, comparison, logical. */
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "and"
  | "or";

/** Unary operators. */
export type UnaryOp = "not" | "-";

/** An expression node. */
export type ConstraintExpr =
  | LiteralExpr
  | RefExpr
  | BinaryExpr
  | UnaryExpr
  | CallExpr;

/**
 * A numeric constant, optionally carrying a unit.
 *
 * The unit is part of the value, not decoration: `4 lb` and `4 kg` are
 * different quantities and comparing either against a bare `4` is an error,
 * not a silent numeric comparison.
 */
export interface LiteralExpr {
  kind: "literal";
  value: number;
  /** Unit symbol as written in the source model, e.g. "kg", "lb", "MPa". */
  unit?: string;
}

/**
 * A reference to a named value, given as a dotted path.
 * Example: `["totalMass"]` or `["propulsion", "thrust"]`.
 */
export interface RefExpr {
  kind: "ref";
  featurePath: string[];
  /** Optional identifier from the source model, passed through untouched. */
  elementId?: string;
}

/** `left op right` */
export interface BinaryExpr {
  kind: "binary";
  op: BinaryOp;
  left: ConstraintExpr;
  right: ConstraintExpr;
}

/** `op operand` */
export interface UnaryExpr {
  kind: "unary";
  op: UnaryOp;
  operand: ConstraintExpr;
}

/** A function call such as `abs`, `min`, `max`, `sqrt`. */
export interface CallExpr {
  kind: "call";
  name: string;
  args: ConstraintExpr[];
}

// ============================================================================
// Input
// ============================================================================

/** A constraint to evaluate, with the identity its producer gave it. */
export interface Constraint {
  id: string;
  name: string;
  expression: ConstraintExpr;
  /** Free-form origin marker, e.g. a model element ID. Never interpreted. */
  sourceId?: string;
}

/** A resolved value, with its unit when the source model declares one. */
export interface QuantityValue {
  value: number;
  /** Unit symbol, e.g. "kg". Absent means dimensionless. */
  unit?: string;
}

/**
 * Resolved values keyed by dotted feature path.
 *
 * A path absent from the map is *not* zero — it makes every constraint
 * referencing it `unresolved`, so a missing input can never be mistaken
 * for a satisfied constraint.
 */
export type ValueMap = Map<string, QuantityValue>;

// ============================================================================
// Output
// ============================================================================

/**
 * Outcome of one constraint.
 *
 * `unresolved` and `error` are first-class outcomes, distinct from `fail`:
 * "I could not decide" must never be reported as "the constraint holds".
 */
export type ConstraintStatus = "pass" | "fail" | "error" | "unresolved";

export interface ConstraintResult {
  constraintId: string;
  constraintName: string;
  status: ConstraintStatus;
  /** The expression rendered for humans, e.g. `totalMass ≤ 5 kg`. */
  expression: string;
  /** Left-hand side of a comparison, in `unit`. */
  computedValue?: number;
  /** Right-hand side of a comparison, in `unit`. */
  threshold?: number;
  /** Distance to the threshold; positive means the constraint holds. */
  margin?: number;
  /** Margin as a percentage of the threshold. */
  marginPercent?: number;
  /** Unit that `computedValue`, `threshold` and `margin` are expressed in. */
  unit?: string;
  /** Present when `status` is `"error"`. */
  error?: string;
  /** Feature paths that could not be resolved; present when `unresolved`. */
  unresolvedRefs?: string[];
}

export interface EvaluationSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  unresolved: number;
}

export interface EvaluationReport {
  results: ConstraintResult[];
  summary: EvaluationSummary;
}

// ============================================================================
// Unit checking
// ============================================================================

/** A dimensional problem found without evaluating anything. */
export interface UnitIssue {
  constraintId: string;
  constraintName: string;
  /** `mixed-dimensions` compares incompatible units; `unknown-unit` is unparseable. */
  kind: "mixed-dimensions" | "unknown-unit";
  detail: string;
}

export interface UnitReport {
  checked: number;
  issues: UnitIssue[];
}

/**
 * SMT-LIB2 generation
 *
 * Translates the constraint AST into an SMT-LIB2 script for z3. Pure text
 * generation — no solver dependency, fully testable on its own.
 *
 * Units are normalised before z3 ever sees a number: a literal carrying a
 * unit is converted to SI base units via mathjs, and every variable sharing a
 * constraint with that literal is solved in the same SI base. z3 itself has
 * no notion of physical dimension, so this is where `4 lb` becomes
 * `1.8143 kg` — otherwise the solver would happily mix pounds and kilograms.
 *
 * @module smtlib
 */

import { all, create } from "mathjs";
import { exprToString } from "./format.ts";
import type { Constraint, ConstraintExpr, ValueMap } from "./types.ts";

const math = create(all, {});

/** Raised when a constraint cannot be translated to SMT-LIB2. */
export class SmtTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtTranslationError";
  }
}

/** A generated script plus what is needed to interpret z3's answer. */
export interface SmtScript {
  script: string;
  /** SMT assertion name (c0, c1, …) → constraint id, for unsat cores. */
  assertionIds: Map<string, string>;
  /** Variable path → SI base unit symbol its values are expressed in. */
  variableUnits: Map<string, string | undefined>;
}

export interface SmtOptions {
  /** Values fixed before solving, asserted as equalities. */
  fixed?: ValueMap;
  /** Objective on one variable. */
  objective?: { variable: string; direction: "minimize" | "maximize" };
  /** Soft time limit passed to z3, in milliseconds. */
  timeoutMs?: number;
}

// ── Unit normalisation ──────────────────────────────────────────────────────

/** `4, "lb"` → SI base magnitude (1.8143…) and its unit symbol ("kg"). */
function toSiBase(value: number, unit: string): { value: number; unit: string } {
  let si;
  try {
    si = math.unit(value, unit).toSI();
    // deno-lint-ignore no-explicit-any -- mathjs throws plain Error for unknown units
  } catch (e: any) {
    throw new SmtTranslationError(
      `Unknown unit '${unit}': ${e?.message ?? "unrecognised by mathjs"}`,
    );
  }
  // deno-lint-ignore no-explicit-any -- Unit is not in mathjs' exported types
  const u = si as any;
  return { value: u.toNumber(), unit: u.formatUnits() };
}

/**
 * Infer, per variable, the SI base unit it should be solved in.
 *
 * Inference is deliberately simple: the first unit-carrying literal found in
 * the same constraint as a variable sets that variable's dimension. Run
 * `checkUnits` first if the model might mix dimensions — this pass does not
 * re-diagnose what that one already reports.
 */
function inferVariableUnits(
  constraints: Constraint[],
): Map<string, string | undefined> {
  const units = new Map<string, string | undefined>();

  for (const constraint of constraints) {
    const refs: string[] = [];
    let unitSeen: string | undefined;

    const walk = (expr: ConstraintExpr): void => {
      switch (expr.kind) {
        case "literal":
          if (expr.unit && unitSeen === undefined) unitSeen = expr.unit;
          return;
        case "ref":
          refs.push(expr.featurePath.join("."));
          return;
        case "unary":
          return walk(expr.operand);
        case "call":
          expr.args.forEach(walk);
          return;
        case "binary":
          walk(expr.left);
          walk(expr.right);
          return;
      }
    };
    walk(constraint.expression);

    const siUnit = unitSeen ? toSiBase(1, unitSeen).unit : undefined;
    for (const ref of refs) {
      if (!units.has(ref) || units.get(ref) === undefined) {
        units.set(ref, siUnit);
      }
    }
  }

  return units;
}

// ── Expression translation ──────────────────────────────────────────────────

/** Format a number as an SMT-LIB2 Real literal. */
function numToSmt(n: number): string {
  if (!Number.isFinite(n)) {
    throw new SmtTranslationError(`Cannot translate non-finite number: ${n}`);
  }
  if (n < 0) return `(- ${numToSmt(-n)})`;
  // A Real literal needs a decimal point; toFixed keeps us out of exponent
  // notation, which SMT-LIB2 does not accept.
  const rendered = Number.isInteger(n) ? `${n}.0` : n.toFixed(12).replace(/0+$/, "").replace(/\.$/, ".0");
  return rendered;
}

/** Quote a variable path as an SMT-LIB2 symbol — dots are not symbol chars. */
function symbol(path: string): string {
  return `|${path}|`;
}

/** Functions translatable to SMT-LIB2. Everything else must be rejected. */
const SOLVABLE_CALLS = new Set(["abs", "min", "max"]);

function exprToSmt(expr: ConstraintExpr): string {
  switch (expr.kind) {
    case "literal": {
      const value = expr.unit ? toSiBase(expr.value, expr.unit).value : expr.value;
      return numToSmt(value);
    }

    case "ref":
      return symbol(expr.featurePath.join("."));

    case "unary":
      return expr.op === "not"
        ? `(not ${exprToSmt(expr.operand)})`
        : `(- ${exprToSmt(expr.operand)})`;

    case "binary": {
      const left = exprToSmt(expr.left);
      const right = exprToSmt(expr.right);
      switch (expr.op) {
        case "==":
          return `(= ${left} ${right})`;
        case "!=":
          return `(not (= ${left} ${right}))`;
        default:
          return `(${expr.op} ${left} ${right})`;
      }
    }

    case "call": {
      if (!SOLVABLE_CALLS.has(expr.name)) {
        throw new SmtTranslationError(
          `Function '${expr.name}' is not solvable. solve() supports: ${
            [...SOLVABLE_CALLS].join(", ")
          }. (evaluate() additionally supports sqrt, round, floor, ceil.)`,
        );
      }
      const args = expr.args.map(exprToSmt);
      if (expr.name === "abs") {
        const [x] = args;
        return `(ite (>= ${x} 0.0) ${x} (- ${x}))`;
      }
      // min/max over 2+ arguments, as nested ite
      const op = expr.name === "min" ? "<=" : ">=";
      return args.reduce((acc, x) => `(ite (${op} ${acc} ${x}) ${acc} ${x})`);
    }
  }
}

// ── Script assembly ─────────────────────────────────────────────────────────

/** Collect every variable path referenced across the constraints. */
function collectVariables(constraints: Constraint[]): string[] {
  const paths = new Set<string>();
  const walk = (expr: ConstraintExpr): void => {
    switch (expr.kind) {
      case "ref":
        paths.add(expr.featurePath.join("."));
        return;
      case "unary":
        return walk(expr.operand);
      case "call":
        expr.args.forEach(walk);
        return;
      case "binary":
        walk(expr.left);
        walk(expr.right);
        return;
      case "literal":
        return;
    }
  };
  for (const c of constraints) walk(c.expression);
  return [...paths].sort();
}

/**
 * Build the SMT-LIB2 script for a set of constraints.
 *
 * @throws SmtTranslationError on unknown units, unsupported functions or
 *         non-finite numbers — before z3 is ever involved
 */
export function toSmtLib(
  constraints: Constraint[],
  options?: SmtOptions,
): SmtScript {
  const variableUnits = inferVariableUnits(constraints);
  const assertionIds = new Map<string, string>();
  const lines: string[] = [];

  lines.push("(set-option :produce-unsat-cores true)");
  if (options?.timeoutMs) {
    lines.push(`(set-option :timeout ${Math.floor(options.timeoutMs)})`);
  }

  for (const path of collectVariables(constraints)) {
    lines.push(`(declare-const ${symbol(path)} Real)`);
  }

  constraints.forEach((constraint, i) => {
    const name = `c${i}`;
    assertionIds.set(name, constraint.id);
    let smt;
    try {
      smt = exprToSmt(constraint.expression);
    } catch (e) {
      if (e instanceof SmtTranslationError) {
        throw new SmtTranslationError(
          `Constraint '${constraint.id}' (${
            exprToString(constraint.expression)
          }): ${e.message}`,
        );
      }
      throw e;
    }
    lines.push(`(assert (! ${smt} :named ${name}))`);
  });

  if (options?.fixed) {
    for (const [path, quantity] of options.fixed) {
      const value = quantity.unit
        ? toSiBase(quantity.value, quantity.unit).value
        : quantity.value;
      lines.push(`(assert (= ${symbol(path)} ${numToSmt(value)}))`);
    }
  }

  if (options?.objective) {
    const { variable, direction } = options.objective;
    lines.push(`(${direction} ${symbol(variable)})`);
  }

  lines.push("(check-sat)");
  lines.push("(get-model)");
  if (options?.objective) lines.push("(get-objectives)");
  lines.push("(get-unsat-core)");

  return { script: lines.join("\n"), assertionIds, variableUnits };
}

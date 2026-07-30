/**
 * Solving tests — require the z3 executable on PATH
 *
 * The satisfiability cases are the reason solve() exists: contradictory
 * constraints cannot be detected by any evaluation, because evaluation needs
 * values and the contradiction is structural.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { solve } from "../src/solve.ts";
import { toValueMap } from "../src/evaluate.ts";
import { toSmtLib } from "../src/smtlib.ts";
import type { Constraint, ConstraintExpr } from "../src/types.ts";

function comparison(
  path: string,
  op: "<" | "<=" | ">" | ">=" | "==" | "!=",
  value: number,
  unit?: string,
): ConstraintExpr {
  return {
    kind: "binary",
    op,
    left: { kind: "ref", featurePath: path.split(".") },
    right: { kind: "literal", value, unit },
  };
}

function constraint(id: string, expression: ConstraintExpr): Constraint {
  return { id, name: id, expression };
}

// ── Satisfiability ──────────────────────────────────────────────────────────

Deno.test("solve — contradictory constraints are unsat, and the conflict is named", async () => {
  const result = await solve([
    constraint("mass-budget", comparison("m", "<=", 2)),
    constraint("mass-floor", comparison("m", ">=", 5)),
  ]);

  // No evaluation can find this: it holds for NO values.
  assertEquals(result.status, "unsat");
  assertEquals(result.conflict?.toSorted(), ["mass-budget", "mass-floor"]);
});

Deno.test("solve — the conflict names only the contradicting subset", async () => {
  const result = await solve([
    constraint("unrelated", comparison("t", "<=", 100)),
    constraint("upper", comparison("m", "<=", 2)),
    constraint("lower", comparison("m", ">=", 5)),
  ]);

  assertEquals(result.status, "unsat");
  assertEquals(result.conflict?.includes("unrelated"), false);
});

Deno.test("solve — compatible constraints are sat with an admissible model", async () => {
  const result = await solve([
    constraint("floor", comparison("m", ">=", 1)),
    constraint("ceiling", comparison("m", "<=", 3)),
  ]);

  assertEquals(result.status, "sat");
  const m = result.model!["m"].value;
  assertEquals(m >= 1 && m <= 3, true);
});

// ── Units ───────────────────────────────────────────────────────────────────

Deno.test("solve — mixed kg and lb constraints are normalised to SI before z3", async () => {
  const result = await solve([
    constraint("floor", comparison("totalMass", ">=", 1, "kg")),
    constraint("budget", comparison("totalMass", "<=", 4, "lb")), // 1.8143 kg
  ]);

  assertEquals(result.status, "sat");
  const mass = result.model!["totalMass"];
  assertEquals(mass.unit, "kg");
  assertEquals(mass.value >= 1 && mass.value <= 1.8144, true);
});

Deno.test("solve — kg floor above the lb budget is unsat", async () => {
  const result = await solve([
    constraint("floor", comparison("totalMass", ">=", 2.5, "kg")), // 5.51 lb
    constraint("budget", comparison("totalMass", "<=", 4, "lb")),
  ]);

  // A dimension-blind solver would accept 2.5 ≤ m ≤ 4.
  assertEquals(result.status, "unsat");
});

// ── Optimisation ────────────────────────────────────────────────────────────

Deno.test("solve — minimize returns the optimum, not just any solution", async () => {
  const result = await solve(
    [
      constraint("floor", comparison("m", ">=", 1.2)),
      constraint("ceiling", comparison("m", "<=", 4)),
    ],
    { objective: { variable: "m", direction: "minimize" } },
  );

  assertEquals(result.status, "sat");
  assertAlmostEquals(result.objectiveValue!.value, 1.2, 1e-9);
  assertAlmostEquals(result.model!["m"].value, 1.2, 1e-9);
});

// ── Fixed values ────────────────────────────────────────────────────────────

Deno.test("solve — fixed values constrain the remaining variables", async () => {
  const sum: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: {
      kind: "binary",
      op: "+",
      left: { kind: "ref", featurePath: ["a"] },
      right: { kind: "ref", featurePath: ["b"] },
    },
    right: { kind: "literal", value: 10 },
  };
  const result = await solve(
    [constraint("sum", sum), constraint("b-floor", comparison("b", ">=", 7.5))],
    { fixed: toValueMap({ a: 2 }) },
  );

  assertEquals(result.status, "sat");
  const b = result.model!["b"].value;
  assertEquals(b >= 7.5 && b <= 8, true);
});

// ── Function support ────────────────────────────────────────────────────────

Deno.test("solve — abs is encoded, |x| <= 2 with x <= -1 gives x in [-2, -1]", async () => {
  const absCase: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: { kind: "call", name: "abs", args: [{ kind: "ref", featurePath: ["x"] }] },
    right: { kind: "literal", value: 2 },
  };
  const result = await solve([
    constraint("abs", absCase),
    constraint("negative", comparison("x", "<=", -1)),
  ]);

  assertEquals(result.status, "sat");
  const x = result.model!["x"].value;
  assertEquals(x >= -2 && x <= -1, true);
});

Deno.test("solve — a non-solvable function is rejected before z3 runs, naming the constraint", async () => {
  const sqrtCase: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: { kind: "call", name: "sqrt", args: [{ kind: "ref", featurePath: ["x"] }] },
    right: { kind: "literal", value: 2 },
  };

  await assertRejects(
    () => solve([constraint("sqrt-case", sqrtCase)]),
    Error,
    "sqrt-case",
  );
});

// ── SMT-LIB2 generation (no z3 needed) ─────────────────────────────────────

Deno.test("toSmtLib — script declares variables, names assertions, normalises units", () => {
  const { script, assertionIds, variableUnits } = toSmtLib([
    constraint("budget", comparison("totalMass", "<=", 4, "lb")),
  ]);

  assertEquals(script.includes("(declare-const |totalMass| Real)"), true);
  assertEquals(script.includes(":named c0"), true);
  assertEquals(assertionIds.get("c0"), "budget");
  assertEquals(variableUnits.get("totalMass"), "kg");
  // 4 lb → 1.814369… kg: the script carries SI values, never pounds.
  assertEquals(script.includes("1.814369"), true);
  assertEquals(script.includes("4.0"), false);
});

Deno.test("toSmtLib — negative literals use SMT-LIB2 unary minus", () => {
  const { script } = toSmtLib([
    constraint("floor", comparison("t", ">=", -10)),
  ]);

  assertEquals(script.includes("(- 10.0)"), true);
});

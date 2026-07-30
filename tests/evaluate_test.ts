/**
 * Evaluation tests
 *
 * The unit cases matter most: they pin the behaviour that a purely numeric
 * evaluator gets wrong, reporting a violated constraint as satisfied.
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  evaluateAll,
  evaluateConstraint,
  toValueMap,
} from "../src/evaluate.ts";
import type { Constraint, ConstraintExpr } from "../src/types.ts";

/** `ref op literal` — the shape of most engineering constraints. */
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

function constraint(expression: ConstraintExpr, name = "c"): Constraint {
  return { id: "c1", name, expression };
}

// ── Units: the reason this library exists ───────────────────────────────────

Deno.test("units — 2.5 kg fails a 4 lb limit (5.51 lb > 4 lb)", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 4, "lb"), "mass budget"),
    toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
  );

  // A numeric-only evaluator compares 2.5 <= 4 and wrongly reports "pass".
  assertEquals(result.status, "fail");
  assertEquals(result.threshold, 4);
  assertEquals(result.unit, "lb");
  assertAlmostEquals(result.computedValue!, 5.5116, 0.001);
  // Negative margin: over the limit by ~1.51 lb.
  assertAlmostEquals(result.margin!, -1.5116, 0.001);
});

Deno.test("units — 1.5 kg passes the same 4 lb limit", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 4, "lb")),
    toValueMap({ totalMass: { value: 1.5, unit: "kg" } }),
  );

  assertEquals(result.status, "pass");
  assertAlmostEquals(result.computedValue!, 3.3069, 0.001);
  assertAlmostEquals(result.margin!, 0.6931, 0.001);
});

Deno.test("units — margin is expressed in the threshold's unit", () => {
  const result = evaluateConstraint(
    constraint(comparison("stress", "<=", 250, "MPa")),
    toValueMap({ stress: { value: 180, unit: "MPa" } }),
  );

  assertEquals(result.status, "pass");
  assertEquals(result.unit, "MPa");
  assertEquals(result.margin, 70);
  assertEquals(result.marginPercent, 28);
});

Deno.test("units — quantity vs dimensionless number is an error, not a comparison", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 4)), // no unit on the limit
    toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
  );

  assertEquals(result.status, "error");
  assertEquals(result.error?.includes("dimensionless"), true);
});

Deno.test("units — incompatible dimensions are an error", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 100, "degC")),
    toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
  );

  assertEquals(result.status, "error");
});

Deno.test("units — an unknown unit symbol is an error naming the symbol", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 4, "flurbs")),
    toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
  );

  assertEquals(result.status, "error");
  assertEquals(result.error?.includes("flurbs"), true);
});

// ── Missing input never reads as satisfied ──────────────────────────────────

Deno.test("unresolved — a missing value is not zero", () => {
  const result = evaluateConstraint(
    constraint(comparison("totalMass", "<=", 5)),
    toValueMap({}), // nothing resolved
  );

  // Treating the absent value as 0 would report "pass" on data that does not exist.
  assertEquals(result.status, "unresolved");
  assertEquals(result.unresolvedRefs, ["totalMass"]);
});

Deno.test("unresolved — every missing reference is named", () => {
  const expr: ConstraintExpr = {
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
  const result = evaluateConstraint(constraint(expr), toValueMap({ a: 1 }));

  assertEquals(result.status, "unresolved");
  assertEquals(result.unresolvedRefs, ["b"]);
});

// ── Dimensionless arithmetic ────────────────────────────────────────────────

Deno.test("arithmetic — nested expression with a function call", () => {
  const expr: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: {
      kind: "call",
      name: "abs",
      args: [{
        kind: "binary",
        op: "-",
        left: { kind: "ref", featurePath: ["measured"] },
        right: { kind: "ref", featurePath: ["nominal"] },
      }],
    },
    right: { kind: "literal", value: 0.5 },
  };
  const result = evaluateConstraint(
    constraint(expr, "tolerance"),
    toValueMap({ measured: 10.3, nominal: 10.0 }),
  );

  assertEquals(result.status, "pass");
  assertAlmostEquals(result.computedValue!, 0.3, 1e-9);
});

Deno.test("arithmetic — conjunction has no single threshold but still decides", () => {
  const expr: ConstraintExpr = {
    kind: "binary",
    op: "and",
    left: comparison("temp", ">=", -10),
    right: comparison("temp", "<=", 80),
  };
  const inRange = evaluateConstraint(constraint(expr), toValueMap({ temp: 20 }));
  const outOfRange = evaluateConstraint(constraint(expr), toValueMap({ temp: 95 }));

  assertEquals(inRange.status, "pass");
  assertEquals(inRange.threshold, undefined);
  assertEquals(outOfRange.status, "fail");
});

Deno.test("arithmetic — division by zero is an error", () => {
  const expr: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: {
      kind: "binary",
      op: "/",
      left: { kind: "ref", featurePath: ["a"] },
      right: { kind: "literal", value: 0 },
    },
    right: { kind: "literal", value: 1 },
  };
  const result = evaluateConstraint(constraint(expr), toValueMap({ a: 5 }));

  assertEquals(result.status, "error");
  assertEquals(result.error?.includes("Division by zero"), true);
});

Deno.test("an expression that is not a condition is an error", () => {
  const expr: ConstraintExpr = {
    kind: "binary",
    op: "+",
    left: { kind: "ref", featurePath: ["a"] },
    right: { kind: "literal", value: 1 },
  };
  const result = evaluateConstraint(constraint(expr), toValueMap({ a: 1 }));

  assertEquals(result.status, "error");
  assertEquals(result.error?.includes("rather than a condition"), true);
});

Deno.test("an unknown function is an error listing what is available", () => {
  const expr: ConstraintExpr = {
    kind: "binary",
    op: "<=",
    left: { kind: "call", name: "tangent", args: [{ kind: "literal", value: 1 }] },
    right: { kind: "literal", value: 2 },
  };
  const result = evaluateConstraint(constraint(expr), toValueMap({}));

  assertEquals(result.status, "error");
  assertEquals(result.error?.includes("tangent"), true);
  assertEquals(result.error?.includes("abs"), true);
});

// ── Reporting ───────────────────────────────────────────────────────────────

Deno.test("evaluateAll — summary counts each status separately", () => {
  const report = evaluateAll(
    [
      { id: "p", name: "passes", expression: comparison("a", "<=", 10) },
      { id: "f", name: "fails", expression: comparison("a", ">=", 10) },
      { id: "u", name: "unresolved", expression: comparison("missing", "<=", 1) },
      { id: "e", name: "errors", expression: comparison("a", "<=", 1, "flurbs") },
    ],
    toValueMap({ a: 5 }),
  );

  assertEquals(report.summary, {
    total: 4,
    pass: 1,
    fail: 1,
    error: 1,
    unresolved: 1,
  });
  // fail and unresolved are never conflated.
  assertEquals(report.results.map((r) => r.status), [
    "pass",
    "fail",
    "unresolved",
    "error",
  ]);
});

/**
 * Static unit checking tests
 *
 * checkUnits() runs before any value is resolved, so it reports only what
 * literals make decidable. An unresolved reference has no known unit — that
 * is missing information, not an issue.
 */

import { assertEquals } from "@std/assert";
import { checkUnits } from "../src/units.ts";
import type { Constraint } from "../src/types.ts";

function constraint(
  id: string,
  left: { unit?: string },
  op: "<=" | ">=",
  right: { value: number; unit?: string },
): Constraint {
  return {
    id,
    name: id,
    expression: {
      kind: "binary",
      op,
      left: left.unit
        ? { kind: "literal", value: 1, unit: left.unit }
        : { kind: "ref", featurePath: ["something"] },
      right: { kind: "literal", value: right.value, unit: right.unit },
    },
  };
}

Deno.test("checkUnits — comparing mass to temperature is flagged", () => {
  const report = checkUnits([
    constraint("c1", { unit: "kg" }, "<=", { value: 100, unit: "degC" }),
  ]);

  assertEquals(report.checked, 1);
  assertEquals(report.issues.length, 1);
  assertEquals(report.issues[0].kind, "mixed-dimensions");
  assertEquals(report.issues[0].detail.includes("kg"), true);
  assertEquals(report.issues[0].detail.includes("degC"), true);
});

Deno.test("checkUnits — kg against lb is fine, same dimension", () => {
  const report = checkUnits([
    constraint("c1", { unit: "kg" }, "<=", { value: 4, unit: "lb" }),
  ]);

  assertEquals(report.issues, []);
});

Deno.test("checkUnits — an unrecognised symbol is flagged by name", () => {
  const report = checkUnits([
    constraint("c1", { unit: "kg" }, "<=", { value: 4, unit: "flurbs" }),
  ]);

  assertEquals(report.issues.length, 1);
  assertEquals(report.issues[0].kind, "unknown-unit");
  assertEquals(report.issues[0].detail.includes("flurbs"), true);
});

Deno.test("checkUnits — a unit only on one side is not a static issue", () => {
  // The other side is a reference whose unit is unknown until resolved;
  // evaluation catches a genuine mismatch, static checking must not guess.
  const report = checkUnits([
    constraint("c1", {}, "<=", { value: 4, unit: "kg" }),
  ]);

  assertEquals(report.issues, []);
});

Deno.test("checkUnits — dimensionless constraints raise nothing", () => {
  const report = checkUnits([
    constraint("c1", {}, "<=", { value: 4 }),
  ]);

  assertEquals(report.checked, 1);
  assertEquals(report.issues, []);
});

Deno.test("checkUnits — reports across several constraints", () => {
  const report = checkUnits([
    constraint("ok", { unit: "m" }, "<=", { value: 5, unit: "km" }),
    constraint("bad", { unit: "m" }, "<=", { value: 5, unit: "kg" }),
    constraint("unknown", { unit: "m" }, "<=", { value: 5, unit: "zorks" }),
  ]);

  assertEquals(report.checked, 3);
  assertEquals(report.issues.length, 2);
  assertEquals(report.issues.map((i) => i.constraintId), ["bad", "unknown"]);
});

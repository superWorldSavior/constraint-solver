/**
 * Formatting tests
 *
 * The rendered expression is what an engineer reads next to the computed
 * value: it must denote the same expression, with no parentheses dropped.
 */

import { assertEquals } from "@std/assert";
import { exprToString } from "../src/format.ts";
import type { BinaryOp, ConstraintExpr } from "../src/types.ts";

const ref = (name: string): ConstraintExpr => ({
  kind: "ref",
  featurePath: name.split("."),
});
const num = (value: number, unit?: string): ConstraintExpr => ({
  kind: "literal",
  value,
  unit,
});
const bin = (
  left: ConstraintExpr,
  op: BinaryOp,
  right: ConstraintExpr,
): ConstraintExpr => ({ kind: "binary", op, left, right });
const neg = (operand: ConstraintExpr): ConstraintExpr => ({
  kind: "unary",
  op: "-",
  operand,
});

Deno.test("format — a right operand under / or - keeps its parentheses", () => {
  // thrust / (totalMass * 9.81) >= 2 is not (thrust / totalMass) * 9.81 >= 2.
  assertEquals(
    exprToString(
      bin(
        bin(ref("thrust"), "/", bin(ref("totalMass"), "*", num(9.81))),
        ">=",
        num(2),
      ),
    ),
    "thrust / (totalMass * 9.81) ≥ 2",
  );
  assertEquals(
    exprToString(bin(ref("a"), "-", bin(ref("b"), "-", ref("c")))),
    "a - (b - c)",
  );
  assertEquals(
    exprToString(bin(ref("a"), "-", bin(ref("b"), "+", ref("c")))),
    "a - (b + c)",
  );
  assertEquals(
    exprToString(bin(ref("a"), "/", bin(ref("b"), "/", ref("c")))),
    "a / (b / c)",
  );
});

Deno.test("format — no parentheses where the reading is unchanged", () => {
  assertEquals(
    exprToString(bin(bin(ref("a"), "-", ref("b")), "-", ref("c"))),
    "a - b - c",
  );
  assertEquals(
    exprToString(bin(ref("a"), "*", bin(ref("b"), "*", ref("c")))),
    "a * b * c",
  );
  assertEquals(
    exprToString(bin(ref("a"), "+", bin(ref("b"), "-", ref("c")))),
    "a + b - c",
  );
  assertEquals(
    exprToString(bin(bin(ref("a"), "+", ref("b")), "*", num(2))),
    "(a + b) * 2",
  );
  assertEquals(
    exprToString(
      bin(bin(ref("t"), ">=", num(-10)), "and", bin(ref("t"), "<=", num(80))),
    ),
    "t ≥ -10 and t ≤ 80",
  );
  assertEquals(
    exprToString(bin(ref("totalMass"), "<=", num(5, "kg"))),
    "totalMass ≤ 5 kg",
  );
});

Deno.test("format — comparisons nested in comparisons are parenthesised", () => {
  assertEquals(
    exprToString(
      bin(bin(ref("a"), "<", ref("b")), "==", bin(ref("c"), "<", ref("d"))),
    ),
    "(a < b) == (c < d)",
  );
});

Deno.test("format — unary minus keeps the parentheses of a compound operand", () => {
  assertEquals(exprToString(neg(bin(ref("a"), "+", ref("b")))), "-(a + b)");
  assertEquals(exprToString(neg(ref("a"))), "-a");
  assertEquals(exprToString(neg(neg(ref("a")))), "-(-a)");
  assertEquals(
    exprToString(bin(ref("a"), "-", neg(ref("b")))),
    "a - (-b)",
  );
});

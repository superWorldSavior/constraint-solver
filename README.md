# @casys/constraint-solver

Evaluates parametric constraints, with **units treated as part of the value**.

```ts
import { evaluateAll, toValueMap } from "@casys/constraint-solver";

const report = evaluateAll(
  [{
    id: "c1",
    name: "mass budget",
    expression: {
      kind: "binary",
      op: "<=",
      left: { kind: "ref", featurePath: ["totalMass"] },
      right: { kind: "literal", value: 4, unit: "lb" },
    },
  }],
  toValueMap({ totalMass: { value: 2.5, unit: "kg" } }),
);

report.results[0];
// {
//   status: "fail",          ← 2.5 kg is 5.51 lb, over the 4 lb limit
//   expression: "totalMass ≤ 4 lb",
//   computedValue: 5.5116,
//   threshold: 4,
//   margin: -1.5116,
//   unit: "lb",
// }
```

A numeric-only evaluator compares `2.5 <= 4` and reports **pass** on a violated constraint. That is the failure this library exists to prevent.

## Why it is a separate package

Nothing here knows about SysML, CAD or FEA. Any producer able to emit the `Constraint` shape can be evaluated, which is what lets several sources share one solver:

| Producer | Constraints it emits |
|---|---|
| A SysML v2 model | `ConstraintUsage` expressions with their resolved values |
| An FEA run | `σ_max ≤ σ_allowable` |
| A cost model | `unitCost ≤ target` |
| An agent | anything it can formulate |

The contract is plain data, so a producer never imports the solver's internals and the solver never learns a producer's format.

## Design rules

**Units are values, not labels.** `4 lb` and `4 kg` are different quantities. Comparisons convert; incompatible dimensions are an error.

**"I cannot decide" is a first-class outcome.** `ConstraintStatus` has four values, not three:

```ts
type ConstraintStatus = "pass" | "fail" | "error" | "unresolved";
```

A feature path absent from the value map does **not** default to zero — it makes the constraint `unresolved` and names the missing path. A missing input can never be mistaken for a satisfied constraint.

**Errors state what to do.** An unknown unit names the symbol; an unknown function lists the available ones; a dimensionless comparison says to give both sides a unit or neither.

## API

### `evaluateAll(constraints, values): EvaluationReport`

Evaluates a set and summarises it. Never throws — every failure becomes a `status`.

```ts
report.summary; // { total, pass, fail, error, unresolved }
```

### `evaluateConstraint(constraint, values): ConstraintResult`

One constraint. For a top-level comparison the result also carries `computedValue`, `threshold`, `margin`, `marginPercent` and the `unit` they are expressed in — the margin is given in the **threshold's** unit, since that is the limit the author wrote.

### `checkUnits(constraints): UnitReport`

Static dimensional check, before any value exists. Flags unrecognised unit symbols and comparisons mixing incompatible dimensions. Reports only what literals make decidable — a unit carried by an unresolved reference is unknown, not wrong.

### `evaluate(expr, values): MathType | boolean`

The raw evaluator. Throws `EvalError` (carrying `unresolvedRefs` when relevant) instead of encoding failure in a status. Use `evaluateConstraint` unless you need the exception.

### `exprToString(expr): string`

Renders an expression for humans: `totalMass ≤ 5 kg`, `temp ≥ -10 and temp ≤ 80`.

### `toValueMap(record): ValueMap`

Builds a `ValueMap` from a plain object. A bare number is dimensionless; `{ value, unit }` carries a unit.

## Expression AST

```ts
type ConstraintExpr =
  | { kind: "literal"; value: number; unit?: string }
  | { kind: "ref"; featurePath: string[]; elementId?: string }
  | { kind: "binary"; op: BinaryOp; left: ConstraintExpr; right: ConstraintExpr }
  | { kind: "unary"; op: "not" | "-"; operand: ConstraintExpr }
  | { kind: "call"; name: string; args: ConstraintExpr[] };
```

Operators: `+ - * /`, `< <= > >= == !=`, `and or`, unary `not -`.
Functions: `abs`, `min`, `max`, `sqrt`, `round`, `floor`, `ceil`.

## Units

Unit handling comes from [mathjs](https://mathjs.org/docs/datatypes/units.html) — SI and imperial, prefixes, derived units. `kg`, `lb`, `MPa`, `degC`, `m/s^2` all work, and conversion between compatible units is automatic.

## Development

```bash
deno task check    # deno check mod.ts
deno task test     # 20 tests, no I/O
```

## License

MIT

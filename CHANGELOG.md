# Changelog

All notable changes to `@casys/constraint-solver` will be documented in this file.

## [Unreleased]

### Fixed

- **`exprToString` keeps the parentheses the reading depends on.** A right operand at the same level as `-` or `/` lost them, so `thrust / (totalMass * 9.81) ≥ 2` was shown as `thrust / totalMass * 9.81 ≥ 2`, another expression than the one evaluated. The same held for `a - (b - c)`, a comparison inside a comparison, and a unary minus over a compound or negated operand (`-(a + b)` was shown as `-a + b`). Parentheses that change nothing are still left out (`a - b - c`, `a * b * c`, `(a + b) * 2`).

## [0.1.0] - 2026-07-30

Initial release. Extracted from the constraint evaluator in `lib/sim`, with the evaluation core rewritten over [mathjs](https://mathjs.org) so that units participate in the comparison.

### Added

- **`solve`** — satisfiability, solving and optimisation via the `z3` executable (SMT-LIB2 over stdin). Contradictory constraints return `unsat` with a minimal conflicting subset named by constraint id — the question no evaluation can answer, since a structural contradiction holds for no values. An `objective` turns an arbitrary solution into the optimum; `fixed` pins known values. Units are normalised to SI base before z3 runs, so a kg floor above an lb ceiling is correctly unsat. The WASM `z3-solver` package was rejected after testing: its pthread build crashes Deno's workers (4.15 and 5.0 both), while a subprocess behaves identically under Deno and Node.
- **`toSmtLib`** — the SMT-LIB2 generator behind `solve`, exposed for inspection: script text, assertion-name → constraint-id map, inferred per-variable SI units.
- **`evaluateAll` / `evaluateConstraint`** — evaluate parametric constraints against resolved values. Never throw; every failure becomes a `status`.
- **Unit-aware comparison.** `2.5 kg ≤ 4 lb` is `fail`, because 2.5 kg is 5.51 lb. Compatible units convert automatically; incompatible dimensions and quantity-versus-dimensionless comparisons are errors, never silent numeric comparisons.
- **Four-valued outcome** — `pass | fail | error | unresolved`. A feature path absent from the value map makes the constraint `unresolved` and names the missing path; it never defaults to zero.
- **Margins in the threshold's unit** — `computedValue`, `threshold`, `margin`, `marginPercent` and the `unit` they are expressed in, for top-level comparisons. The margin is given against the limit the author wrote.
- **`checkUnits`** — static dimensional check before any value exists: unrecognised unit symbols and comparisons mixing incompatible dimensions.
- **`exprToString`** — renders an expression for humans (`totalMass ≤ 5 kg`).
- **Source-agnostic contract** — the `Constraint` shape carries no SysML, CAD or FEA specifics, so a model, an FEA result and a hand-written problem can share one solver.

### Fixed relative to the `lib/sim` evaluator it replaces

- **Units were captured but never used in the comparison.** The old evaluator stored a literal's unit for display only, then compared bare numbers. `totalMass ≤ 4 lb` with `totalMass = 2.5` (kg) rendered as `totalMass ≤ 4 lb` and returned **pass** — a violated constraint reported as satisfied, made more misleading by an output that showed the unit it had ignored.
- **Values carry their unit.** `ValueMap` maps a feature path to `{ value, unit? }` rather than to a bare number, so a producer can state that a resolved value is in kilograms and have the comparison honour it.

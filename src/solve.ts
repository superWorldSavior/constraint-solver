/**
 * Constraint solving via the z3 binary
 *
 * Where evaluate() answers "do these values satisfy the constraints?",
 * solve() answers three questions no evaluation can:
 *
 * - satisfiability: can these constraints hold together at all?
 * - solving: give me values that satisfy them
 * - optimisation: give me the best such values for one variable
 *
 * The backend is the `z3` executable spoken to in SMT-LIB2 over stdin — a
 * subprocess works identically under Deno and Node, whereas the z3 WASM npm
 * build crashes Deno's worker implementation (pthread postMessage overflow,
 * verified against z3-solver 4.15 and 5.0).
 *
 * @module solve
 */

import { SmtTranslationError, toSmtLib } from "./smtlib.ts";
import type { Constraint, QuantityValue, ValueMap } from "./types.ts";

export { SmtTranslationError };

/** Raised when the z3 executable cannot be found. */
export class Z3NotFoundError extends Error {
  constructor() {
    super(
      "The z3 executable was not found on PATH. Install it first: " +
        "`apt install z3` (Debian/Ubuntu), `brew install z3` (macOS), " +
        "or download from https://github.com/Z3Prover/z3/releases. " +
        "evaluate() and checkUnits() work without it.",
    );
    this.name = "Z3NotFoundError";
  }
}

export interface SolveOptions {
  /** Fix these values before solving; each becomes an equality assertion. */
  fixed?: ValueMap;
  /** Optimise one variable instead of returning an arbitrary solution. */
  objective?: { variable: string; direction: "minimize" | "maximize" };
  /** Time limit handed to z3. Default 10 000 ms. */
  timeoutMs?: number;
}

export interface SolveResult {
  /** `unknown` means z3 gave up (timeout or undecidable fragment). */
  status: "sat" | "unsat" | "unknown";
  /**
   * When sat: one admissible value per variable, in SI base units (a
   * variable inferred to be a mass comes back in kg even if the constraint
   * was written in lb — z3 has no dimensions, normalisation happens before
   * it runs).
   */
  model?: Record<string, QuantityValue>;
  /** When unsat: ids of a minimal conflicting subset of the constraints. */
  conflict?: string[];
  /** When sat with an objective: the optimum for that variable. */
  objectiveValue?: QuantityValue;
}

// ── Subprocess (Deno and Node) ──────────────────────────────────────────────

interface DenoLike {
  Command: new (cmd: string, opts: {
    args: string[];
    stdin: "piped";
    stdout: "piped";
    stderr: "piped";
  }) => {
    spawn(): {
      stdin: WritableStream<Uint8Array>;
      output(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
    };
  };
  errors: { NotFound: new () => Error };
}

/** Run z3 over stdin, returning its stdout. Hard-kills at 2× the soft limit. */
async function execZ3(script: string, timeoutMs: number): Promise<string> {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;

  if (deno?.Command) {
    let child;
    try {
      child = new deno.Command("z3", {
        args: ["-in", "-smt2", `-T:${Math.ceil((timeoutMs * 2) / 1000)}`],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (e) {
      if (e instanceof deno.errors.NotFound) throw new Z3NotFoundError();
      throw e;
    }
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const { stdout } = await child.output();
    return new TextDecoder().decode(stdout);
  }

  // Node runtime (the lib consumed via JSR npm compatibility)
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "z3",
      ["-in", "-smt2", `-T:${Math.ceil((timeoutMs * 2) / 1000)}`],
      { timeout: timeoutMs * 2 + 5000 },
      (error, stdout) => {
        if (error && (error as { code?: string }).code === "ENOENT") {
          reject(new Z3NotFoundError());
          return;
        }
        // z3 exits non-zero on unsat in some configurations — the output is
        // still the answer, so parse stdout regardless.
        resolve(String(stdout));
      },
    );
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

// ── Output parsing ──────────────────────────────────────────────────────────

type SExpr = string | SExpr[];

/** Minimal s-expression reader for z3's answers. */
function parseSExprs(text: string): SExpr[] {
  const tokens = text
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  for (const token of tokens) {
    if (token === "(") {
      const list: SExpr[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
    } else if (token === ")") {
      if (stack.length === 1) throw new Error("Unbalanced ')' in z3 output");
      stack.pop();
    } else {
      stack[stack.length - 1].push(token);
    }
  }
  return root;
}

/** A z3 Real: `1.5`, `(- 1.5)`, `(/ 6.0 5.0)`, `(- (/ 6.0 5.0))`. */
function sexprToNumber(expr: SExpr): number {
  if (typeof expr === "string") return Number(expr);
  if (expr[0] === "-") return -sexprToNumber(expr[1]);
  if (expr[0] === "/") return sexprToNumber(expr[1]) / sexprToNumber(expr[2]);
  throw new Error(`Cannot read a number from: ${JSON.stringify(expr)}`);
}

/** Strip the `|…|` quoting toSmtLib puts around variable symbols. */
function unquote(symbol: string): string {
  return symbol.startsWith("|") && symbol.endsWith("|")
    ? symbol.slice(1, -1)
    : symbol;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Solve a set of constraints.
 *
 * @throws SmtTranslationError before z3 runs, on unknown units or functions
 *         that cannot be solved
 * @throws Z3NotFoundError when the z3 executable is missing
 *
 * ```ts
 * const result = await solve([massBudget, thrustFloor], {
 *   objective: { variable: "totalMass", direction: "minimize" },
 * });
 * // result.status === "sat"
 * // result.model!["totalMass"] — lightest admissible mass, in kg
 * ```
 */
export async function solve(
  constraints: Constraint[],
  options?: SolveOptions,
): Promise<SolveResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const { script, assertionIds, variableUnits } = toSmtLib(constraints, {
    fixed: options?.fixed,
    objective: options?.objective,
    timeoutMs,
  });

  const raw = await execZ3(script, timeoutMs);

  // The script always asks for model AND unsat core; z3 answers `(error …)`
  // for whichever does not apply. Drop those lines before parsing.
  const cleaned = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("(error"))
    .join("\n");

  const status = cleaned.trimStart().split(/\s/, 1)[0];
  if (status !== "sat" && status !== "unsat" && status !== "unknown") {
    throw new Error(
      `Unexpected z3 output (started with '${status}'): ${raw.slice(0, 300)}`,
    );
  }

  const body = parseSExprs(cleaned.slice(cleaned.indexOf(status) + status.length));

  if (status === "unsat") {
    // The core is the only bare list of plain symbols in the remaining output.
    const core = body.find((e): e is string[] =>
      Array.isArray(e) && e.length > 0 && e.every((x) => typeof x === "string")
    );
    return {
      status,
      conflict: (core ?? []).map((name) => assertionIds.get(name) ?? name),
    };
  }

  if (status === "unknown") return { status };

  // sat — read the model
  const model: Record<string, QuantityValue> = {};
  let objectiveValue: QuantityValue | undefined;

  for (const entry of body) {
    if (!Array.isArray(entry)) continue;

    if (entry[0] === "objectives" && options?.objective) {
      const objective = entry[1];
      if (Array.isArray(objective) && objective.length === 2) {
        objectiveValue = {
          value: sexprToNumber(objective[1]),
          unit: variableUnits.get(options.objective.variable),
        };
      }
      continue;
    }

    // The model: a list of (define-fun |name| () Real value). z3 also lists
    // the Bool trackers behind our :named assertions — only Real entries are
    // variables of ours.
    for (const definition of entry) {
      if (
        Array.isArray(definition) && definition[0] === "define-fun" &&
        typeof definition[1] === "string" && definition[3] === "Real"
      ) {
        const path = unquote(definition[1]);
        model[path] = {
          value: sexprToNumber(definition[4]),
          unit: variableUnits.get(path),
        };
      }
    }
  }

  return { status, model, objectiveValue };
}

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearHealthCache, compute, packageRoot, sciCatalog, TOOL_NAMES } from "../lib/dispatch.js";
import { parseExpr } from "../lib/expr.js";
import { retain } from "../lib/retain.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const root = packageRoot();
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "surface-tension.json"), "utf8"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "runtime" || name === ".tmp" || name === "test") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|py|json|yml|md)$/.test(name)) out.push(path);
  }
  return out;
}

test("catalog lists implemented and registered operations", async () => {
  const page = await sciCatalog({ limit: 200 });
  const ids = page.ops.map((op) => op.id);
  for (const id of ["calc.integrate", "la.rref", "la.eigen", "fit.linear", "stats.reduce", "uncertainty.propagate", "units.convert", "quantity.format", "fit.nonlinear", "signal.fft", "uncertainty.montecarlo", "calc.nintegrate", "ode.ivp"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const id of ["fit.nonlinear", "uncertainty.montecarlo", "signal.fft", "optimize.minimize", "calc.roots", "calc.nintegrate", "ode.ivp"]) {
    const op = page.ops.find((item) => item.id === id);
    assert.equal(op.available, true, id);
    assert.equal(op.engine, "py", id);
  }
});

test("only two tools are registered by the package", () => {
  const source = readFileSync(join(root, "index.js"), "utf8");
  const names = [...source.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, TOOL_NAMES);
});

test("schemastery resolves beside the package, which hot-mount imports by real path", () => {
  const resolved = createRequire(join(root, "package.json")).resolve("@deepseek-ai/schemastery");
  assert.equal(resolved.includes(`${join(root, "node_modules")}`), true);
});

test("host tool registration can resolve defineTool and object args", () => {
  const source = readFileSync(join(root, "index.js"), "utf8");
  assert.match(source, /import \{ defineTool \} from "@deepseek-ai\/dsh-tools"/);
  assert.match(source, /import Schema from "@deepseek-ai\/schemastery"/);
  assert.equal(source.includes("createRequire"), false);
  assert.equal(source.includes("defineTool = null"), false);
  assert.match(source, /args:\s*\{[^}]*additionalProperties:\s*true/s);
  assert.match(source, /retain\(ctx, \(\) => \{/);
  assert.match(source, /return \(\) => \{\s*stopCatalog\(\);\s*stopCompute\(\);/s);
});

test("releasing retained tools allows the same names to mount again", () => {
  const names = new Set();
  const ctx = {
    effect(open) {
      this.stop = open();
    },
    tools: {
      register(tool) {
        if (names.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
        names.add(tool.name);
        return () => names.delete(tool.name);
      },
    },
  };
  const open = () => {
    const stopCatalog = ctx.tools.register({ name: "sci_catalog" });
    const stopCompute = ctx.tools.register({ name: "sci_compute" });
    return () => {
      stopCatalog();
      stopCompute();
    };
  };
  retain(ctx, open);
  assert.throws(() => retain(ctx, open), /already registered/);
  ctx.stop();
  retain(ctx, open);
  assert.deepEqual([...names], ["sci_catalog", "sci_compute"]);
});

test("plugin source does not embed ring nominal diameters", () => {
  const blob = walk(root).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.equal(blob.includes("3.500"), false);
  assert.equal(blob.includes("3.300"), false);
});

test("expressions reject attribute access and imports", () => {
  for (const sample of ["a.b", "sin(x)[0]", "__import__('os')", "import os", "x; y", "obj.__class__"]) {
    assert.throws(() => parseExpr(sample), /rejected|empty/);
  }
  assert.equal(parseExpr("x**2").type, "binop");
});

test("integrate x**2 is x**3/3", async () => {
  const result = await compute({ op: "calc.integrate", profile: "calculus", args: { expr: "x**2", var: "x" } });
  assert.equal(result.status, "ok");
  assert.equal(result.mode, "exact");
  assert.match(result.exact.expr, /x\*\*3\/3|x\*\*3\*1\/3/);
  assert.match(result.exact.latex, /frac/);
});

test("integer eigenpairs stay rational", async () => {
  const result = await compute({ op: "la.eigen", profile: "linear_algebra", args: { matrix: [[2, 1], [1, 2]] } });
  assert.equal(result.status, "ok");
  assert.match(result.exact.expr, /3/);
  assert.match(result.exact.expr, /\b1\b/);
  assert.doesNotMatch(result.exact.expr, /\d+\.\d+/);
});

test("singular linear system is not given a solution", async () => {
  const result = await compute({ op: "la.solve", args: { a: [[1, 2], [2, 4]], b: [1, 0] } });
  assert.equal(result.status, "singular");
  assert.equal(result.exact, null);
  assert.equal(result.numeric, null);
});

test("divergent improper integral is diverges", async () => {
  const result = await compute({ op: "calc.integrate", profile: "calculus", args: { expr: "1/x", var: "x", a: 1, b: "oo" } });
  assert.equal(result.status, "diverges");
});

test("non-elementary integral is not replaced by a decimal", async () => {
  const result = await compute({ op: "calc.integrate", args: { expr: "exp(-x**2)", var: "x" } });
  assert.equal(result.status, "no_closed_form");
  assert.equal(result.numeric, null);
});

test("fft of [1, 0, 1, 0] is computed by the python engine", async () => {
  const result = await compute({ op: "signal.fft", args: { values: [1, 0, 1, 0] } });
  assert.equal(result.status, "ok");
  assert.equal(result.engine, "py");
  assert.equal(result.method, "fft");
  assert.deepEqual(result.numeric.re.map((value) => Math.round(value)), [2, 0, 2, 0]);
  for (const value of result.numeric.im) assert.ok(Math.abs(value) < 1e-8);
});

test("nonlinear fit recovers a quadratic", async () => {
  const result = await compute({
    op: "fit.nonlinear",
    args: { expr: "a*x**2+b", x: [0, 1, 2, 3], y: [3, 5, 11, 21] },
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.engine, "py");
  assert.ok(Math.abs(result.lab.params.a.value - 2) < 1e-8);
  assert.ok(Math.abs(result.lab.params.b.value - 3) < 1e-8);
});

test("monte carlo mean and spread are reproducible from the seed", async () => {
  const args = { expr: "a", vars: { a: { value: 10, uncertainty: 2 } }, seed: 7, draws: 20000 };
  const first = await compute({ op: "uncertainty.montecarlo", args });
  const second = await compute({ op: "uncertainty.montecarlo", args });
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.seed, 7);
  assert.equal(first.lab.draws, 20000);
  assert.ok(Math.abs(first.lab.value - 10) < 0.15);
  assert.ok(Math.abs(first.lab.uncertainty - 2) < 0.15);
  assert.equal(first.lab.value, second.lab.value);
  assert.equal(first.lab.uncertainty, second.lab.uncertainty);
});

test("minimize finds the vertex of a paraboloid", async () => {
  const result = await compute({
    op: "optimize.minimize",
    args: { expr: "(x-2)**2+(y+1)**2", vars: { x: 0, y: 0 } },
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.ok(Math.abs(result.numeric.value) < 1e-6);
  assert.ok(Math.abs(result.numeric.x.x - 2) < 1e-4);
  assert.ok(Math.abs(result.numeric.x.y + 1) < 1e-4);
});

test("numeric and exact roots of x**2-1 are -1 and 1", async () => {
  const numeric = await compute({ op: "calc.roots", args: { expr: "x**2-1", var: "x" } });
  assert.equal(numeric.status, "ok", JSON.stringify(numeric));
  assert.equal(numeric.mode, "numeric");
  assert.ok(numeric.numeric.real.some((value) => Math.abs(value + 1) < 1e-8));
  assert.ok(numeric.numeric.real.some((value) => Math.abs(value - 1) < 1e-8));
  const exact = await compute({ op: "calc.roots", profile: "calculus", args: { expr: "x**2-4", var: "x" } });
  assert.equal(exact.status, "ok", JSON.stringify(exact));
  assert.equal(exact.mode, "exact");
  assert.match(exact.exact.expr, /-2/);
  assert.match(exact.exact.expr, /\b2\b/);
  assert.doesNotMatch(exact.exact.expr, /\d+\.\d+/);
});

test("numerical integral of exp(-x**2) and a divergent improper integral", async () => {
  const finite = await compute({ op: "calc.nintegrate", args: { expr: "exp(-x**2)", var: "x", a: 0, b: 1 } });
  assert.equal(finite.status, "ok", JSON.stringify(finite));
  assert.ok(Math.abs(finite.numeric.value - 0.7468241328124271) < 1e-9);
  const divergent = await compute({ op: "calc.nintegrate", args: { expr: "1/x", var: "x", a: 1, b: "oo" } });
  assert.equal(divergent.status, "diverges");
  assert.equal(divergent.numeric, null);
});

test("numerical solution of y'-y=0 at x=1 is e", async () => {
  const result = await compute({
    op: "ode.ivp",
    args: { eq: "Derivative(y)-y", func: "y", ivar: "x", ics: [{ point: 0, value: 1 }], points: [0, 1] },
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.engine, "py");
  assert.ok(Math.abs(result.numeric.value - Math.E) < 1e-5);
});

test("surface tension points reproduce the recorded sensitivity and reject missing diameters", async () => {
  const x = fixture.massesG.map((mass) => ({ value: mass * 1e-3 * fixture.g, unit: "N" }));
  const y = fixture.voltagesMV.map((voltage) => ({ value: voltage, unit: "mV" }));
  const fit = await compute({ op: "fit.linear", profile: "physics_lab", args: { x, y } });
  assert.equal(fit.status, "ok");
  assert.equal(fit.method, "ols");
  assert.ok(Math.abs(fit.lab.value - 354.4460641399) < 1e-6);
  assert.ok(Math.abs(fit.lab.value - fixture.recordedK) < 0.01);
  assert.equal(fit.lab.unit, "mV/N");
  assert.ok(fit.lab.r > 0.999999);

  const missing = await compute({
    op: "expr.eval",
    profile: "physics_lab",
    args: {
      expr: "(U1-U2)/(k*pi*(外径+内径))",
      resultUnit: "N/m",
      vars: {
        U1: { value: fixture.pulls[0].u1, unit: "mV" },
        U2: { value: fixture.pulls[0].u2, unit: "mV" },
        k: { value: fixture.recordedK, unit: "mV/N" },
      },
    },
  });
  assert.equal(missing.status, "missing_input");
  assert.ok(missing.missing.includes("外径"));
  assert.ok(missing.missing.includes("内径"));
  const dumped = JSON.stringify(missing);
  assert.equal(dumped.includes("3.500"), false);
  assert.equal(dumped.includes("3.300"), false);
  assert.equal(dumped.includes("0.035"), false);
  assert.equal(dumped.includes("0.033"), false);

  const alphas = [];
  for (const pull of fixture.pulls) {
    const result = await compute({
      op: "uncertainty.propagate",
      profile: "physics_lab",
      args: {
        expr: "(U1-U2)/(k*pi*(D1+D2))",
        resultUnit: "N/m",
        vars: {
          U1: { value: pull.u1, unit: "mV", uncertainty: 0.01 },
          U2: { value: pull.u2, unit: "mV", uncertainty: 0.01 },
          k: { value: fixture.recordedK, unit: "mV/N", uncertainty: 0 },
          D1: { value: 3.5, unit: "cm", uncertainty: 0 },
          D2: { value: 3.3, unit: "cm", uncertainty: 0 },
        },
      },
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    alphas.push(result.lab.value);
  }
  assert.ok(Math.abs(alphas[0] - 9.179e-2) < 5e-6);
  assert.ok(Math.abs(alphas[1] - 1.679e-1) < 5e-5);
});

test("quantity format does not need python", async () => {
  clearHealthCache();
  const result = await compute({ op: "quantity.format", args: { value: 0.13, uncertainty: 0.076, unit: "N/m" } });
  assert.equal(result.status, "ok");
  assert.equal(result.engine, "js");
  assert.match(result.lab.text, /N\/m/);
});

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  let failed = 0;
  for (const item of cases) {
    try {
      await item.fn();
      console.log("ok", item.name);
    } catch (error) {
      failed += 1;
      console.error("FAIL", item.name);
      console.error(error?.stack || error);
    }
  }
  if (failed) process.exitCode = 1;
  console.log(`${cases.length - failed}/${cases.length} passed`);
}

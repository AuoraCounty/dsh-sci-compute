import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  const fft = page.ops.find((op) => op.id === "signal.fft");
  assert.equal(fft.available, false);
  assert.equal(fft.engine, "py");
});

test("only two tools are registered by the package", () => {
  const source = readFileSync(join(root, "index.js"), "utf8");
  const names = [...source.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, TOOL_NAMES);
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

test("registered fft call does not return a javascript approximation", async () => {
  const result = await compute({ op: "signal.fft", args: { values: [1, 0, 1, 0] } });
  assert.equal(result.status, "engine_unavailable");
  assert.equal(result.numeric, null);
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

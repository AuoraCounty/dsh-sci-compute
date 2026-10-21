import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expressionNames, parseExpr } from "./expr.js";
import { envelope } from "./envelope.js";
import { resolvePython, runRuntime } from "./engine.js";
import { formatQuantity } from "./format.js";
import { validate } from "./schema.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(root, "engines", "py", "runtime.py");
const OPS = JSON.parse(readFileSync(join(root, "catalog", "ops.json"), "utf8"));
const BY_ID = new Map(OPS.map((op) => [op.id, op]));

const PROFILE_MODE = {
  calculus: "exact",
  linear_algebra: "exact",
  physics_lab: "lab",
  physics: "numeric",
};
const MODES = new Set(["exact", "numeric", "lab"]);
const PROFILES = new Set(Object.keys(PROFILE_MODE));
const CONSTANTS = new Set(["pi", "E", "oo", "I"]);
const EXPR_FIELD = {
  "expr.eval": "expr",
  "calc.limit": "expr",
  "calc.diff": "expr",
  "calc.integrate": "expr",
  "calc.series": "expr",
  "calc.ode": "eq",
  "uncertainty.propagate": "expr",
  "units.check": "expr",
};
const FILE_FIELDS = ["x", "y", "values", "matrix", "a", "b", "vectors", "weights"];

export const DEFAULT_CONFIG = {
  coverageFactor: 1,
  maxInlineNumbers: 4096,
  maxOutputBytes: 262144,
  timeoutMs: 30000,
  monteCarloMaxDraws: 100000,
  pythonPath: "",
};

export const TOOL_NAMES = ["sci_catalog", "sci_compute"];

let healthCache = null;

export function clearHealthCache() {
  healthCache = null;
}

export function packageRoot() {
  return root;
}

export async function sciCatalog(query = {}, config = {}) {
  const cfg = normalizeConfig(config);
  const health = await ensureHealth(cfg);
  const domain = query.domain ?? null;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("schema: offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("schema: limit must be an integer from 1 to 200");
  const matched = OPS.filter((op) => !domain || op.domain === domain);
  const ops = matched.slice(offset, offset + limit).map((op) => ({
    id: op.id,
    domain: op.domain,
    summary: op.summary,
    engine: op.engine,
    available: op.implemented && (op.engine === "js" || health.ok),
    defaultMode: op.defaultMode,
    argsSchema: op.argsSchema,
  }));
  return { ops, total: matched.length, offset, limit };
}

export async function compute(request, config = {}) {
  const cfg = normalizeConfig(config);
  const opId = request?.op;
  const spec = BY_ID.get(opId);
  if (!spec) {
    return envelope({
      status: "unknown_op",
      op: opId ?? null,
      profile: request?.profile ?? null,
      mode: request?.mode ?? null,
      inputsEcho: request?.args ?? null,
    });
  }
  const profile = request.profile ?? null;
  if (profile != null && !PROFILES.has(profile)) throw new Error("schema: unknown profile");
  if (request.mode != null && !MODES.has(request.mode)) throw new Error("schema: unknown mode");
  const mode = request.mode || (profile && PROFILE_MODE[profile]) || spec.defaultMode;
  const inputsEcho = request.args ?? null;
  const base = {
    op: spec.id,
    profile,
    mode,
    inputsEcho,
    engine: spec.engine,
    seed: inputsEcho && Object.prototype.hasOwnProperty.call(inputsEcho, "seed") ? inputsEcho.seed : null,
  };
  if (!spec.implemented) {
    return envelope({ ...base, status: "engine_unavailable", method: "not_implemented" });
  }
  if (request.args === undefined || request.args === null || typeof request.args !== "object" || Array.isArray(request.args)) {
    throw new Error("schema: args must be an object");
  }
  const schemaErrors = validate(spec.argsSchema, request.args);
  if (schemaErrors.length) throw new Error(`schema: ${schemaErrors.join("; ")}`);
  const args = materialize(request.args);
  const count = countNumbers(args);
  if (count > cfg.maxInlineNumbers) throw new Error("maxInlineNumbers");
  if (spec.engine === "js") return runJs(spec, args, base, cfg);
  const health = await ensureHealth(cfg);
  if (!health.ok) {
    return envelope({ ...base, status: "engine_unavailable", engineVersion: null, method: "import" });
  }
  const payloadArgs = { ...args };
  const field = EXPR_FIELD[spec.id];
  if (field) {
    let ast;
    try {
      ast = parseExpr(args[field]);
    } catch (error) {
      throw new Error(`schema: ${error.message}`);
    }
    const missing = missingNames(spec.id, ast, args);
    if (missing.length) {
      return envelope({ ...base, status: "missing_input", engine: "py", engineVersion: engineVersion(health), missing, method: "whitelist" });
    }
    payloadArgs[field] = ast;
  }
  const result = await runRuntime(resolvePython(root, cfg.pythonPath), scriptPath, {
    op: spec.id,
    args: payloadArgs,
    mode,
    profile,
    inputsEcho,
    coverageFactor: cfg.coverageFactor,
    limits: { monteCarloMaxDraws: cfg.monteCarloMaxDraws },
  }, cfg);
  if (result?.lab && result.lab.text == null && typeof result.lab.value === "number") {
    const formatted = formatQuantity({
      value: result.lab.value,
      uncertainty: result.lab.uncertainty,
      unit: result.lab.unit,
    });
    result.lab.text = formatted.text;
    result.lab.uncertainty = formatted.uncertainty;
  }
  return result;
}

function runJs(spec, args, base) {
  if (spec.id !== "quantity.format") {
    return envelope({ ...base, status: "engine_unavailable", method: "not_implemented" });
  }
  const formatted = formatQuantity(args);
  return envelope({
    ...base,
    status: "ok",
    engine: "js",
    engineVersion: "format",
    method: "format",
    lab: formatted,
  });
}

function missingNames(op, ast, args) {
  const names = [...expressionNames(ast)].filter((name) => !CONSTANTS.has(name));
  if (op === "units.check") {
    const units = args.units ?? {};
    return names.filter((name) => units[name] === undefined);
  }
  if (op === "expr.eval" || op === "uncertainty.propagate") {
    const vars = args.vars ?? {};
    return names.filter((name) => measurementMissing(vars[name]));
  }
  return [];
}

function measurementMissing(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return false;
  if (typeof value === "object") {
    if (value.missing === true) return true;
    return value.value === undefined || value.value === null;
  }
  return false;
}

function materialize(args) {
  const copy = { ...args };
  for (const key of FILE_FIELDS) {
    const value = copy[key];
    if (typeof value === "string" && existsSync(value)) {
      copy[key] = JSON.parse(readFileSync(value, "utf8"));
    }
  }
  return copy;
}

function countNumbers(value) {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNumbers(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countNumbers(item), 0);
  return 0;
}

function normalizeConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

async function ensureHealth(config) {
  if (healthCache) return healthCache;
  try {
    const info = await runRuntime(resolvePython(root, config.pythonPath), scriptPath, { op: "__health__" }, config);
    healthCache = info?.ok ? info : { ok: false };
  } catch {
    healthCache = { ok: false };
  }
  return healthCache;
}

function engineVersion(health) {
  return health?.sympy ? `sympy ${health.sympy}` : null;
}

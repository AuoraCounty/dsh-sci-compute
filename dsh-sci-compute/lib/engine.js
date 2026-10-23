import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function bundledPython(root) {
  const embed = resolve(root, "runtime", "python.exe");
  if (existsSync(embed)) return embed;
  return process.platform === "win32"
    ? resolve(root, "runtime", "Scripts", "python.exe")
    : resolve(root, "runtime", "bin", "python");
}

export function resolvePython(root, pythonPath) {
  const bundled = bundledPython(root);
  if (!pythonPath) return bundled;
  const requested = resolve(pythonPath);
  const rel = relative(resolve(root), requested);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("pythonPath must point at the plugin runtime");
  }
  return requested;
}

export function runRuntime(pythonPath, scriptPath, payload, limits) {
  if (!existsSync(pythonPath)) {
    return Promise.reject(new Error("plugin python is not installed"));
  }
  return runPiped(pythonPath, scriptPath, payload, limits).catch((error) => {
    if (error?.code !== "EPERM") throw error;
    return runViaFiles(pythonPath, scriptPath, payload, limits);
  });
}

function runViaFiles(pythonPath, scriptPath, payload, limits) {
  const dir = mkdtempSync(join(scratchDir(), "call-"));
  const inputPath = join(dir, "in.json");
  const outputPath = join(dir, "out.json");
  writeFileSync(inputPath, JSON.stringify(payload));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [scriptPath, inputPath, outputPath], {
      stdio: "ignore",
      windowsHide: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("timeout"));
    }, limits.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errorPath = `${outputPath}.err`;
      if (code !== 0) {
        const stderr = existsSync(errorPath) ? readFileSync(errorPath, "utf8") : "";
        rmSync(dir, { recursive: true, force: true });
        reject(new Error(stderr || `python exit ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(readFileSync(outputPath, "utf8"));
        rmSync(dir, { recursive: true, force: true });
        resolvePromise(parsed);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        reject(new Error(`runtime output was not JSON: ${error.message}`));
      }
    });
  });
}

function scratchDir() {
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp");
  try {
    mkdirSync(local, { recursive: true });
    return local;
  } catch {
    const fallback = join(tmpdir(), "dsh-sci-compute");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function runPiped(pythonPath, scriptPath, payload, limits) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const out = [];
    const err = [];
    let outLen = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("timeout")), limits.timeoutMs);
    child.stdout.on("data", (buf) => {
      outLen += buf.length;
      if (outLen > limits.maxOutputBytes) {
        fail(new Error("maxOutputBytes"));
        return;
      }
      out.push(buf);
    });
    child.stderr.on("data", (buf) => {
      if (Buffer.concat(err).length < 8192) err.push(buf);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(stderr || `python exit ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (error) {
        reject(new Error(`runtime output was not JSON: ${error.message}${stderr ? `; ${stderr}` : ""}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

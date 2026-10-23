import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, ".tmp");
const site = join(root, "runtime", "Lib", "site-packages");
mkdirSync(tmp, { recursive: true });
mkdirSync(site, { recursive: true });

const pins = [
  ["numpy", "2.2.6", "cp312"],
  ["scipy", "1.15.2", "cp312"],
  ["sympy", "1.13.3", "py3"],
  ["mpmath", "1.3.0", "py3"],
];

for (const [name, version, tag] of pins) {
  const meta = await fetch(`https://pypi.org/pypi/${name}/${version}/json`).then((res) => {
    if (!res.ok) throw new Error(`${name} ${version} metadata ${res.status}`);
    return res.json();
  });
  const wheel = meta.urls.find((item) => item.packagetype === "bdist_wheel" && item.filename.includes("win_amd64") && item.filename.includes(tag))
    ?? meta.urls.find((item) => item.packagetype === "bdist_wheel" && item.filename.includes("py3-none-any"));
  if (!wheel) throw new Error(`no wheel for ${name} ${version}`);
  const dest = join(tmp, wheel.filename);
  if (!existsSync(dest) || statSync(dest).size < 1000) {
    console.log("download", wheel.filename);
    const response = await fetch(wheel.url);
    if (!response.ok) throw new Error(`download ${wheel.filename} ${response.status}`);
    await pipeline(response.body, createWriteStream(dest));
  } else {
    console.log("reuse", wheel.filename);
  }
  const marker = join(site, name);
  if (!existsSync(marker) && !existsSync(join(site, `${name}.py`))) {
    extractZip(dest, site);
    console.log("extracted", name);
  } else {
    console.log("present", name);
  }
}

const embedName = "python-3.12.7-embed-amd64.zip";
const embedZip = join(tmp, embedName);
const runtime = join(root, "runtime");
if (!existsSync(join(runtime, "python.exe")) || !existsSync(join(runtime, "python312.dll"))) {
  if (!existsSync(embedZip) || statSync(embedZip).size < 1000) {
    const url = "https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip";
    console.log("download", embedName);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`embed download ${response.status}`);
    await pipeline(response.body, createWriteStream(embedZip));
  }
  extractZip(embedZip, runtime);
}
const pthPath = join(runtime, "python312._pth");
const pth = readFileSync(pthPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "import site" && line.trim() !== "#import site" && line.trim() !== "Lib\\site-packages");
if (!pth.includes("Lib\\site-packages")) pth.push("Lib\\site-packages");
pth.push("import site");
writeFileSync(pthPath, `${pth.filter(Boolean).join("\r\n")}\r\n`);
console.log("embed ready");

function extractZip(zipPath, destination) {
  const fd = openSync(zipPath, "r");
  try {
    const size = fstatSync(fd).size;
    const tailSize = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    readSync(fd, tail, 0, tailSize, size - tailSize);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`not a zip: ${zipPath}`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cd.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad zip directory");
      const method = cd.readUInt16LE(cursor + 10);
      const compressedSize = cd.readUInt32LE(cursor + 20);
      const nameLength = cd.readUInt16LE(cursor + 28);
      const extraLength = cd.readUInt16LE(cursor + 30);
      const commentLength = cd.readUInt16LE(cursor + 32);
      const localOffset = cd.readUInt32LE(cursor + 42);
      const name = cd.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      cursor += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith("/")) {
        mkdirSync(join(destination, name), { recursive: true });
        continue;
      }
      const local = Buffer.alloc(30);
      readSync(fd, local, 0, 30, localOffset);
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const compressed = Buffer.alloc(compressedSize);
      readSync(fd, compressed, 0, compressedSize, dataOffset);
      const data = method === 0 ? compressed : inflateRawSync(compressed);
      const outPath = join(destination, name);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, data);
    }
  } finally {
    closeSync(fd);
  }
}

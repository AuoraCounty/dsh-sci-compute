const SUP = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

export function formatQuantity({ value, uncertainty, unit }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  const u = uncertainty == null ? null : Number(uncertainty);
  if (u != null && !Number.isFinite(u)) throw new Error("uncertainty must be a finite number");
  const text = u == null ? formatSig(value, 6) : formatWithUncertainty(value, Math.abs(u));
  return {
    value,
    uncertainty: u,
    unit: unit ?? null,
    text: unit ? `${text} ${unit}` : text,
  };
}

function formatWithUncertainty(value, uncertainty) {
  if (uncertainty === 0) return `${trimFixed(value, 6)} ± 0`;
  const roundedU = roundSig(uncertainty, 2);
  const exp = Math.floor(Math.log10(Math.max(Math.abs(value), roundedU)));
  const places = Math.max(0, 1 - Math.floor(Math.log10(roundedU)));
  if (Math.abs(exp) >= 2 && Math.abs(value) < 1) {
    const scale = 10 ** exp;
    const vp = places - exp;
    return `(${trimFixed(value / scale, vp)} ± ${trimFixed(roundedU / scale, vp)})×10${superscript(exp)}`;
  }
  return `${trimFixed(roundTo(value, places), places)} ± ${trimFixed(roundedU, places)}`;
}

function formatSig(value, sig) {
  if (value === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (Math.abs(exp) >= 2 && Math.abs(value) < 1) {
    const scale = 10 ** exp;
    return `${trimFixed(value / scale, sig - 1)}×10${superscript(exp)}`;
  }
  const places = Math.max(0, sig - 1 - exp);
  return trimFixed(roundTo(value, places), places);
}

function roundSig(value, sig) {
  if (value === 0) return 0;
  const exp = Math.floor(Math.log10(Math.abs(value)));
  const places = sig - 1 - exp;
  return roundTo(value, places);
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function trimFixed(value, places) {
  return value.toFixed(Math.max(0, places));
}

function superscript(exp) {
  return String(exp).split("").map((ch) => SUP[ch] ?? ch).join("");
}

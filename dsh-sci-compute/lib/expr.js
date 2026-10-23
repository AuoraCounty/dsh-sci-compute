const FUNCTIONS = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "exp", "log", "log10", "sqrt", "Abs",
  "sign", "floor", "ceiling", "Min", "Max", "Derivative",
]);

const REJECT = /[\[\]{};=`"'\\]|__|\b(import|exec|eval|lambda|globals|locals|open|compile|getattr|setattr)\b/;

export function parseExpr(input) {
  if (typeof input !== "string") throw new Error("expression must be a string");
  const source = input.trim();
  if (!source) throw new Error("empty expression");
  if (REJECT.test(source)) throw new Error("expression rejected");
  const parser = new Parser(source);
  const node = parser.parseExpression();
  parser.skip();
  if (!parser.eof()) throw new Error("expression rejected");
  return node;
}

export function expressionNames(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "name") out.add(node.name);
  if (node.type === "call") {
    for (const arg of node.args) expressionNames(arg, out);
  }
  if (node.left) expressionNames(node.left, out);
  if (node.right) expressionNames(node.right, out);
  if (node.arg) expressionNames(node.arg, out);
  return out;
}

function rationalToken(token) {
  const match = token.toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) throw new Error("bad number");
  const digits = (match[1] + (match[2] || "")).replace(/^0+(?=\d)/, "") || "0";
  const exponent = BigInt(match[3] || "0") - BigInt((match[2] || "").length);
  if (exponent >= 0n) return (BigInt(digits) * 10n ** exponent).toString();
  return `${digits}/${(10n ** -exponent).toString()}`;
}

class Parser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  eof() {
    return this.index >= this.source.length;
  }

  peek() {
    return this.source[this.index] ?? "";
  }

  skip() {
    while (/\s/u.test(this.peek())) this.index += 1;
  }

  parseExpression() {
    return this.parseAdd();
  }

  parseAdd() {
    let node = this.parseMul();
    for (;;) {
      this.skip();
      const op = this.peek();
      if (op !== "+" && op !== "-") break;
      this.index += 1;
      const right = this.parseMul();
      node = { type: "binop", op, left: node, right };
    }
    return node;
  }

  parseMul() {
    let node = this.parseUnary();
    for (;;) {
      this.skip();
      const op = this.peek();
      if (op !== "*" && op !== "/") break;
      if (op === "*" && this.source[this.index + 1] === "*") break;
      this.index += 1;
      const right = this.parseUnary();
      node = { type: "binop", op, left: node, right };
    }
    return node;
  }

  parseUnary() {
    this.skip();
    const op = this.peek();
    if (op === "+" || op === "-") {
      this.index += 1;
      return { type: "unary", op, arg: this.parseUnary() };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    this.skip();
    if (this.peek() === "^" || (this.peek() === "*" && this.source[this.index + 1] === "*")) {
      const width = this.peek() === "^" ? 1 : 2;
      this.index += width;
      const exp = this.parseUnary();
      return { type: "binop", op: "**", left: base, right: exp };
    }
    return base;
  }

  parsePrimary() {
    this.skip();
    const ch = this.peek();
    if (ch === "(") {
      this.index += 1;
      const node = this.parseExpression();
      this.skip();
      if (this.peek() !== ")") throw new Error("expression rejected");
      this.index += 1;
      return node;
    }
    if (/[0-9]/u.test(ch)) return { type: "num", value: rationalToken(this.readNumber()) };
    if (isIdentStart(ch)) {
      const name = this.readIdent();
      this.skip();
      if (this.peek() === ".") throw new Error("expression rejected");
      if (this.peek() === "(") {
        if (!FUNCTIONS.has(name)) throw new Error("expression rejected");
        this.index += 1;
        const args = [];
        this.skip();
        if (this.peek() !== ")") {
          for (;;) {
            args.push(this.parseExpression());
            this.skip();
            if (this.peek() === ",") {
              this.index += 1;
              continue;
            }
            break;
          }
        }
        if (this.peek() !== ")") throw new Error("expression rejected");
        this.index += 1;
        return { type: "call", name, args };
      }
      return { type: "name", name };
    }
    throw new Error("expression rejected");
  }

  readNumber() {
    const start = this.index;
    while (/[0-9]/u.test(this.peek())) this.index += 1;
    if (this.peek() === "." && /[0-9]/u.test(this.source[this.index + 1] ?? "")) {
      this.index += 1;
      while (/[0-9]/u.test(this.peek())) this.index += 1;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      const next = this.source[this.index + 1] ?? "";
      if (/[0-9]/u.test(next) || ((next === "+" || next === "-") && /[0-9]/u.test(this.source[this.index + 2] ?? ""))) {
        this.index += 1;
        if (this.peek() === "+" || this.peek() === "-") this.index += 1;
        while (/[0-9]/u.test(this.peek())) this.index += 1;
      }
    }
    return this.source.slice(start, this.index);
  }

  readIdent() {
    const start = this.index;
    this.index += 1;
    while (isIdentCont(this.peek())) this.index += 1;
    return this.source.slice(start, this.index);
  }
}

function isIdentStart(ch) {
  return /[\p{L}_]/u.test(ch);
}

function isIdentCont(ch) {
  return /[\p{L}\p{N}_]/u.test(ch);
}

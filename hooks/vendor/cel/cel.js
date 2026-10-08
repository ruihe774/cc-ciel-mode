// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/errors.js
class CelError extends Error {
  #node;
  #code;
  #range;
  #summary;
  constructor({ name, code, message, node, cause, range }) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.#code = code;
    this.#summary = message;
    this.#node = node;
    this.#range = range && normalizeRange(range) || normalizeRange(node);
    if (!node?.input)
      return;
    this.message = formatErrorWithHighlight(this.#summary, node, this.#range);
  }
  get node() {
    return this.#node;
  }
  get code() {
    return this.#code;
  }
  get range() {
    return this.#range;
  }
  get summary() {
    return this.#summary;
  }
  withAst(node) {
    if (this.#node || !node?.input)
      return this;
    this.#node = node;
    this.#range ??= normalizeRange(node);
    this.message = formatErrorWithHighlight(this.#summary, node, this.#range);
    return this;
  }
}
function normalizeArgs(name, defaultCode, message, node, cause) {
  if (typeof message === "string")
    return { name, code: defaultCode, message, node, cause };
  const opts = message;
  if (typeof opts !== "object")
    throw new Error("First param to error must be a string or object");
  return {
    name,
    code: opts.code || defaultCode,
    message: opts.message,
    node: opts.node,
    cause: opts.cause,
    range: opts.range
  };
}

class ParseError extends CelError {
  constructor(message, node, cause) {
    super(normalizeArgs("ParseError", "parse_error", message, node, cause));
  }
}

class EvaluationError extends CelError {
  constructor(message, node, cause) {
    super(normalizeArgs("EvaluationError", "evaluation_error", message, node, cause));
  }
}

class TypeError2 extends CelError {
  constructor(message, node, cause) {
    super(normalizeArgs("TypeError", "type_error", message, node, cause));
  }
}
function parseError(code, message, node) {
  if (typeof code === "object")
    return new ParseError(code);
  return new ParseError({ code, message, node });
}
function evaluationError(code, message, node) {
  if (typeof code === "object")
    return new EvaluationError(code);
  return new EvaluationError({ code, message, node });
}
function typeError(code, message, node) {
  if (typeof code === "object")
    return new TypeError2(code);
  return new TypeError2({ code, message, node });
}
function normalizeRange(node) {
  const start = node?.pos ?? node?.start;
  if (typeof start !== "number")
    return;
  const end = typeof node.end === "number" ? node.end : start;
  return { start, end };
}
function formatErrorWithHighlight(message, node, range) {
  const pos = node.pos ?? range?.start;
  if (typeof pos !== "number")
    return message;
  const input = node.input;
  let lineNum = 1;
  let currentPos = 0;
  let columnNum = 0;
  while (currentPos < pos) {
    if (input[currentPos] === `
`) {
      lineNum++;
      columnNum = 0;
    } else {
      columnNum++;
    }
    currentPos++;
  }
  let contextStart = pos;
  let contextEnd = pos;
  while (contextStart > 0 && input[contextStart - 1] !== `
`)
    contextStart--;
  while (contextEnd < input.length && input[contextEnd] !== `
`)
    contextEnd++;
  const line = input.slice(contextStart, contextEnd);
  const highlight = `> ${`${lineNum}`.padStart(4, " ")} | ${line}
${" ".repeat(9 + columnNum)}^`;
  return `${message}

${highlight}`;
}
function attachErrorAst(error, node) {
  if (error instanceof CelError)
    return error.withAst(node);
  return error;
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/optional.js
class Optional {
  #value;
  constructor(value) {
    this.#value = value;
  }
  static of(value) {
    if (value === undefined)
      return OPTIONAL_NONE;
    return new Optional(value);
  }
  static none() {
    return OPTIONAL_NONE;
  }
  hasValue() {
    return this.#value !== undefined;
  }
  value() {
    if (this.#value === undefined) {
      throw evaluationError("optional_value_missing", "Optional value is not present");
    }
    return this.#value;
  }
  or(optional) {
    if (this.#value !== undefined)
      return this;
    if (optional instanceof Optional)
      return optional;
    throw evaluationError("invalid_optional_argument", "Optional.or must be called with an Optional argument");
  }
  orValue(defaultValue) {
    return this.#value === undefined ? defaultValue : this.#value;
  }
  get [Symbol.toStringTag]() {
    return "optional";
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.#value === undefined ? `Optional { none }` : `Optional { value: ${JSON.stringify(this.#value)} }`;
  }
}
var OPTIONAL_NONE = Object.freeze(new Optional);

class OptionalNamespace {
}
var optionalNamespace = new OptionalNamespace;
function toggleOptionalTypes(registry, enable) {
  const optionalConstant = enable ? optionalNamespace : undefined;
  registry.deleteVariable("optional");
  registry.registerConstant("optional", "OptionalNamespace", optionalConstant);
}
function register(registry) {
  const sync = { async: false };
  const functionOverload = (sig, handler) => registry.registerFunctionOverload(sig, handler, sync);
  const optionalConstant = registry.enableOptionalTypes ? optionalNamespace : undefined;
  registry.registerType("OptionalNamespace", OptionalNamespace);
  registry.registerConstant("optional", "OptionalNamespace", optionalConstant);
  functionOverload("optional.hasValue(): bool", (v) => v.hasValue());
  functionOverload("optional<A>.value(): A", (v) => v.value());
  registry.registerFunctionOverload("OptionalNamespace.none(): optional<T>", () => Optional.none());
  functionOverload("OptionalNamespace.of(A): optional<A>", (_, value) => Optional.of(value));
  function ensureOptional(value, ast, description) {
    if (value instanceof Optional)
      return value;
    throw evaluationError("optional_expected", `${description} must be optional`, ast);
  }
  function evaluateOptional(ev, macro, ctx) {
    const v = ev.run(macro.receiver, ctx);
    if (v instanceof Promise)
      return v.then((_v) => handleOptionalResolved(_v, ev, macro, ctx));
    return handleOptionalResolved(v, ev, macro, ctx);
  }
  function handleOptionalResolved(value, ev, macro, ctx) {
    const optional = ensureOptional(value, macro.receiver, `${macro.functionDesc} receiver`);
    if (optional.hasValue())
      return macro.onHasValue(optional);
    return macro.onEmpty(ev, macro, ctx);
  }
  function ensureOptionalType(checker, node, ctx, description) {
    const type = checker.check(node, ctx);
    if (type.kind === "optional")
      return type;
    if (type.kind === "dyn")
      return checker.getType("optional");
    throw checker.createError("optional_expected", `${description} must be optional, got '${type}'`, node);
  }
  function createOptionalMacro({ functionDesc, evaluate, typeCheck, onHasValue, onEmpty }) {
    return ({ ast, args, receiver }) => ({
      ast,
      functionDesc,
      receiver,
      arg: args[0],
      evaluate,
      typeCheck,
      onHasValue,
      onEmpty
    });
  }
  const invalidOrValueReceiver = "optional.orValue() receiver";
  const invalidOrReceiver = "optional.or(optional) receiver";
  const invalidOrArg = "optional.or(optional) argument";
  registry.registerFunctionOverload("optional.or(ast): optional<dyn>", createOptionalMacro({
    functionDesc: "optional.or(optional)",
    evaluate: evaluateOptional,
    typeCheck(check, macro, ctx) {
      const l = ensureOptionalType(check, macro.receiver, ctx, invalidOrReceiver);
      const r = ensureOptionalType(check, macro.arg, ctx, invalidOrArg);
      if (!(macro.receiver.maybeAsync || macro.arg.maybeAsync))
        macro.ast.setMeta("async", false);
      const unified = l.unify(check.registry, r);
      if (unified)
        return unified;
      throw check.createError("incompatible_argument_type", `${macro.functionDesc} argument must be compatible type, got '${l}' and '${r}'`, macro.arg);
    },
    onHasValue: (optional) => optional,
    onEmpty(ev, macro, ctx) {
      const ast = macro.arg;
      const v = ev.run(ast, ctx);
      if (v instanceof Promise)
        return v.then((_v) => ensureOptional(_v, ast, invalidOrArg));
      return ensureOptional(v, ast, invalidOrArg);
    }
  }));
  registry.registerFunctionOverload("optional.orValue(ast): dyn", createOptionalMacro({
    functionDesc: "optional.orValue(value)",
    onHasValue: (optionalValue) => optionalValue.value(),
    onEmpty(ev, macro, ctx) {
      return ev.run(macro.arg, ctx);
    },
    evaluate: evaluateOptional,
    typeCheck(check, macro, ctx) {
      const l = ensureOptionalType(check, macro.receiver, ctx, invalidOrValueReceiver).valueType;
      const r = check.check(macro.arg, ctx);
      if (!(macro.receiver.maybeAsync || macro.arg.maybeAsync))
        macro.ast.setMeta("async", false);
      const unified = l.unify(check.registry, r);
      if (unified)
        return unified;
      throw check.createError("incompatible_argument_type", `${macro.functionDesc} argument must be compatible type, got '${l}' and '${r}'`, macro.arg);
    }
  }));
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/globals.js
var hasOwn = Object.hasOwn;
var objKeys = Object.keys;
var objFreeze = Object.freeze;
var objEntries = Object.entries;
var isArray = Array.isArray;
var arrayFrom = Array.from;
var MIN_UINT = 0n;
var MAX_UINT = 18446744073709551615n;
var MAX_INT = 9223372036854775807n;
var MIN_INT = -9223372036854775808n;
function isAsync(fn, fallback) {
  if (fn?.[Symbol.toStringTag] === "AsyncFunction")
    return true;
  return typeof fallback === "boolean" ? fallback : true;
}
var RESERVED = new Set([
  "as",
  "break",
  "const",
  "continue",
  "else",
  "for",
  "function",
  "if",
  "import",
  "let",
  "loop",
  "package",
  "namespace",
  "return",
  "var",
  "void",
  "while",
  "__proto__",
  "prototype"
]);

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/functions.js
class UnsignedInt {
  #value;
  constructor(value) {
    this.verify(typeof value === "bigint" ? value : BigInt(value));
  }
  get value() {
    return this.#value;
  }
  valueOf() {
    return this.#value;
  }
  toString() {
    return `${this.#value}`;
  }
  verify(v) {
    if (v < MIN_UINT || v > MAX_UINT) {
      throw evaluationError("numeric_overflow", "Unsigned integer overflow");
    }
    this.#value = v;
  }
  get [Symbol.toStringTag]() {
    return `value = ${this.#value}`;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `UnsignedInteger { value: ${this.#value} }`;
  }
}
var billion = 1e9;
var billionBigInt = 1000000000n;
var UNIT_NANOSECONDS = {
  h: 3600000000000n,
  m: 60000000000n,
  s: billionBigInt,
  ms: 1000000n,
  us: 1000n,
  µs: 1000n,
  ns: 1n
};

class Duration {
  #seconds;
  #nanos;
  constructor(seconds, nanos = 0) {
    this.#seconds = BigInt(seconds);
    this.#nanos = nanos;
  }
  get seconds() {
    return this.#seconds;
  }
  get nanos() {
    return this.#nanos;
  }
  valueOf() {
    return Number(this.#seconds) * 1000 + this.#nanos / 1e6;
  }
  static fromMilliseconds(ms) {
    const totalNanos = BigInt(Math.trunc(ms * 1e6));
    const seconds = totalNanos / billionBigInt;
    const nanos = Number(totalNanos % billionBigInt);
    return new Duration(seconds, nanos);
  }
  addDuration(other) {
    const nanos = this.#nanos + other.nanos;
    return new Duration(this.#seconds + other.seconds + BigInt(Math.floor(nanos / billion)), nanos % billion);
  }
  subtractDuration(other) {
    const nanos = this.#nanos - other.nanos;
    return new Duration(this.#seconds - other.seconds + BigInt(Math.floor(nanos / billion)), (nanos + billion) % billion);
  }
  extendTimestamp(ts) {
    return new Date(ts.getTime() + Number(this.#seconds) * 1000 + Math.floor(this.#nanos / 1e6));
  }
  subtractTimestamp(ts) {
    return new Date(ts.getTime() - Number(this.#seconds) * 1000 - Math.floor(this.#nanos / 1e6));
  }
  toString() {
    const nanos = this.#nanos ? (this.#nanos / billion).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 9 }).slice(1) : "";
    return `${this.#seconds}${nanos}s`;
  }
  getHours() {
    return this.#seconds / 3600n;
  }
  getMinutes() {
    return this.#seconds / 60n;
  }
  getSeconds() {
    return this.#seconds;
  }
  getMilliseconds() {
    return this.#seconds * 1000n + BigInt(Math.floor(this.#nanos / 1e6));
  }
  get [Symbol.toStringTag]() {
    return "google.protobuf.Duration";
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `google.protobuf.Duration { seconds: ${this.#seconds}, nanos: ${this.#nanos} }`;
  }
}
function registerFunctions(registry) {
  const sync = { async: false };
  const functionOverload = (sig, handler) => registry.registerFunctionOverload(sig, handler, sync);
  const identity = (v) => v;
  functionOverload("dyn(dyn): dyn", identity);
  for (const _t in TYPES) {
    const type = TYPES[_t];
    if (!(type instanceof Type))
      continue;
    functionOverload(`type(${type.name}): type`, () => type);
  }
  functionOverload("bool(bool): bool", identity);
  functionOverload("bool(string): bool", (v) => {
    switch (v) {
      case "1":
      case "t":
      case "true":
      case "TRUE":
      case "True":
        return true;
      case "0":
      case "f":
      case "false":
      case "FALSE":
      case "False":
        return false;
      default:
        throw evaluationError("bool_conversion_error", `bool() conversion error: invalid string value "${v}"`);
    }
  });
  functionOverload("size(string): int", (v) => BigInt(stringSize(v)));
  functionOverload("size(bytes): int", (v) => BigInt(v.length));
  functionOverload("size(list): int", (v) => BigInt(v.length ?? v.size));
  functionOverload("size(map): int", (v) => BigInt(v instanceof Map ? v.size : objKeys(v).length));
  functionOverload("string.size(): int", (v) => BigInt(stringSize(v)));
  functionOverload("bytes.size(): int", (v) => BigInt(v.length));
  functionOverload("list.size(): int", (v) => BigInt(v.length ?? v.size));
  functionOverload("map.size(): int", (v) => BigInt(v instanceof Map ? v.size : objKeys(v).length));
  functionOverload("bytes(string): bytes", (v) => ByteOpts.fromString(v));
  functionOverload("bytes(bytes): bytes", identity);
  functionOverload("double(double): double", identity);
  functionOverload("double(int): double", (v) => Number(v));
  functionOverload("double(uint): double", (v) => Number(v));
  functionOverload("double(string): double", (v) => {
    if (!v || v !== v.trim())
      throw evaluationError("double_conversion_error", "double() type error: cannot convert to double");
    const s = v.toLowerCase();
    switch (s) {
      case "inf":
      case "+inf":
      case "infinity":
      case "+infinity":
        return Number.POSITIVE_INFINITY;
      case "-inf":
      case "-infinity":
        return Number.NEGATIVE_INFINITY;
      case "nan":
        return Number.NaN;
      default: {
        const parsed = Number(v);
        if (!Number.isNaN(parsed))
          return parsed;
        throw evaluationError("double_conversion_error", "double() type error: cannot convert to double");
      }
    }
  });
  functionOverload("int(int): int", identity);
  functionOverload("int(double): int", (v) => {
    if (Number.isFinite(v))
      return BigInt(Math.trunc(v));
    throw evaluationError("numeric_overflow", "int() type error: integer overflow");
  });
  functionOverload("int(string): int", (v) => {
    if (v !== v.trim() || v.length > 20 || v.includes("0x")) {
      throw evaluationError("int_conversion_error", "int() type error: cannot convert to int");
    }
    try {
      const num = BigInt(v);
      if (num <= MAX_INT && num >= MIN_INT)
        return num;
    } catch (_e) {}
    throw evaluationError("int_conversion_error", "int() type error: cannot convert to int");
  });
  functionOverload("uint(uint): uint", identity);
  functionOverload("uint(int): uint", (v) => {
    try {
      return new UnsignedInt(v);
    } catch (e) {
      throw evaluationError("uint_conversion_error", "uint() type error: cannot convert to uint");
    }
  });
  functionOverload("uint(double): uint", (v) => {
    try {
      return new UnsignedInt(Math.trunc(v));
    } catch (e) {
      throw evaluationError("numeric_overflow", "uint() type error: unsigned integer overflow");
    }
  });
  functionOverload("uint(string): uint", (v) => {
    if (v !== v.trim() || v.length > 20 || v.includes("0x")) {
      throw evaluationError("uint_conversion_error", "uint() type error: cannot convert to uint");
    }
    try {
      return new UnsignedInt(v);
    } catch (e) {
      throw evaluationError("uint_conversion_error", "uint() type error: cannot convert to uint");
    }
  });
  functionOverload("string(string): string", identity);
  functionOverload("string(bool): string", (v) => `${v}`);
  functionOverload("string(int): string", (v) => `${v}`);
  functionOverload("string(uint): string", (v) => `${v}`);
  functionOverload("string(bytes): string", (v) => ByteOpts.toUtf8(v));
  functionOverload("string(double): string", (v) => {
    if (v === Infinity)
      return "+Inf";
    if (v === -Infinity)
      return "-Inf";
    return `${v}`;
  });
  functionOverload("string.startsWith(string): bool", (a, b) => a.startsWith(b));
  functionOverload("string.endsWith(string): bool", (a, b) => a.endsWith(b));
  functionOverload("string.contains(string): bool", (a, b) => a.includes(b));
  functionOverload("string.lowerAscii(): string", (a) => a.toLowerCase());
  functionOverload("string.upperAscii(): string", (a) => a.toUpperCase());
  functionOverload("string.trim(): string", (a) => a.trim());
  functionOverload("string.indexOf(string): int", (string, search) => BigInt(string.indexOf(search)));
  functionOverload("string.indexOf(string, int): int", (string, search, fromIndex) => {
    if (search === "")
      return fromIndex;
    fromIndex = Number(fromIndex);
    if (fromIndex < 0 || fromIndex >= string.length) {
      throw evaluationError("index_out_of_range", "string.indexOf(search, fromIndex): fromIndex out of range");
    }
    return BigInt(string.indexOf(search, fromIndex));
  });
  functionOverload("string.lastIndexOf(string): int", (string, search) => BigInt(string.lastIndexOf(search)));
  functionOverload("string.lastIndexOf(string, int): int", (string, search, fromIndex) => {
    if (search === "")
      return fromIndex;
    fromIndex = Number(fromIndex);
    if (fromIndex < 0 || fromIndex >= string.length) {
      throw evaluationError("index_out_of_range", "string.lastIndexOf(search, fromIndex): fromIndex out of range");
    }
    return BigInt(string.lastIndexOf(search, fromIndex));
  });
  functionOverload("string.substring(int): string", (string, start) => {
    start = Number(start);
    if (start < 0 || start > string.length) {
      throw evaluationError("index_out_of_range", "string.substring(start, end): start index out of range");
    }
    return string.substring(start);
  });
  functionOverload("string.substring(int, int): string", (string, start, end) => {
    start = Number(start);
    if (start < 0 || start > string.length) {
      throw evaluationError("index_out_of_range", "string.substring(start, end): start index out of range");
    }
    end = Number(end);
    if (end < start || end > string.length) {
      throw evaluationError("index_out_of_range", "string.substring(start, end): end index out of range");
    }
    return string.substring(start, end);
  });
  functionOverload("string.matches(string): bool", (a, b) => {
    try {
      return new RegExp(b).test(a);
    } catch (_err) {
      throw evaluationError("invalid_regular_expression", `Invalid regular expression: ${b}`);
    }
  });
  functionOverload("string.split(string): list<string>", (s, sep) => s.split(sep));
  functionOverload("string.split(string, int): list<string>", (s, sep, l) => {
    l = Number(l);
    if (l === 0)
      return [];
    const parts = s.split(sep);
    if (l < 0 || parts.length <= l)
      return parts;
    const limited = parts.slice(0, l - 1);
    limited.push(parts.slice(l - 1).join(sep));
    return limited;
  });
  functionOverload("list<string>.join(): string", (v) => {
    for (let i = 0;i < v.length; i++) {
      if (typeof v[i] !== "string") {
        throw evaluationError("invalid_list_element_type", "string.join(): list must contain only strings");
      }
    }
    return v.join("");
  });
  functionOverload("list<string>.join(string): string", (v, sep) => {
    for (let i = 0;i < v.length; i++) {
      if (typeof v[i] !== "string") {
        throw evaluationError("invalid_list_element_type", "string.join(separator): list must contain only strings");
      }
    }
    return v.join(sep);
  });
  const textEncoder = new TextEncoder("utf8");
  const textDecoder = new TextDecoder("utf8");
  const ByteOpts = typeof Buffer !== "undefined" ? {
    byteLength: (v) => Buffer.byteLength(v),
    fromString: (str) => Buffer.from(str, "utf8"),
    toHex: (b) => Buffer.prototype.hexSlice.call(b, 0, b.length),
    toBase64: (b) => Buffer.prototype.base64Slice.call(b, 0, b.length),
    toUtf8: (b) => Buffer.prototype.utf8Slice.call(b, 0, b.length),
    jsonParse: (b) => JSON.parse(b)
  } : {
    textEncoder: new TextEncoder("utf8"),
    byteLength: (v) => textEncoder.encode(v).length,
    fromString: (str) => textEncoder.encode(str),
    toHex: Uint8Array.prototype.toHex ? (b) => b.toHex() : (b) => arrayFrom(b, (i) => i.toString(16).padStart(2, "0")).join(""),
    toBase64: Uint8Array.prototype.toBase64 ? (b) => b.toBase64() : (b) => btoa(arrayFrom(b, (i) => String.fromCodePoint(i)).join("")),
    toUtf8: (b) => textDecoder.decode(b),
    jsonParse: (b) => JSON.parse(textEncoder.decode(b))
  };
  functionOverload("bytes.json(): map", ByteOpts.jsonParse);
  functionOverload("bytes.hex(): string", ByteOpts.toHex);
  functionOverload("bytes.string(): string", ByteOpts.toUtf8);
  functionOverload("bytes.base64(): string", ByteOpts.toBase64);
  functionOverload("bytes.at(int): int", (b, index) => {
    if (index < 0 || index >= b.length) {
      throw evaluationError("index_out_of_range", "Bytes index out of range");
    }
    return BigInt(b[index]);
  });
  const TS = "google.protobuf.Timestamp";
  const GPD = "google.protobuf.Duration";
  const TimestampType = registry.registerType(TS, Date).typeType;
  const DurationType = registry.registerType(GPD, Duration).typeType;
  registry.registerConstant("google", "map<string, map<string, type>>", {
    protobuf: { Duration: DurationType, Timestamp: TimestampType }
  });
  function tzDate(d, timeZone) {
    return new Date(d.toLocaleString("en-US", { timeZone }));
  }
  function getDayOfYear(d, tz) {
    const workingDate = tz ? tzDate(d, tz) : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const start = new Date(workingDate.getFullYear(), 0, 0);
    return BigInt(Math.floor((workingDate - start) / 86400000) - 1);
  }
  functionOverload(`timestamp(string): ${TS}`, (v) => {
    if (v.length < 20 || v.length > 30) {
      throw evaluationError("invalid_timestamp", "timestamp() requires a string in ISO 8601 format");
    }
    const d = new Date(v);
    if (d <= 253402300799999 && d >= -62135596800000)
      return d;
    throw evaluationError("invalid_timestamp", "timestamp() requires a string in ISO 8601 format");
  });
  functionOverload(`timestamp(int): ${TS}`, (i) => {
    i = Number(i) * 1000;
    if (i <= 253402300799999 && i >= -62135596800000)
      return new Date(i);
    throw evaluationError("invalid_timestamp", "timestamp() requires a valid integer unix timestamp");
  });
  functionOverload(`${TS}.getDate(): int`, (d) => BigInt(d.getUTCDate()));
  functionOverload(`${TS}.getDate(string): int`, (d, tz) => BigInt(tzDate(d, tz).getDate()));
  functionOverload(`${TS}.getDayOfMonth(): int`, (d) => BigInt(d.getUTCDate() - 1));
  functionOverload(`${TS}.getDayOfMonth(string): int`, (d, tz) => BigInt(tzDate(d, tz).getDate() - 1));
  functionOverload(`${TS}.getDayOfWeek(): int`, (d) => BigInt(d.getUTCDay()));
  functionOverload(`${TS}.getDayOfWeek(string): int`, (d, tz) => BigInt(tzDate(d, tz).getDay()));
  functionOverload(`${TS}.getDayOfYear(): int`, getDayOfYear);
  functionOverload(`${TS}.getDayOfYear(string): int`, getDayOfYear);
  functionOverload(`${TS}.getFullYear(): int`, (d) => BigInt(d.getUTCFullYear()));
  functionOverload(`${TS}.getFullYear(string): int`, (d, tz) => BigInt(tzDate(d, tz).getFullYear()));
  functionOverload(`${TS}.getHours(): int`, (d) => BigInt(d.getUTCHours()));
  functionOverload(`${TS}.getHours(string): int`, (d, tz) => BigInt(tzDate(d, tz).getHours()));
  functionOverload(`${TS}.getMilliseconds(): int`, (d) => BigInt(d.getUTCMilliseconds()));
  functionOverload(`${TS}.getMilliseconds(string): int`, (d) => BigInt(d.getUTCMilliseconds()));
  functionOverload(`${TS}.getMinutes(): int`, (d) => BigInt(d.getUTCMinutes()));
  functionOverload(`${TS}.getMinutes(string): int`, (d, tz) => BigInt(tzDate(d, tz).getMinutes()));
  functionOverload(`${TS}.getMonth(): int`, (d) => BigInt(d.getUTCMonth()));
  functionOverload(`${TS}.getMonth(string): int`, (d, tz) => BigInt(tzDate(d, tz).getMonth()));
  functionOverload(`${TS}.getSeconds(): int`, (d) => BigInt(d.getUTCSeconds()));
  functionOverload(`${TS}.getSeconds(string): int`, (d, tz) => BigInt(tzDate(d, tz).getSeconds()));
  const parseDurationPattern = /(\d*\.?\d*)(ns|us|µs|ms|s|m|h)/;
  function parseDuration(string) {
    if (!string)
      throw evaluationError("invalid_duration", `Invalid duration string: ''`);
    const isNegative = string[0] === "-";
    if (string[0] === "-" || string[0] === "+")
      string = string.slice(1);
    let nanoseconds = BigInt(0);
    while (true) {
      const match = parseDurationPattern.exec(string);
      if (!match)
        throw evaluationError("invalid_duration", `Invalid duration string: ${string}`);
      if (match.index !== 0)
        throw evaluationError("invalid_duration", `Invalid duration string: ${string}`);
      string = string.slice(match[0].length);
      const unitNanos = UNIT_NANOSECONDS[match[2]];
      const [intPart = "0", fracPart = ""] = match[1].split(".");
      const intVal = BigInt(intPart) * unitNanos;
      const fracNanos = fracPart ? BigInt(fracPart.slice(0, 13).padEnd(13, "0")) * unitNanos / 10000000000000n : 0n;
      nanoseconds += intVal + fracNanos;
      if (string === "")
        break;
    }
    const seconds = nanoseconds >= billionBigInt ? nanoseconds / billionBigInt : 0n;
    const nanos = Number(nanoseconds % billionBigInt);
    if (isNegative)
      return new Duration(-seconds, -nanos);
    return new Duration(seconds, nanos);
  }
  functionOverload(`duration(string): google.protobuf.Duration`, (s) => parseDuration(s));
  functionOverload(`google.protobuf.Duration.getHours(): int`, (d) => d.getHours());
  functionOverload(`google.protobuf.Duration.getMinutes(): int`, (d) => d.getMinutes());
  functionOverload(`google.protobuf.Duration.getSeconds(): int`, (d) => d.getSeconds());
  functionOverload(`google.protobuf.Duration.getMilliseconds(): int`, (d) => d.getMilliseconds());
  register(registry);
}
function stringSize(str) {
  let count = 0;
  for (const c of str)
    count++;
  return count;
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/registry.js
class Type {
  #name;
  constructor(name) {
    this.#name = name;
    objFreeze(this);
  }
  get name() {
    return this.#name;
  }
  get [Symbol.toStringTag]() {
    return `Type<${this.#name}>`;
  }
  toString() {
    return `Type<${this.#name}>`;
  }
}
var TYPES = {
  string: new Type("string"),
  bool: new Type("bool"),
  int: new Type("int"),
  uint: new Type("uint"),
  double: new Type("double"),
  map: new Type("map"),
  list: new Type("list"),
  bytes: new Type("bytes"),
  null_type: new Type("null"),
  type: new Type("type")
};
var optionalType = new Type("optional");
var valueTypeMatchers = {
  dyn(v, ev) {
    switch (typeof v) {
      case "string":
      case "bigint":
      case "number":
      case "boolean":
        return true;
      case "object":
        switch (v ? v.constructor : v) {
          case null:
          case undefined:
          case Object:
          case Map:
          case Array:
          case Set:
            return true;
          default:
            if (ev.objectTypesByConstructor.get(v.constructor))
              return true;
        }
    }
    return !!ev.debugType(v);
  },
  string(v) {
    return typeof v === "string";
  },
  int(v) {
    return typeof v === "bigint";
  },
  double(v) {
    return typeof v === "number";
  },
  bool(v) {
    return typeof v === "boolean";
  },
  null(v) {
    return v === null;
  },
  bytes(v) {
    return v instanceof Uint8Array;
  },
  uint(v) {
    return v instanceof UnsignedInt;
  },
  type(v) {
    return v instanceof Type;
  },
  list(v) {
    switch (v?.constructor) {
      case Array:
      case Set:
        return true;
      default:
        return false;
    }
  },
  map(v) {
    switch (typeof v === "object" && v ? v.constructor : null) {
      case undefined:
      case Object:
      case Map:
        return true;
      default:
        return false;
    }
  },
  optional(v) {
    return v instanceof Optional;
  },
  message(v, ev) {
    return this === ev.debugType(v);
  }
};
valueTypeMatchers.param = valueTypeMatchers.dyn;

class TypeDeclaration {
  #matchesCache = new WeakMap;
  constructor({ kind, type, name, keyType, valueType }) {
    this.kind = kind;
    this.type = type;
    this.name = name;
    this.keyType = keyType;
    this.valueType = valueType;
    this.unwrappedType = kind === "dyn" && valueType ? valueType.unwrappedType : this;
    this.wrappedType = kind === "dyn" ? this : _createDynType(this.unwrappedType);
    this.hasDynType = this.kind === "dyn" || this.valueType?.hasDynType || this.keyType?.hasDynType || false;
    this.hasPlaceholderType = this.kind === "param" || this.keyType?.hasPlaceholderType || this.valueType?.hasPlaceholderType || false;
    if (kind === "list")
      this.fieldLazy = this.#getListField;
    else if (kind === "map")
      this.fieldLazy = this.#getMapField;
    else if (kind === "message")
      this.fieldLazy = this.#getMessageField;
    else if (kind === "optional")
      this.fieldLazy = this.#getOptionalField;
    this.matchesValueType = valueTypeMatchers[name] || valueTypeMatchers[kind];
    objFreeze(this);
  }
  isDynOrBool() {
    return this.type === "bool" || this.kind === "dyn";
  }
  isEmpty() {
    return this.valueType && this.valueType.kind === "param";
  }
  unify(r, t2) {
    const t1 = this;
    if (t1 === t2 || t1.kind === "dyn" || t2.kind === "param")
      return t1;
    if (t2.kind === "dyn" || t1.kind === "param")
      return t2;
    if (t1.kind !== t2.kind)
      return null;
    if (!(t1.hasPlaceholderType || t2.hasPlaceholderType || t1.hasDynType || t2.hasDynType))
      return null;
    const valueType = t1.valueType.unify(r, t2.valueType);
    if (!valueType)
      return null;
    switch (t1.kind) {
      case "optional":
        return r.getOptionalType(valueType);
      case "list":
        return r.getListType(valueType);
      case "map":
        const keyType = t1.keyType.unify(r, t2.keyType);
        return keyType ? r.getMapType(keyType, valueType) : null;
    }
  }
  templated(r, bind) {
    if (!this.hasPlaceholderType)
      return this;
    switch (this.kind) {
      case "dyn":
        return this.valueType.templated(r, bind);
      case "param":
        return bind?.get(this.name) || this;
      case "map":
        return r.getMapType(this.keyType.templated(r, bind), this.valueType.templated(r, bind));
      case "list":
        return r.getListType(this.valueType.templated(r, bind));
      case "optional":
        return r.getOptionalType(this.valueType.templated(r, bind));
      default:
        return this;
    }
  }
  toString() {
    return this.name;
  }
  #getOptionalField(obj, key, ast, ev) {
    obj = obj instanceof Optional ? obj.orValue() : obj;
    if (obj === undefined)
      return OPTIONAL_NONE;
    const type = ev.debugType(obj);
    try {
      return Optional.of(type.fieldLazy(obj, key, ast, ev));
    } catch (e) {
      if (e instanceof EvaluationError)
        return OPTIONAL_NONE;
      throw e;
    }
  }
  #getMessageField(obj, key, ast, ev) {
    const message = obj ? ev.objectTypesByConstructor.get(obj.constructor) : undefined;
    if (!message)
      return;
    const type = message.fields ? message.fields[key] : dynType;
    if (!type)
      return;
    const value = obj instanceof Map ? obj.get(key) : obj[key];
    if (value === undefined)
      return;
    if (type.matchesValueType(value, ev))
      return value;
    throw evaluationError("field_type_mismatch", `Field '${key}' is not of type '${type}', got '${ev.debugType(value)}'`, ast);
  }
  #getMapField(obj, key, ast, ev) {
    const value = obj instanceof Map ? obj.get(key) : obj && hasOwn(obj, key) ? obj[key] : undefined;
    if (value === undefined)
      return;
    if (this.valueType.matchesValueType(value, ev))
      return value;
    throw evaluationError("field_type_mismatch", `Field '${key}' is not of type '${this.valueType}', got '${ev.debugType(value)}'`, ast);
  }
  #getListElementAtIndex(list, pos) {
    switch (list?.constructor) {
      case Array:
        return list[pos];
      case Set: {
        let i = 0;
        for (const item of list) {
          if (i++ !== pos)
            continue;
          return item;
        }
      }
    }
  }
  #getListField(obj, key, ast, ev) {
    if (typeof key === "bigint")
      key = Number(key);
    else if (typeof key !== "number")
      return;
    const value = this.#getListElementAtIndex(obj, key);
    if (value === undefined) {
      if (!obj)
        return;
      throw evaluationError("index_out_of_bounds", `No such key: index out of bounds, index ${key} ${key < 0 ? "< 0" : `>= size ${obj.length || obj.size}`}`, ast);
    }
    if (this.valueType.matchesValueType(value, ev))
      return value;
    throw evaluationError("list_item_type_mismatch", `List item with index '${key}' is not of type '${this.valueType}', got '${ev.debugType(value)}'`, ast);
  }
  fieldLazy() {}
  field(obj, key, ast, ev) {
    const v = this.fieldLazy(obj, key, ast, ev);
    if (v !== undefined)
      return v;
    throw evaluationError("no_such_key", `No such key: ${key}`, ast);
  }
  matchesBoth(other) {
    return this.matches(other) && other.matches(this);
  }
  matches(o) {
    const s = this.unwrappedType;
    o = o.unwrappedType;
    if (s === o || s.kind === "dyn" || o.kind === "dyn" || o.kind === "param")
      return true;
    return this.#matchesCache.get(o) ?? this.#matchesCache.set(o, this.#matches(s, o)).get(o);
  }
  #matches(s, o) {
    switch (s.kind) {
      case "dyn":
      case "param":
        return true;
      case "list":
        return o.kind === "list" && s.valueType.matches(o.valueType);
      case "map":
        return o.kind === "map" && s.keyType.matches(o.keyType) && s.valueType.matches(o.valueType);
      case "optional":
        return o.kind === "optional" && s.valueType.matches(o.valueType);
      default:
        return s.name === o.name;
    }
  }
}
var macroEvaluateErr = `have a .callAst property or .evaluate(checker, macro, ctx) method.`;
var macroTypeCheckErr = `have a .callAst property or .typeCheck(checker, macro, ctx) method.`;
function wrapMacroExpander(name, handler) {
  const p = `Macro '${name}' must`;
  return function macroExpander(opts) {
    const macro = handler(opts);
    if (!macro || typeof macro !== "object")
      throw new Error(`${p} return an object.`);
    if (macro.callAst)
      return macro;
    if (!macro.evaluate)
      throw new Error(`${p} ${macroEvaluateErr}`);
    if (!macro.typeCheck)
      throw new Error(`${p} ${macroTypeCheckErr}`);
    return macro;
  };
}

class VariableDeclaration {
  constructor(name, type, description, value) {
    this.name = name;
    this.type = type;
    this.description = description ?? null;
    this.constant = value !== undefined;
    this.value = value;
    objFreeze(this);
  }
}

class FunctionDeclaration {
  constructor({ name, receiverType, returnType, handler, description, params, async }) {
    if (typeof name !== "string")
      throw new Error("name must be a string");
    if (typeof handler !== "function")
      throw new Error("handler must be a function");
    this.name = name;
    this.async = isAsync(handler, async);
    this.receiverType = receiverType ?? null;
    this.returnType = returnType;
    this.description = description ?? null;
    this.params = params;
    this.argTypes = params.map((p) => p.type);
    this.macro = this.argTypes.includes(astType);
    const receiverString = receiverType ? `${receiverType}.` : "";
    this.signature = `${receiverString}${name}(${this.argTypes.join(", ")}): ${returnType}`;
    this.handler = this.macro ? wrapMacroExpander(this.signature, handler) : handler;
    this.partitionKey = `${receiverType ? "rcall" : "call"}:${name}:${params.length}`;
    this.hasPlaceholderType = this.returnType.hasPlaceholderType || this.receiverType?.hasPlaceholderType || this.argTypes.some((t) => t.hasPlaceholderType) || false;
    objFreeze(this);
  }
  matchesArgs(argTypes) {
    return argTypes.length === this.argTypes.length && this.argTypes.every((t, i) => t.matches(argTypes[i])) ? this : null;
  }
}

class OperatorDeclaration {
  constructor({ op, leftType, rightType, handler, returnType, async }) {
    this.operator = op;
    this.leftType = leftType;
    this.rightType = rightType || null;
    this.handler = handler;
    this.async = isAsync(handler, async);
    this.returnType = returnType;
    if (rightType)
      this.signature = `${leftType} ${op} ${rightType}: ${returnType}`;
    else
      this.signature = `${op}${leftType}: ${returnType}`;
    this.hasPlaceholderType = this.leftType.hasPlaceholderType || this.rightType?.hasPlaceholderType || false;
    objFreeze(this);
  }
  equals(other) {
    return this.operator === other.operator && this.leftType === other.leftType && this.rightType === other.rightType;
  }
}
function _createListType(valueType) {
  return new TypeDeclaration({
    kind: "list",
    name: `list<${valueType}>`,
    type: "list",
    valueType
  });
}
function _createPrimitiveType(name) {
  return new TypeDeclaration({ kind: "primitive", name, type: name });
}
function _createMessageType(name) {
  return new TypeDeclaration({ kind: "message", name, type: name });
}
function _createDynType(valueType) {
  const name = valueType ? `dyn<${valueType}>` : "dyn";
  return new TypeDeclaration({ kind: "dyn", name, type: name, valueType });
}
function _createOptionalType(valueType) {
  const name = `optional<${valueType}>`;
  return new TypeDeclaration({ kind: "optional", name, type: "optional", valueType });
}
function _createMapType(keyType, valueType) {
  return new TypeDeclaration({
    kind: "map",
    name: `map<${keyType}, ${valueType}>`,
    type: "map",
    keyType,
    valueType
  });
}
function _createPlaceholderType(name) {
  return new TypeDeclaration({ kind: "param", name, type: name });
}
var dynType = _createDynType();
var astType = _createPrimitiveType("ast");
var listType = _createListType(dynType);
var mapType = _createMapType(dynType, dynType);
var celTypes = {
  string: _createPrimitiveType("string"),
  bool: _createPrimitiveType("bool"),
  int: _createPrimitiveType("int"),
  uint: _createPrimitiveType("uint"),
  double: _createPrimitiveType("double"),
  bytes: _createPrimitiveType("bytes"),
  dyn: dynType,
  null: _createPrimitiveType("null"),
  type: _createPrimitiveType("type"),
  optional: _createOptionalType(dynType),
  list: listType,
  "list<dyn>": listType,
  map: mapType,
  "map<dyn, dyn>": mapType
};
for (const t of [celTypes.string, celTypes.double, celTypes.int]) {
  const list = _createListType(t);
  const map = _createMapType(celTypes.string, t);
  celTypes[list.name] = list;
  celTypes[map.name] = map;
}
Object.freeze(celTypes);

class Candidates {
  returnType = null;
  async = false;
  macro = false;
  #matchCache = null;
  #checkCache = null;
  declarations = [];
  constructor(registry) {
    this.registry = registry;
  }
  [Symbol.iterator]() {
    return this.declarations[Symbol.iterator]();
  }
  add(decl) {
    this.returnType = (this.returnType || decl.returnType).unify(this.registry, decl.returnType) || dynType;
    if (decl.macro)
      this.macro = decl;
    if (decl.async && !this.async)
      this.async = true;
    this.declarations.push(decl);
    this.#matchCache?.clear();
    this.#checkCache?.clear();
  }
  findFunction(argTypes, receiverType = null) {
    for (let i = 0;i < this.declarations.length; i++) {
      const match = this.#matchesFunction(this.declarations[i], argTypes, receiverType);
      if (match)
        return match;
    }
    return null;
  }
  findUnaryOverload(left) {
    const cached = (this.#matchCache ??= new Map).get(left);
    if (cached !== undefined)
      return cached;
    let value = false;
    for (const decl of this.declarations) {
      if (decl.leftType !== left)
        continue;
      value = decl;
      break;
    }
    this.#matchCache.set(left, value);
    return value;
  }
  findBinaryOverload(left, right) {
    if (left.kind === "dyn" && left.valueType)
      right = right.wrappedType;
    else if (right.kind === "dyn" && right.valueType)
      left = left.wrappedType;
    return (this.#matchCache ??= new Map).get(left)?.get(right) ?? this.#cacheBinary(this.#matchCache, left, right, this.#findBinaryUncached(left, right));
  }
  checkBinaryOverload(left, right) {
    return (this.#checkCache ??= new Map).get(left)?.get(right) ?? this.#cacheBinary(this.#checkCache, left, right, this.#checkBinaryUncached(left, right));
  }
  #cacheBinary(c, l, r, v) {
    return (c.get(l) || c.set(l, new Map).get(l)).set(r, v), v;
  }
  #findBinaryUncached(left, right) {
    const ops = this.#findBinaryOverloads(left, right);
    if (ops.length === 0)
      return false;
    if (ops.length === 1)
      return ops[0];
    throw new Error(`Operator overload '${ops[0].signature}' overlaps with '${ops[1].signature}'.`);
  }
  #checkBinaryUncached(left, right) {
    const ops = this.#findBinaryOverloads(left, right);
    if (ops.length === 0)
      return false;
    let rt = ops[0].returnType;
    for (let i = 1;i < ops.length; i++)
      rt = rt.unify(this.registry, ops[i].returnType) || dynType;
    return rt;
  }
  #findBinaryOverloads(leftType, rightType) {
    const nonexactMatches = [];
    for (const decl of this.declarations) {
      if (decl.leftType === leftType && decl.rightType === rightType)
        return [decl];
      const secondary = this.#matchBinaryOverload(decl, leftType, rightType);
      if (secondary)
        nonexactMatches.push(secondary);
    }
    if (nonexactMatches.length === 0) {
      const op = this.declarations[0]?.operator;
      if ((op === "==" || op === "!=") && leftType.kind === "dyn") {
        return fallbackDynEqualityMatchers[op];
      }
    }
    return nonexactMatches;
  }
  #matchBinaryOverload(decl, actualLeft, actualRight) {
    const bindings = decl.hasPlaceholderType ? new Map : null;
    const leftType = this.#matchTypeWithPlaceholders(decl.leftType, actualLeft, bindings);
    if (!leftType)
      return;
    const rightType = this.#matchTypeWithPlaceholders(decl.rightType, actualRight, bindings);
    if (!rightType)
      return;
    if ((decl.operator === "==" || decl.operator === "!=") && decl.leftType.kind === "dyn" && decl.leftType.valueType && actualLeft.kind !== "dyn" && actualRight.kind !== "dyn")
      return false;
    return decl.hasPlaceholderType ? {
      async: decl.async,
      signature: decl.signature,
      handler: decl.handler,
      leftType,
      rightType,
      returnType: decl.returnType.templated(this.registry, bindings)
    } : decl;
  }
  #matchesFunction(fn, argTypes, receiverType) {
    if (fn.hasPlaceholderType)
      return this.#matchWithPlaceholders(fn, argTypes, receiverType);
    if (receiverType && fn.receiverType && !receiverType.matches(fn.receiverType))
      return;
    return fn.matchesArgs(argTypes);
  }
  #matchWithPlaceholders(fn, argTypes, receiverType) {
    const bindings = new Map;
    if (receiverType && fn.receiverType) {
      if (!this.#matchTypeWithPlaceholders(fn.receiverType, receiverType, bindings)) {
        return null;
      }
    }
    for (let i = 0;i < argTypes.length; i++) {
      if (!this.#matchTypeWithPlaceholders(fn.argTypes[i], argTypes[i], bindings)) {
        return null;
      }
    }
    return {
      async: fn.async,
      handler: fn.handler,
      signature: fn.signature,
      returnType: fn.returnType.templated(this.registry, bindings)
    };
  }
  #matchTypeWithPlaceholders(declared, actual, bindings) {
    if (!declared.hasPlaceholderType)
      return actual.matches(declared) ? actual : null;
    const treatAsDyn = actual.kind === "dyn";
    if (!this.#collectPlaceholderBindings(declared, actual, bindings, treatAsDyn))
      return null;
    if (treatAsDyn)
      return actual;
    return actual.matches(declared.templated(this.registry, bindings)) ? actual : null;
  }
  #collectPlaceholderBindings(dec, act, bind, fromDyn = false) {
    if (!dec.hasPlaceholderType)
      return true;
    if (!act)
      return false;
    const asDyn = fromDyn || act.kind === "dyn";
    act = act.unwrappedType;
    switch (dec.kind) {
      case "param": {
        const type = asDyn ? dynType : act;
        const existing = bind.get(dec.name);
        if (!existing)
          return bind.set(dec.name, type) && true;
        return existing.kind === "dyn" || type.kind === "dyn" ? true : existing.matchesBoth(type);
      }
      case "list": {
        if (act.name === "dyn")
          act = dec;
        if (act.kind !== "list")
          return false;
        return this.#collectPlaceholderBindings(dec.valueType, act.valueType, bind, asDyn);
      }
      case "map": {
        if (act.name === "dyn")
          act = dec;
        if (act.kind !== "map")
          return false;
        return this.#collectPlaceholderBindings(dec.keyType, act.keyType, bind, asDyn) && this.#collectPlaceholderBindings(dec.valueType, act.valueType, bind, asDyn);
      }
      case "optional": {
        if (act.name === "dyn")
          act = dec;
        if (act.kind !== "optional")
          return false;
        return this.#collectPlaceholderBindings(dec.valueType, act.valueType, bind, asDyn);
      }
    }
    return true;
  }
}
function splitByComma(str) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of str) {
    if (char === "<")
      depth++;
    else if (char === ">")
      depth--;
    else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current)
    parts.push(current.trim());
  return parts;
}
var objTypesDecls = [
  [UnsignedInt, "uint", TYPES.uint, celTypes.uint],
  [Type, "type", TYPES.type, celTypes.type],
  [Optional, "optional", optionalType, celTypes.optional],
  [Uint8Array, "bytes", TYPES.bytes, celTypes.bytes],
  ...typeof Buffer !== "undefined" ? [[Buffer, "bytes", TYPES.bytes, celTypes.bytes]] : []
].map(([ctor, name, typeType, type]) => Object.freeze({ name, typeType, type, ctor }));
var objTypes = objTypesDecls.map((t) => [t.name, t]);
var objTypesCtor = objTypesDecls.map((t) => [t.ctor, t]);
var invalidVar = (postfix) => new Error(`Invalid variable declaration: ${postfix}`);
var invalidType = (postfix) => new Error(`Invalid type declaration: ${postfix}`);
var fallbackDynEqualityMatchers = {
  "==": [{ handler: (a, b) => a === b, returnType: celTypes.bool }],
  "!=": [{ handler: (a, b) => a !== b, returnType: celTypes.bool }]
};

class Registry {
  #parent = null;
  #typeDeclarations;
  #ownsVariables = true;
  #operators = null;
  #functions = null;
  #operatorsByOp = null;
  #functionsByKey = null;
  #listTypes = null;
  #mapTypes = null;
  #optionalTypes = null;
  #others = null;
  #locked = false;
  constructor(opts = {}) {
    this.enableOptionalTypes = opts.enableOptionalTypes ?? false;
    this.unlistedVariablesAreDyn = opts.unlistedVariablesAreDyn ?? false;
    const parent = opts.parent instanceof Registry ? opts.parent : null;
    if (parent) {
      this.#parent = parent;
      let opParent = parent;
      while (opParent && !opParent.#operators)
        opParent = opParent.#parent;
      let fnParent = parent;
      while (fnParent && !fnParent.#functions)
        fnParent = fnParent.#parent;
      this.#operatorsByOp = parent.#operatorsByOp;
      this.#functionsByKey = parent.#functionsByKey;
      this.#others = { operators: opParent.#operators, functions: fnParent.#functions };
      this.objectTypes = new Map(parent.objectTypes);
      this.objectTypesByConstructor = new Map(parent.objectTypesByConstructor);
      this.variables = parent.variables;
      this.#ownsVariables = false;
      this.#typeDeclarations = parent.#typeDeclarations;
      this.#listTypes = parent.#listTypes;
      this.#mapTypes = parent.#mapTypes;
      this.#optionalTypes = parent.#optionalTypes;
      if (this.enableOptionalTypes !== parent.enableOptionalTypes || this.unlistedVariablesAreDyn !== parent.unlistedVariablesAreDyn) {
        toggleOptionalTypes(this, this.enableOptionalTypes);
      }
    } else {
      this.#operators = [];
      this.#functions = [];
      this.objectTypes = new Map(objTypes);
      this.objectTypesByConstructor = new Map(objTypesCtor);
      this.#typeDeclarations = new Map(objEntries(celTypes));
      this.#listTypes = new Map;
      this.#mapTypes = new Map;
      this.#optionalTypes = new Map;
      this.variables = new Map;
      this.variables.dyn = this.unlistedVariablesAreDyn;
      for (const n in TYPES)
        this.registerConstant(n, "type", TYPES[n]);
    }
  }
  #ensureOwnVariables() {
    if (this.#ownsVariables)
      return;
    this.variables = new Map(this.variables);
    this.variables.dyn = this.unlistedVariablesAreDyn;
    this.#ownsVariables = true;
  }
  deleteVariable(name) {
    this.#ensureOwnVariables();
    this.variables.delete(name);
  }
  #pushOperator(decl) {
    if (!this.#operators)
      this.#operatorsByOp = null;
    this.operatorCandidates(decl.operator).add(decl);
    this.#operators.push(decl);
  }
  #pushFunction(decl) {
    if (!this.#functions)
      this.#functionsByKey = null;
    this.#functionCandidates(decl.partitionKey).add(decl);
    this.#functions.push(decl);
  }
  #ensureCandiate(c, key) {
    return c.get(key) || c.set(key, new Candidates(this)).get(key);
  }
  #getOperators() {
    if (this.#operators)
      return this.#operators;
    return this.#operators = [...this.#others.operators];
  }
  #getFunctions() {
    if (this.#functions)
      return this.#functions;
    return this.#functions = [...this.#others.functions];
  }
  operatorCandidates(op) {
    if (this.#operatorsByOp)
      return this.#ensureCandiate(this.#operatorsByOp, op);
    const c = this.#operatorsByOp = new Map;
    for (const decl of this.#getOperators())
      this.#ensureCandiate(c, decl.operator).add(decl);
    return this.#ensureCandiate(c, op);
  }
  functionCandidates(rec, name, argLen) {
    return this.#functionCandidates(`${rec ? "rcall" : "call"}:${name}:${argLen}`);
  }
  #functionCandidates(key) {
    if (this.#functionsByKey)
      return this.#ensureCandiate(this.#functionsByKey, key);
    const c = this.#functionsByKey = new Map;
    for (const decl of this.#getFunctions())
      this.#ensureCandiate(c, decl.partitionKey).add(decl);
    return this.#ensureCandiate(c, key);
  }
  registerVariable(name, type, opts) {
    if (this.#locked)
      throw new Error("Cannot modify frozen registry");
    let description = opts?.description;
    let value;
    if (typeof name === "string" && typeof type === "object" && !(type instanceof TypeDeclaration)) {
      description = type.description;
      value = type.value;
      if (type.schema)
        type = this.registerType({ name: `$${name}`, schema: type.schema }).type;
      else
        type = type.type;
    } else if (typeof name === "object") {
      if (name.schema)
        type = this.registerType({ name: `$${name.name}`, schema: name.schema }).type;
      else
        type = name.type;
      description = name.description;
      value = name.value;
      name = name.name;
    }
    if (typeof name !== "string" || !name)
      throw invalidVar(`name must be a string`);
    if (RESERVED.has(name))
      throw invalidVar(`'${name}' is a reserved name`);
    if (this.variables.get(name) !== undefined)
      throw invalidVar(`'${name}' is already registered`);
    if (typeof type === "string")
      type = this.getType(type);
    else if (!(type instanceof TypeDeclaration))
      throw invalidVar(`type is required`);
    this.#ensureOwnVariables();
    this.variables.set(name, new VariableDeclaration(name, type, description, value));
    return this;
  }
  #registerSchemaAsType(name, schema) {
    const fields = Object.create(null);
    for (const key of objKeys(schema)) {
      const def = schema[key];
      if (typeof def === "object" && def) {
        fields[key] = this.registerType({ name: `${name}.${key}`, schema: def }).type.name;
      } else if (typeof def === "string") {
        fields[key] = def;
      } else {
        throw new Error(`Invalid field definition for '${name}.${key}'`);
      }
    }
    return fields;
  }
  registerConstant(name, type, value) {
    if (typeof name === "object")
      this.registerVariable(name);
    else
      this.registerVariable({ name, type, value });
    return this;
  }
  getType(typename) {
    return this.#parseTypeString(typename, true);
  }
  getListType(type) {
    return this.#listTypes.get(type) || this.#listTypes.set(type, this.#parseTypeString(`list<${type}>`, true)).get(type);
  }
  getMapType(a, b) {
    return this.#mapTypes.get(a)?.get(b) || (this.#mapTypes.get(a) || this.#mapTypes.set(a, new Map).get(a)).set(b, this.#parseTypeString(`map<${a}, ${b}>`, true)).get(b);
  }
  getOptionalType(type) {
    return this.#optionalTypes.get(type) || this.#optionalTypes.set(type, this.#parseTypeString(`optional<${type}>`, true)).get(type);
  }
  assertType(typename, type, signature) {
    try {
      return this.#parseTypeString(typename, true);
    } catch (e) {
      e.message = `Invalid ${type} '${e.unknownType || typename}' in '${signature}'`;
      throw e;
    }
  }
  getFunctionType(typename) {
    if (typename === "ast")
      return astType;
    const t = this.#parseTypeString(typename, true);
    if (t.kind === "dyn" && t.valueType)
      throw new Error(`type '${t.name}' is not supported`);
    return t;
  }
  registerType(name, _d) {
    if (this.#locked)
      throw new Error("Cannot modify frozen registry");
    if (typeof name === "object")
      _d = name, name = _d.fullName || _d.name || _d.ctor?.name;
    if (typeof name === "string" && name[0] === ".")
      name = name.slice(1);
    if (typeof name !== "string" || name.length < 2 || RESERVED.has(name)) {
      throw invalidType(`name '${name}' is not valid`);
    }
    if (this.objectTypes.has(name))
      throw invalidType(`type '${name}' already registered`);
    const type = this.#parseTypeString(name, false);
    if (type.kind !== "message")
      throw invalidType(`type '${name}' is not valid`);
    const decl = {
      name,
      typeType: new Type(name),
      type,
      ctor: typeof _d === "function" ? _d : _d?.ctor,
      convert: typeof _d === "function" ? undefined : _d?.convert,
      fields: typeof _d?.schema === "object" ? this.#normalizeFields(name, this.#registerSchemaAsType(name, _d.schema)) : this.#normalizeFields(name, typeof _d === "function" ? undefined : _d?.fields)
    };
    if (typeof decl.ctor !== "function") {
      if (!decl.fields)
        throw invalidType(`type '${name}' requires a constructor or fields`);
      Object.assign(decl, this.#createDefaultConvert(name, decl.fields));
    }
    this.objectTypes.set(name, Object.freeze(decl));
    this.objectTypesByConstructor.set(decl.ctor, decl);
    this.registerFunctionOverload(`type(${name}): type`, () => decl.typeType, { async: false });
    return decl;
  }
  #parseTypeString(typeStr, requireKnownTypes = true) {
    let match = this.#typeDeclarations.get(typeStr);
    if (match)
      return match;
    if (typeof typeStr !== "string" || !typeStr.length) {
      throw new Error(`Invalid type: must be a string`);
    }
    match = typeStr.match(/^[A-Z]$/);
    if (match)
      return this.#createDeclaration(_createPlaceholderType, typeStr, typeStr);
    match = typeStr.match(/^(dyn|list|map|optional)<(.+)>$/);
    if (!match) {
      if (requireKnownTypes) {
        const err = new Error(`Unknown type: ${typeStr}`);
        err.unknownType = typeStr;
        throw err;
      }
      return this.#createDeclaration(_createMessageType, typeStr, typeStr);
    }
    const kind = match[1];
    const inner = match[2].trim();
    switch (kind) {
      case "dyn": {
        const type = this.#parseTypeString(inner, requireKnownTypes).wrappedType;
        this.#typeDeclarations.set(type.name, type);
        return type;
      }
      case "list": {
        const vType = this.#parseTypeString(inner, requireKnownTypes);
        return this.#createDeclaration(_createListType, `list<${vType}>`, vType);
      }
      case "map": {
        const parts = splitByComma(inner);
        if (parts.length !== 2)
          throw new Error(`Invalid map type: ${typeStr}`);
        const kType = this.#parseTypeString(parts[0], requireKnownTypes);
        const vType = this.#parseTypeString(parts[1], requireKnownTypes);
        return this.#createDeclaration(_createMapType, `map<${kType}, ${vType}>`, kType, vType);
      }
      case "optional": {
        const vType = this.#parseTypeString(inner, requireKnownTypes);
        return this.#createDeclaration(_createOptionalType, `optional<${vType}>`, vType);
      }
    }
  }
  #createDeclaration(creator, key, ...args) {
    return this.#typeDeclarations.get(key) || this.#typeDeclarations.set(key, creator(...args)).get(key);
  }
  findMacro(name, hasReceiver, argLen) {
    return this.functionCandidates(hasReceiver, name, argLen).macro;
  }
  findUnaryOverload(op, left) {
    return this.operatorCandidates(op).findUnaryOverload(left);
  }
  findBinaryOverload(op, left, right) {
    return this.operatorCandidates(op).findBinaryOverload(left, right);
  }
  #toCelFieldType(field) {
    if (typeof field === "string")
      return { type: field };
    if (field.id)
      return protobufjsFieldToCelType(field);
    return field;
  }
  #toCelFieldDeclaration(typename, fields, k, requireKnownTypes = false) {
    try {
      const field = this.#toCelFieldType(fields[k]);
      if (typeof field?.type !== "string")
        throw new Error(`unsupported declaration`);
      return this.#parseTypeString(field.type, requireKnownTypes);
    } catch (e) {
      e.message = `Field '${k}' in type '${typename}' has unsupported declaration: ` + `${JSON.stringify(fields[k])}`;
      throw e;
    }
  }
  #normalizeFields(typename, fields) {
    if (!fields)
      return;
    const all = Object.create(null);
    for (const k of objKeys(fields))
      all[k] = this.#toCelFieldDeclaration(typename, fields, k);
    return all;
  }
  #createDefaultConvert(name, fields) {
    const keys = objKeys(fields);
    const conversions = Object.create(null);
    for (const k of keys) {
      const type = fields[k];
      const decl = type.kind === "message" && this.objectTypes.get(type.name);
      if (decl === false)
        conversions[k] = false;
      else
        conversions[k] = decl.convert ? decl : false;
    }
    const Ctor = {
      [name]: class extends Map {
        #raw;
        constructor(v) {
          super();
          this.#raw = v;
        }
        [Symbol.iterator]() {
          if (this.size !== keys.length)
            for (const k of keys)
              this.get(k);
          return super[Symbol.iterator]();
        }
        get(field) {
          let v = super.get(field);
          if (v !== undefined || this.has(field))
            return v;
          const dec = conversions[field];
          if (dec === undefined)
            return;
          v = this.#raw instanceof Map ? this.#raw.get(field) : this.#raw?.[field];
          if (dec && v && typeof v === "object") {
            switch (v.constructor) {
              case undefined:
              case Object:
              case Map:
                v = dec.convert(v);
            }
          }
          return super.set(field, v), v;
        }
      }
    }[name];
    return {
      ctor: Ctor,
      convert(v) {
        if (!v)
          return;
        if (v.constructor === Ctor)
          return v;
        return new Ctor(v);
      }
    };
  }
  clone(opts) {
    this.#locked = true;
    return new Registry({
      parent: this,
      unlistedVariablesAreDyn: opts.unlistedVariablesAreDyn,
      enableOptionalTypes: opts.enableOptionalTypes
    });
  }
  getDefinitions() {
    const variables = [];
    const functions = [];
    for (const [, varDecl] of this.variables) {
      if (!varDecl)
        continue;
      variables.push({
        name: varDecl.name,
        description: varDecl.description || null,
        type: varDecl.type.name
      });
    }
    for (const decl of this.#getFunctions()) {
      functions.push({
        signature: decl.signature,
        name: decl.name,
        description: decl.description,
        receiverType: decl.receiverType ? decl.receiverType.name : null,
        returnType: decl.returnType.name,
        params: decl.params.map((p) => ({
          name: p.name,
          type: p.type.name,
          description: p.description
        }))
      });
    }
    return { variables, functions };
  }
  #parseSignature(signature) {
    if (typeof signature !== "string")
      throw new Error("Invalid signature: must be a string");
    const match = signature.match(/^(?:([a-zA-Z0-9.<>]+)\.)?(\w+)\(([^)]*)\):(.*)$/);
    if (!match)
      throw new Error(`Invalid signature: ${signature}`);
    const returnType = match[4].trim();
    if (!returnType)
      throw new Error(`Invalid signature: ${signature}`);
    return {
      receiverType: match[1] || null,
      name: match[2],
      argTypes: splitByComma(match[3]),
      returnType
    };
  }
  #functionSignatureOverlaps(a, b) {
    if (a.name !== b.name)
      return false;
    if (a.argTypes.length !== b.argTypes.length)
      return false;
    if ((a.receiverType || b.receiverType) && (!a.receiverType || !b.receiverType))
      return false;
    const isDifferentReceiver = a.receiverType !== b.receiverType && a.receiverType !== dynType && b.receiverType !== dynType;
    return !isDifferentReceiver && (b.macro || a.macro || b.argTypes.every((t, i) => {
      const o = a.argTypes[i];
      return t === o || t === dynType || o === dynType;
    }));
  }
  #checkOverlappingSignatures(newDec) {
    for (const decl of this.#functionCandidates(newDec.partitionKey)) {
      if (!this.#functionSignatureOverlaps(decl, newDec))
        continue;
      throw new Error(`Function signature '${newDec.signature}' overlaps with existing overload '${decl.signature}'.`);
    }
  }
  #normalizeParam(i, aType, param) {
    if (!param)
      return { type: this.getFunctionType(aType), name: `arg${i}`, description: null };
    const type = param.type || aType;
    if (!type)
      throw new Error(`params[${i}].type is required`);
    if (aType && type !== aType)
      throw new Error(`params[${i}].type not equal to signature type`);
    return {
      name: param.name || `arg${i}`,
      type: this.getFunctionType(type),
      description: param.description ?? null
    };
  }
  registerFunctionOverload(s, handler, opts) {
    if (this.#locked)
      throw new Error("Cannot modify frozen registry");
    if (typeof s === "object")
      opts = s;
    else if (typeof handler === "object")
      opts = handler;
    else if (!opts)
      opts = {};
    const sig = typeof s === "string" ? s : opts.signature ?? undefined;
    const parsed = sig !== undefined ? this.#parseSignature(sig) : undefined;
    const name = parsed?.name || opts.name;
    const receiverType = parsed?.receiverType || opts.receiverType;
    const argTypes = parsed?.argTypes;
    const returnType = parsed?.returnType || opts.returnType;
    const params = opts.params;
    handler = typeof handler === "function" ? handler : opts.handler;
    let dec;
    try {
      if (!name)
        throw new Error(`signature or name are required`);
      if (!returnType)
        throw new Error(`must have a returnType`);
      if (params) {
        if (argTypes && params.length !== argTypes.length) {
          throw new Error(`mismatched length in params and args in signature`);
        }
      } else if (!argTypes)
        throw new Error(`signature or params are required`);
      dec = new FunctionDeclaration({
        name,
        async: opts?.async,
        receiverType: receiverType ? this.getType(receiverType) : null,
        returnType: this.getType(returnType),
        handler,
        description: opts.description,
        params: (argTypes || params).map((_, i) => this.#normalizeParam(i, argTypes?.[i], params?.[i]))
      });
    } catch (e) {
      if (typeof sig === "string")
        e.message = `Invalid function declaration '${sig}': ${e.message}`;
      else if (name)
        e.message = `Invalid function declaration '${name}': ${e.message}`;
      else
        e.message = `Invalid function declaration: ${e.message}`;
      throw e;
    }
    this.#checkOverlappingSignatures(dec);
    this.#pushFunction(dec);
  }
  registerOperatorOverload(string, handler, opts) {
    const unaryParts = string.match(/^([-!])([\w.<>]+)(?::\s*([\w.<>]+))?$/);
    if (unaryParts) {
      const [, op2, operandType, returnType2] = unaryParts;
      return this.unaryOverload(op2, operandType, handler, returnType2, opts?.async);
    }
    const parts = string.match(/^([\w.<>]+) ([-+*%/]|==|!=|<|<=|>|>=|in) ([\w.<>]+)(?::\s*([\w.<>]+))?$/);
    if (!parts)
      throw new Error(`Operator overload invalid: ${string}`);
    const [, leftType, op, rightType, returnType] = parts;
    return this.binaryOverload(leftType, op, rightType, handler, returnType);
  }
  unaryOverload(op, typeStr, handler, returnTypeStr, async) {
    if (this.#locked)
      throw new Error("Cannot modify frozen registry");
    const leftType = this.assertType(typeStr, "type", `${op}${typeStr}`);
    const returnType = this.assertType(returnTypeStr || typeStr, "return type", `${op}${typeStr}: ${returnTypeStr || typeStr}`);
    const d = new OperatorDeclaration({ op: `${op}_`, leftType, returnType, handler, async });
    this.#pushOperator(this.#assertOverload(d));
  }
  #hasOverload(d) {
    for (const o of this.operatorCandidates(d.operator))
      if (d.equals(o))
        return true;
    return false;
  }
  #assertOverload(decl) {
    if (!this.#hasOverload(decl))
      return decl;
    throw new Error(`Operator overload already registered: ${decl.signature}`);
  }
  binaryOverload(leftTypeStr, op, rightTypeStr, handler, returnTypeStr, async) {
    if (this.#locked)
      throw new Error("Cannot modify frozen registry");
    returnTypeStr ??= isRelational.has(op) ? "bool" : leftTypeStr;
    const sig = `${leftTypeStr} ${op} ${rightTypeStr}: ${returnTypeStr}`;
    let leftType = this.assertType(leftTypeStr, "left type", sig);
    let rightType = this.assertType(rightTypeStr, "right type", sig);
    const returnType = this.assertType(returnTypeStr, "return type", sig);
    if (leftType.kind === "dyn" && leftType.valueType)
      rightType = rightType.wrappedType;
    else if (rightType.kind === "dyn" && rightType.valueType)
      leftType = leftType.wrappedType;
    if (isRelational.has(op) && returnType.type !== "bool") {
      throw new Error(`Comparison operator '${op}' must return 'bool', got '${returnType.type}'`);
    }
    const dec = new OperatorDeclaration({ op, leftType, rightType, returnType, handler, async });
    if (dec.hasPlaceholderType && !(rightType.hasPlaceholderType && leftType.hasPlaceholderType)) {
      throw new Error(`Operator overload with placeholders must use them in both left and right types: ${sig}`);
    }
    this.#assertOverload(dec);
    if (op === "==") {
      const declarations = [
        new OperatorDeclaration({
          op: "!=",
          leftType,
          rightType,
          handler(a, b, ast, ev) {
            return !handler(a, b, ast, ev);
          },
          returnType,
          async
        })
      ];
      if (leftType !== rightType) {
        declarations.push(new OperatorDeclaration({
          op: "==",
          leftType: rightType,
          rightType: leftType,
          handler(a, b, ast, ev) {
            return handler(b, a, ast, ev);
          },
          returnType,
          async
        }), new OperatorDeclaration({
          op: "!=",
          leftType: rightType,
          rightType: leftType,
          handler(a, b, ast, ev) {
            return !handler(b, a, ast, ev);
          },
          returnType,
          async
        }));
      }
      for (const decl of declarations)
        this.#assertOverload(decl);
      for (const decl of declarations)
        this.#pushOperator(decl);
    }
    this.#pushOperator(dec);
  }
}
var isRelational = new Set(["<", "<=", ">", ">=", "==", "!=", "in"]);
function createRegistry(opts) {
  return new Registry(opts);
}

class RootContext {
  #vars;
  #contextObj;
  #contextMap;
  #convertCache;
  constructor(registry, context) {
    this.#vars = registry.variables;
    if (context === undefined || context === null)
      return;
    if (typeof context !== "object") {
      throw evaluationError("invalid_context", "Context must be an object");
    }
    if (context instanceof Map)
      this.#contextMap = context;
    else
      this.#contextObj = context;
  }
  getValue(key) {
    return this.#convertCache?.get(key) || (this.#contextObj ? this.#contextObj[key] : this.#contextMap?.get(key));
  }
  getVariable(name) {
    return this.#vars.get(name) ?? (this.#vars.dyn && !RESERVED.has(name) ? new VariableDeclaration(name, dynType) : undefined);
  }
  getCheckedValue(ev, ast) {
    const v = this.getValue(ast.args);
    if (v === undefined)
      throw ev.createError("unknown_variable", `Unknown variable: ${ast.args}`, ast);
    if (ast.checkedType.matchesValueType(v, ev))
      return v;
    const type = ast.checkedType;
    const valueType = ev.debugType(v);
    if (type.kind === "message" && valueType.kind === "map") {
      const c = ev.objectTypes.get(type.name)?.convert?.(v);
      if (c)
        return (this.#convertCache ??= new Map).set(ast.args, c), c;
    }
    throw ev.createError("variable_type_mismatch", `Variable '${ast.args}' is not of type '${type}', got '${valueType}'`, ast);
  }
  forkWithVariable(iterVar, iterType) {
    return new OverlayContext(this, iterVar, iterType);
  }
}

class OverlayContext {
  #parent;
  accuType;
  accuValue;
  iterValue;
  constructor(parent, iterVar, iterType) {
    this.#parent = parent;
    this.iterVar = iterVar;
    this.iterType = iterType;
  }
  forkWithVariable(iterVar, iterType) {
    return new OverlayContext(this, iterVar, iterType);
  }
  reuse(parent) {
    if (!this.async)
      return this.#parent = parent, this;
    const ctx = new OverlayContext(parent, this.iterVar, this.iterType);
    ctx.accuType = this.accuType;
    return ctx;
  }
  setIterValue(v, ev) {
    if (this.iterType.matchesValueType(v, ev))
      return this.iterValue = v, this;
    const type = this.iterType;
    const valueType = ev.debugType(v);
    if (type.kind === "message" && valueType.kind === "map") {
      const c = ev.objectTypes.get(type.name)?.convert?.(v);
      if (c)
        return this.iterValue = c, this;
    }
    throw ev.createError("variable_type_mismatch", `Variable '${this.iterVar}' is not of type '${type}', got '${valueType}'`);
  }
  setAccuType(type) {
    return this.accuType = type, this;
  }
  setAccuValue(v) {
    return this.accuValue = v, this;
  }
  getValue(key) {
    return this.iterVar === key ? this.iterValue : this.#parent.getValue(key);
  }
  getCheckedValue(ev, ast) {
    if (this.iterVar === ast.args)
      return this.iterValue;
    return this.#parent.getCheckedValue(ev, ast);
  }
  getVariable(name) {
    if (this.iterVar === name)
      return new VariableDeclaration(name, this.iterType);
    return this.#parent.getVariable(name);
  }
}
function protobufjsFieldToCelType(field) {
  let fieldType;
  if (field.map) {
    const keyType = protobufjsTypeToCelType(field.keyType, field.resolvedKeyType);
    const valueType = protobufjsTypeToCelType(field.type, field.resolvedType);
    fieldType = `map<${keyType}, ${valueType}>`;
  } else {
    fieldType = protobufjsTypeToCelType(field.type, field.resolvedType);
  }
  return { type: field.repeated ? `list<${fieldType}>` : fieldType };
}
function protobufjsTypeToCelType(protoType, resolvedType) {
  switch (protoType) {
    case "string":
      return "string";
    case "bytes":
      return "bytes";
    case "bool":
      return "bool";
    case "double":
    case "float":
    case "int32":
    case "int64":
    case "sint32":
    case "sint64":
    case "sfixed32":
    case "sfixed64":
    case "uint32":
    case "uint64":
    case "fixed32":
    case "fixed64":
      return "double";
    default:
      switch (resolvedType?.constructor.name) {
        case "Type":
          return resolvedType.fullName.slice(1);
        case "Enum":
          return "int";
      }
      if (protoType?.includes("."))
        return protoType;
      return "dyn";
  }
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/operators.js
var dynType2 = celTypes.dyn;

class Base {
  dynType = celTypes.dyn;
  optionalType = celTypes.optional;
  stringType = celTypes.string;
  intType = celTypes.int;
  doubleType = celTypes.double;
  boolType = celTypes.bool;
  nullType = celTypes.null;
  listType = celTypes.list;
  mapType = celTypes.map;
  constructor(opts) {
    this.opts = opts.opts;
    this.registry = opts.registry;
    this.objectTypes = this.registry.objectTypes;
    this.objectTypesByConstructor = this.registry.objectTypesByConstructor;
  }
  getType(typeName) {
    return this.registry.getType(typeName);
  }
  debugType(v) {
    switch (typeof v) {
      case "string":
        return this.stringType;
      case "bigint":
        return this.intType;
      case "number":
        return this.doubleType;
      case "boolean":
        return this.boolType;
      case "object":
        if (v === null)
          return this.nullType;
        switch (v.constructor) {
          case undefined:
          case Object:
          case Map:
            return this.mapType;
          case Array:
          case Set:
            return this.listType;
          default:
            return this.objectTypesByConstructor.get(v.constructor)?.type || unsupportedType(this, v.constructor?.name || typeof v);
        }
      default:
        unsupportedType(this, typeof v);
    }
  }
}
function unsupportedType(self, type) {
  throw self.createError("unsupported_type", `Unsupported type: ${type}`);
}
var maybeAsyncArray = (a) => Array.isArray(a) ? a.some((n) => n.maybeAsync) : false;
function maybeAsync(l, r, h) {
  if (r === true || r && (r?.maybeAsync || maybeAsyncArray(r)))
    return maybeAsyncBoth(h);
  if (l === true || l && (l?.maybeAsync || maybeAsyncArray(l)))
    return maybeAsyncFirst(h);
  return h;
}
function maybeAsyncBoth(handler) {
  return handler.__asyncBoth ??= function handle(a, b, c, d) {
    if (!(a instanceof Promise || b instanceof Promise))
      return handler(a, b, c, d);
    if (!(b instanceof Promise))
      return a.then((_a) => handler(_a, b, c, d));
    if (!(a instanceof Promise))
      return b.then((_b) => handler(a, _b, c, d));
    return Promise.all([a, b]).then((p) => handler(p[0], p[1], c, d));
  };
}
function maybeAsyncFirst(handler) {
  return handler.__asyncFirst ??= function handle(a, b, c, d) {
    if (a instanceof Promise)
      return a.then((_a) => handler(_a, b, c, d));
    return handler(a, b, c, d);
  };
}
function checkAccessNode(chk, ast, ctx) {
  ast.right = ast.args[1];
  const leftType = chk.check(ast.left = ast.args[0], ctx);
  if (ast.op === "[]")
    chk.check(ast.right, ctx);
  ast.handle = maybeAsync(ast.left, ast.op === "[]" ? ast.right : false, leftType !== dynType2 ? fieldAccessStatic : fieldAccess);
  if (leftType.kind !== "optional")
    return chk.checkAccessOnType(ast, ctx, leftType);
  return chk.registry.getOptionalType(chk.checkAccessOnType(ast, ctx, leftType.valueType, true));
}
function checkOptionalAccessNode(chk, ast, ctx) {
  ast.right = ast.args[1];
  const leftType = chk.check(ast.left = ast.args[0], ctx);
  if (ast.op === "[?]")
    chk.check(ast.right, ctx);
  ast.handle = maybeAsync(ast.left, ast.op === "[?]" ? ast.right : false, oFieldAccess);
  const actualType = leftType.kind === "optional" ? leftType.valueType : leftType;
  return chk.registry.getOptionalType(chk.checkAccessOnType(ast, ctx, actualType, true));
}
var HOMOGENEOUS_PREFIX = {
  heterogeneous_list_element: "List elements must have the same type,",
  heterogeneous_map_key: "Map key uses wrong type,",
  heterogeneous_map_value: "Map value uses wrong type,"
};
function checkElementHomogenous(chk, ctx, expected, el, code) {
  const type = chk.check(el, ctx);
  if (type === expected || expected.isEmpty())
    return type;
  if (type.isEmpty())
    return expected;
  throw chk.createError(code, `${HOMOGENEOUS_PREFIX[code]} expected type '${chk.formatType(expected)}' but found '${chk.formatType(type)}'`, el);
}
function checkElement(chk, ctx, expected, el) {
  return expected.unify(chk.registry, chk.check(el, ctx)) || dynType2;
}
function ternaryConditionError(ev, value, node) {
  const type = ev.debugRuntimeType(value);
  return ev.createError("invalid_condition_type", `${node.meta.label || "Ternary condition must be bool"}, got '${type}'`, node);
}
function handleTernary(c, ev, ast, ctx) {
  if (c === true)
    return ev.run(ast.left, ctx);
  if (c === false)
    return ev.run(ast.right, ctx);
  throw ternaryConditionError(ev, c, ast.condition);
}
function logicalOperandError(ev, value, node) {
  const type = ev.debugRuntimeType(value);
  return ev.createError("invalid_logical_operand", `Logical operator requires bool operands, got '${type}'`, node);
}
function logicalValueOrErr(ev, v, node) {
  if (v instanceof Error)
    return v;
  return logicalOperandError(ev, v, node);
}
function _logicalOp(exp, ev, ast, left, right) {
  if (right === exp)
    return exp;
  if (right === !exp) {
    if (left === right)
      return right;
    throw logicalValueOrErr(ev, left, ast.left);
  }
  if (right instanceof Promise)
    return right.then((r) => _logicalOpAsync(exp, ev, ast, left, r));
  throw logicalOperandError(ev, right, ast.left);
}
function _logicalOpAsync(exp, ev, ast, left, right) {
  if (right === exp)
    return exp;
  if (typeof right !== "boolean")
    throw logicalOperandError(ev, right, ast.right);
  if (typeof left !== "boolean")
    throw logicalValueOrErr(ev, left, ast.left);
  return !exp;
}
function checkLogicalOp(chk, ast, ctx) {
  const leftType = chk.check(ast.left = ast.args[0], ctx);
  const rightType = chk.check(ast.right = ast.args[1], ctx);
  if (!leftType.isDynOrBool()) {
    throw chk.createError("invalid_logical_operand", `Logical operator requires bool operands, got '${chk.formatType(leftType)}'`, ast);
  }
  if (!rightType.isDynOrBool()) {
    throw chk.createError("invalid_logical_operand", `Logical operator requires bool operands, got '${chk.formatType(rightType)}'`, ast);
  }
  return chk.boolType;
}
function checkUnary(chk, ast, ctx) {
  const op = ast.op;
  const right = chk.check(ast.args, ctx);
  ast.candidates = chk.registry.operatorCandidates(op);
  if (right.kind === "dyn") {
    ast.handle = maybeAsync(ast.args, false, handleUnary);
    return ast.candidates.returnType;
  }
  const overload = ast.candidates.findUnaryOverload(right);
  if (!overload) {
    throw chk.createError("no_such_overload", `no such overload: ${op[0]}${chk.formatType(right)}`, ast);
  }
  ast.handle = maybeAsync(ast.args, false, overload.handler);
  return overload.returnType;
}
function handleUnary(left, ast, ev) {
  const leftType = ev.debugRuntimeType(left, ast.args.checkedType);
  const overload = ast.candidates.findUnaryOverload(leftType);
  if (overload)
    return overload.handler(left);
  throw ev.createError("no_such_overload", `no such overload: ${ast.op[0]}${leftType}`, ast);
}
function evaluateUnary(ev, ast, ctx) {
  return ast.handle(ev.run(ast.args, ctx), ast, ev);
}
function checkBinary(chk, ast, ctx) {
  const op = ast.op;
  const left = chk.check(ast.left = ast.args[0], ctx);
  const right = chk.check(ast.right = ast.args[1], ctx);
  ast.candidates = chk.registry.operatorCandidates(op);
  const overload = left.hasDynType || right.hasDynType ? undefined : ast.candidates.findBinaryOverload(left, right);
  ast.handle = maybeAsync(ast.left, ast.right, overload?.handler || handleBinary);
  if (overload)
    return overload.returnType;
  const type = ast.candidates.checkBinaryOverload(left, right);
  if (!left.hasDynType)
    ast.leftStaticType = left;
  if (!right.hasDynType)
    ast.rightStaticType = right;
  if (type)
    return type;
  throw chk.createError("no_such_overload", `no such overload: ${chk.formatType(left)} ${op} ${chk.formatType(right)}`, ast);
}
function evaluateBinary(ev, ast, ctx) {
  return ast.handle(ev.run(ast.left, ctx), ev.run(ast.right, ctx), ast, ev);
}
function evaluateBinaryFirst(ev, ast, ctx) {
  return ast.handle(ev.run(ast.left, ctx), ast.right, ast, ev);
}
function handleBinary(left, right, ast, ev) {
  const leftType = ast.leftStaticType || ev.debugTypeDeep(left).wrappedType;
  const rightType = ast.rightStaticType || ev.debugTypeDeep(right).wrappedType;
  const overload = ast.candidates.findBinaryOverload(leftType, rightType);
  if (overload)
    return overload.handler(left, right, ast, ev);
  throw ev.createError("no_such_overload", `no such overload: ${leftType} ${ast.op} ${rightType}`, ast);
}
function callFunctionHandler(handler, ev, args, ast) {
  try {
    const result = handler.apply(ev, args);
    if (result instanceof Promise) {
      return result.catch((error) => {
        throw attachErrorAst(error, ast);
      });
    }
    return result;
  } catch (error) {
    throw attachErrorAst(error, ast);
  }
}
function callFn(args, ast, ev) {
  const argAst = ast.args[1];
  const types = ast.argTypes;
  let i = argAst.length;
  while (i--)
    types[i] = ev.debugRuntimeType(args[i], argAst[i].checkedType);
  const decl = ast.candidates.findFunction(types);
  if (decl)
    return callFunctionHandler(decl.handler, ev, args, ast);
  throw ev.createError("no_matching_overload", `found no matching overload for '${ast.args[0]}(${types.map((t) => t.unwrappedType).join(", ")})'`, ast);
}
function callRecFn(args, ev, ast) {
  const [, receiverAst, argAst] = ast.args;
  const types = ast.argTypes;
  for (let i = 0;i < types.length; i++)
    types[i] = ev.debugRuntimeType(args[i + 1], argAst[i].checkedType);
  const receiverType = ev.debugRuntimeType(args[0], receiverAst.checkedType);
  const decl = ast.candidates.findFunction(types, receiverType);
  if (decl)
    return callFunctionHandler(decl.handler, ev, args, ast);
  throw ev.createError("no_matching_overload", `found no matching overload for '${receiverType.type}.${ast.args[0]}(${types.map((t) => t.unwrappedType).join(", ")})'`, ast);
}
function resolveAstArray(ev, astArray, ctx, i = astArray.length) {
  if (i === 0)
    return [];
  let async;
  const results = new Array(i);
  while (i--)
    if ((results[i] = ev.run(astArray[i], ctx)) instanceof Promise)
      async ??= true;
  return async ? Promise.all(results) : results;
}
function safeFromEntries(entries) {
  const obj = {};
  for (let i = 0;i < entries.length; i++) {
    const [k, v] = entries[i];
    if (k === "__proto__" || k === "constructor" || k === "prototype")
      continue;
    obj[k] = v;
  }
  return obj;
}
function comprehensionElementType(chk, iterable, ctx) {
  const iterType = chk.check(iterable, ctx);
  if (iterType.kind === "dyn")
    return iterType;
  if (iterType.kind === "list")
    return iterType.valueType;
  if (iterType.kind === "map")
    return iterType.keyType;
  throw chk.createError("invalid_comprehension_range", `Expression of type '${chk.formatType(iterType)}' cannot be range of a comprehension (must be list, map, or dynamic).`, iterable);
}
function toIterable(ev, args, coll) {
  if (coll instanceof Set)
    return [...coll];
  if (coll instanceof Map)
    return [...coll.keys()];
  if (coll && typeof coll === "object")
    return objKeys(coll);
  throw ev.createError("invalid_comprehension_range", `Expression of type '${ev.debugType(coll)}' cannot be range of a comprehension (must be list, map, or dynamic).`, args.iterable);
}
function runQualifier(items, args, ev, ctx) {
  if (!isArray(items))
    items = toIterable(ev, args, items);
  const accu = ev.run(args.init, ctx = args.iterCtx.reuse(ctx));
  ctx.accuValue = accu;
  if (ctx === args.iterCtx)
    return iterateQuantifier(ev, ctx, args, items, accu, 0);
  return continueQuantifier(ev, ctx, args, items, accu, 0);
}
function runComprehension(items, args, ev, ctx) {
  if (!isArray(items))
    items = toIterable(ev, args, items);
  const accu = ev.run(args.init, ctx = args.iterCtx.reuse(ctx));
  ctx.accuValue = accu;
  if (ctx === args.iterCtx)
    return iterateLoop(ev, ctx, args, items, accu, 0);
  return continueLoop(ev, ctx, args, items, accu, 0);
}
function iterateLoop(ev, ctx, args, items, accu, i) {
  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  while (i < len) {
    if (condition && !condition(accu))
      break;
    accu = ev.run(step, ctx.setIterValue(items[i++], ev));
    if (accu instanceof Promise)
      return continueLoop(ev, ctx, args, items, accu, i);
  }
  return args.result(accu);
}
async function continueLoop(ev, ctx, args, items, accu, i) {
  if (ctx === args.iterCtx)
    ctx.async = true;
  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  accu = await accu;
  while (i < len) {
    if (condition && !condition(accu))
      return args.result(accu);
    accu = ev.run(step, ctx.setIterValue(items[i++], ev));
    if (accu instanceof Promise)
      accu = await accu;
  }
  return args.result(accu);
}
function iterateQuantifier(ev, ctx, args, items, accu, i, error, stp) {
  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  while (i < len) {
    if (!condition(accu))
      return args.result(accu);
    stp = ev.tryEval(step, ctx.setIterValue(items[i++], ev));
    if (stp instanceof Promise)
      return continueQuantifier(ev, ctx, args, items, accu, i, error, stp);
    if (stp instanceof Error && (error ??= stp))
      continue;
    accu = stp;
  }
  if (error && condition(accu))
    throw error;
  return args.result(accu);
}
async function continueQuantifier(ev, ctx, args, items, accu, i, error, stp) {
  if (ctx === args.iterCtx)
    ctx.async = true;
  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  stp = await stp;
  if (stp instanceof Error)
    error ??= stp;
  else
    accu = stp;
  while (i < len) {
    if (!condition(accu))
      return args.result(accu);
    stp = ev.tryEval(step, ctx.setIterValue(items[i++], ev));
    if (stp instanceof Promise)
      stp = await stp;
    if (stp instanceof Error && (error ??= stp))
      continue;
    accu = stp;
  }
  if (error && condition(accu))
    throw error;
  return args.result(accu);
}
function oFieldAccess(left, right, ast, ev) {
  return ev.optionalType.field(left, right, ast, ev);
}
function fieldAccessStatic(left, right, ast, ev) {
  return ast.left.checkedType.field(left, right, ast, ev);
}
var empty = Object.create(null);
function fieldAccess(left, right, ast, ev) {
  switch (left?.constructor) {
    case undefined:
    case Object: {
      const v = hasOwn(left || empty, right) ? left[right] : undefined;
      if (v !== undefined)
        return ev.debugType(v), v;
      break;
    }
    case Map: {
      const v = left.get(right);
      if (v !== undefined)
        return ev.debugType(v), v;
      break;
    }
    case Array:
    case Set:
      return ev.listType.field(left, right, ast, ev);
    default:
      const t = ev.objectTypesByConstructor.get(left.constructor);
      if (t)
        return t.type.field(left, right, ast, ev);
      else if (typeof left === "object")
        unsupportedType(ev, left.constructor.name);
  }
  throw ev.createError("no_such_key", `No such key: ${right}`, ast);
}
var emptyList = () => [];
var emptyMap = () => ({});
var OPERATORS = {
  value: {
    check(chk, ast) {
      return chk.debugType(ast.args);
    },
    evaluate(_ev, ast) {
      return ast.args;
    }
  },
  id: {
    check(chk, ast, ctx) {
      const variable = ctx.getVariable(ast.args);
      if (!variable)
        throw chk.createError("unknown_variable", `Unknown variable: ${ast.args}`, ast);
      if (variable.constant) {
        const alternate = ast.clone(OPERATORS.value, variable.value);
        ast.setMeta("alternate", alternate);
        return chk.check(alternate, ctx);
      }
      return variable.type;
    },
    evaluate(ev, ast, ctx) {
      return ctx.getCheckedValue(ev, ast);
    }
  },
  ".": {
    alias: "fieldAccess",
    check: checkAccessNode,
    evaluate: evaluateBinaryFirst
  },
  ".?": {
    alias: "optionalFieldAccess",
    check: checkOptionalAccessNode,
    evaluate: evaluateBinaryFirst
  },
  "[]": {
    alias: "bracketAccess",
    check: checkAccessNode,
    evaluate: evaluateBinary
  },
  "[?]": {
    alias: "optionalBracketAccess",
    check: checkOptionalAccessNode,
    evaluate: evaluateBinary
  },
  call: {
    check(chk, ast, ctx) {
      const [functionName, args] = ast.args;
      const candidates = ast.candidates = chk.registry.functionCandidates(false, functionName, args.length);
      const argTypes = ast.argTypes = args.map((a) => chk.check(a, ctx));
      const decl = candidates.findFunction(argTypes);
      if (!decl) {
        throw chk.createError("no_matching_overload", `found no matching overload for '${functionName}(${chk.formatTypeList(argTypes)})'`, ast);
      }
      const handle = argTypes.some((t) => t.hasDynType) ? callFn : decl.handler.__handle ??= (l, _ast, e) => callFunctionHandler(decl.handler, e, l, _ast);
      ast.handle = maybeAsync(args, false, handle);
      return decl.returnType;
    },
    evaluate(ev, ast, ctx) {
      return ast.handle(resolveAstArray(ev, ast.args[1], ctx), ast, ev);
    }
  },
  rcall: {
    check(chk, ast, ctx) {
      const [methodName, receiver, args] = ast.args;
      const receiverType = chk.check(receiver, ctx);
      const candidates = ast.candidates = chk.registry.functionCandidates(true, methodName, args.length);
      const argTypes = ast.argTypes = args.map((a) => chk.check(a, ctx));
      ast.receiverWithArgs = [receiver, ...args];
      ast.handle = maybeAsync(ast.receiverWithArgs, false, callRecFn);
      if (receiverType.kind === "dyn" && candidates.returnType)
        return candidates.returnType;
      const decl = candidates.findFunction(argTypes, receiverType);
      if (!decl) {
        throw chk.createError("no_matching_overload", `found no matching overload for '${receiverType.type}.${methodName}(${chk.formatTypeList(argTypes)})'`, ast);
      }
      if (!receiverType.hasPlaceholderType && !argTypes.some((t) => t.hasDynType)) {
        const fn = decl.handler;
        const handle = fn.__handle ??= (a, ev, _ast) => callFunctionHandler(fn, ev, a, _ast);
        ast.handle = maybeAsync(ast.receiverWithArgs, false, handle);
      }
      return decl.returnType;
    },
    evaluate(ev, ast, ctx) {
      return ast.handle(resolveAstArray(ev, ast.receiverWithArgs, ctx), ev, ast);
    }
  },
  list: {
    check(chk, ast, ctx) {
      const arr = ast.args;
      const arrLen = arr.length;
      if (arrLen === 0)
        return ast.setMeta("evaluate", emptyList) && chk.getType("list<T>");
      let valueType = chk.check(arr[0], ctx);
      const check = chk.opts.homogeneousAggregateLiterals ? checkElementHomogenous : checkElement;
      for (let i = 1;i < arrLen; i++)
        valueType = check(chk, ctx, valueType, arr[i], "heterogeneous_list_element");
      return chk.registry.getListType(valueType);
    },
    evaluate(ev, ast, ctx) {
      return resolveAstArray(ev, ast.args, ctx);
    }
  },
  map: {
    check(chk, ast, ctx) {
      const arr = ast.args;
      const arrLen = arr.length;
      if (arrLen === 0)
        return ast.setMeta("evaluate", emptyMap) && chk.getType("map<K, V>");
      const check = chk.opts.homogeneousAggregateLiterals ? checkElementHomogenous : checkElement;
      let keyType = chk.check(arr[0][0], ctx);
      let valueType = chk.check(arr[0][1], ctx);
      for (let i = 1;i < arrLen; i++) {
        const e = arr[i];
        keyType = check(chk, ctx, keyType, e[0], "heterogeneous_map_key");
        valueType = check(chk, ctx, valueType, e[1], "heterogeneous_map_value");
      }
      return chk.registry.getMapType(keyType, valueType);
    },
    evaluate(ev, ast, ctx) {
      const astEntries = ast.args;
      const len = astEntries.length;
      const results = new Array(len);
      let async;
      for (let i = 0;i < len; i++) {
        const e = astEntries[i];
        const k = ev.run(e[0], ctx);
        const v = ev.run(e[1], ctx);
        if (k instanceof Promise || v instanceof Promise) {
          results[i] = Promise.all([k, v]);
          async ??= true;
        } else {
          results[i] = [k, v];
        }
      }
      if (async)
        return Promise.all(results).then(safeFromEntries);
      return safeFromEntries(results);
    }
  },
  comprehension: {
    check(chk, ast, ctx) {
      const args = ast.args;
      args.iterCtx = ctx.forkWithVariable(args.iterVarName, comprehensionElementType(chk, args.iterable, ctx)).setAccuType(chk.check(args.init, ctx));
      const stepType = chk.check(args.step, args.iterCtx);
      const handler = args.errorsAreFatal ? runComprehension : runQualifier;
      ast.handle = maybeAsync(args.iterable, false, handler);
      if (args.kind === "quantifier")
        return chk.boolType;
      return stepType;
    },
    evaluate(ev, ast, ctx) {
      return ast.handle(ev.run(ast.args.iterable, ctx), ast.args, ev, ctx);
    }
  },
  accuValue: {
    check(_chk, _ast, ctx) {
      return ctx.accuType;
    },
    evaluate(_ev, _ast, ctx) {
      return ctx.accuValue;
    }
  },
  accuInc: {
    check(_chk, _ast, ctx) {
      return ctx.accuType;
    },
    evaluate(_ev, _ast, ctx) {
      return ctx.accuValue += 1;
    }
  },
  accuPush: {
    check(chk, ast, ctx) {
      const listType2 = ctx.accuType;
      const itemType = chk.check(ast.args, ctx);
      if (!ast.args.maybeAsync)
        ast.setMeta("evaluate", OPERATORS.accuPush.evaluateSync);
      if (listType2.kind === "list" && listType2.valueType.kind !== "param")
        return listType2;
      return chk.registry.getListType(itemType);
    },
    evaluateSync(ev, ast, ctx) {
      return ctx.accuValue.push(ev.run(ast.args, ctx)), ctx.accuValue;
    },
    evaluate(ev, ast, ctx) {
      const arr = ctx.accuValue;
      const el = ev.run(ast.args, ctx);
      if (el instanceof Promise)
        return el.then((_e) => arr.push(_e) && arr);
      arr.push(el);
      return arr;
    }
  },
  "?:": {
    alias: "ternary",
    check(chk, ast, ctx) {
      const condast = ast.condition = ast.args[0];
      const leftast = ast.left = ast.args[1];
      const rightast = ast.right = ast.args[2];
      const condType = chk.check(condast, ctx);
      if (!condType.isDynOrBool()) {
        throw chk.createError("invalid_condition_type", `${condast.meta.label || "Ternary condition must be bool"}, got '${chk.formatType(condType)}'`, condast);
      }
      const leftType = chk.check(leftast, ctx);
      const rightType = chk.check(rightast, ctx);
      const unified = leftType.unify(chk.registry, rightType);
      ast.handle = maybeAsync(condast, false, handleTernary);
      if (unified)
        return unified;
      throw chk.createError("incompatible_ternary_branches", `Ternary branches must have the same type, got '${chk.formatType(leftType)}' and '${chk.formatType(rightType)}'`, ast);
    },
    evaluate(ev, ast, ctx) {
      return ast.handle(ev.run(ast.condition, ctx), ev, ast, ctx);
    }
  },
  "||": {
    check: checkLogicalOp,
    evaluate(ev, ast, ctx) {
      const l = ev.tryEval(ast.left, ctx);
      if (l === true)
        return true;
      if (l === false) {
        const right = ev.run(ast.right, ctx);
        if (typeof right === "boolean")
          return right;
        return _logicalOp(true, ev, ast, l, right);
      }
      if (l instanceof Promise)
        return l.then((_l) => _l === true ? _l : _logicalOp(true, ev, ast, _l, ev.run(ast.right, ctx)));
      return _logicalOp(true, ev, ast, l, ev.run(ast.right, ctx));
    }
  },
  "&&": {
    check: checkLogicalOp,
    evaluate(ev, ast, ctx) {
      const l = ev.tryEval(ast.left, ctx);
      if (l === false)
        return false;
      if (l === true) {
        const right = ev.run(ast.right, ctx);
        if (typeof right === "boolean")
          return right;
        return _logicalOp(false, ev, ast, l, right);
      }
      if (l instanceof Promise)
        return l.then((_l) => _l === false ? _l : _logicalOp(false, ev, ast, _l, ev.run(ast.right, ctx)));
      return _logicalOp(false, ev, ast, l, ev.run(ast.right, ctx));
    }
  },
  "!_": { alias: "unaryNot", check: checkUnary, evaluate: evaluateUnary },
  "-_": { alias: "unaryMinus", check: checkUnary, evaluate: evaluateUnary }
};
var binaryOperators = ["!=", "==", "in", "+", "-", "*", "/", "%", "<", "<=", ">", ">="];
for (const op of binaryOperators)
  OPERATORS[op] = { check: checkBinary, evaluate: evaluateBinary };
for (const op of objKeys(OPERATORS)) {
  const obj = OPERATORS[op];
  obj.name = op;
  if (obj.alias)
    OPERATORS[obj.alias] = obj;
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/macros.js
var identity = (x) => x;
function assertIdentifier(node, message) {
  if (node.op === "id")
    return node.args;
  throw parseError("invalid_macro_argument", message, node);
}
function createMapExpander(hasFilter) {
  const functionDesc = hasFilter ? "map(var, filter, transform)" : "map(var, transform)";
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`;
  const label = `${functionDesc} filter predicate must return bool`;
  return ({ args, receiver, ast: callAst }) => {
    const [iterVar, predicate, transform] = hasFilter ? args : [args[0], null, args[1]];
    let step = transform.clone(OPERATORS.accuPush, transform);
    if (predicate) {
      const accuValue = predicate.clone(OPERATORS.accuValue);
      step = predicate.clone(OPERATORS.ternary, [predicate.setMeta("label", label), step, accuValue]);
    }
    return {
      callAst: callAst.clone(OPERATORS.comprehension, {
        errorsAreFatal: true,
        iterable: receiver,
        iterVarName: assertIdentifier(iterVar, invalidMsg),
        init: callAst.clone(OPERATORS.list, []),
        step,
        result: identity
      })
    };
  };
}
function createFilterExpander() {
  const functionDesc = "filter(var, predicate)";
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`;
  const label = `${functionDesc} predicate must return bool`;
  return ({ args, receiver, ast: callAst }) => {
    const iterVarName = assertIdentifier(args[0], invalidMsg);
    const accuValue = callAst.clone(OPERATORS.accuValue);
    const predicate = args[1].setMeta("label", label);
    const appendItem = callAst.clone(OPERATORS.accuPush, callAst.clone(OPERATORS.id, iterVarName));
    const step = predicate.clone(OPERATORS.ternary, [predicate, appendItem, accuValue]);
    return {
      callAst: callAst.clone(OPERATORS.comprehension, {
        errorsAreFatal: true,
        iterable: receiver,
        iterVarName,
        init: callAst.clone(OPERATORS.list, []),
        step,
        result: identity
      })
    };
  };
}
function createQuantifierExpander(opts) {
  const invalidMsg = `${opts.name}(var, predicate) invalid predicate iteration variable`;
  const label = `${opts.name}(var, predicate) predicate must return bool`;
  return ({ args, receiver, ast: callAst }) => {
    const predicate = args[1].setMeta("label", label);
    const transform = opts.transform({ args, ast: callAst, predicate, opts });
    return {
      callAst: callAst.clone(OPERATORS.comprehension, {
        kind: "quantifier",
        errorsAreFatal: opts.errorsAreFatal || false,
        iterable: receiver,
        iterVarName: assertIdentifier(args[0], invalidMsg),
        init: transform.init,
        condition: transform.condition,
        step: transform.step,
        result: transform.result || identity
      })
    };
  };
}
function createHasExpander() {
  const invalidHasArgument = "has() invalid argument";
  function evaluate(ev, macro, ctx) {
    const nodes = macro.macroHasProps;
    let i = nodes.length;
    let obj = ev.run(nodes[--i], ctx);
    let inOptionalContext;
    while (i--) {
      const node = nodes[i];
      if (node.op === ".?")
        inOptionalContext ??= true;
      obj = ev.debugType(obj).fieldLazy(obj, node.args[1], node, ev);
      if (obj !== undefined)
        continue;
      if (!(!inOptionalContext && i && node.op === "."))
        break;
      throw evaluationError("no_such_key", `No such key: ${node.args[1]}`, node);
    }
    return obj !== undefined;
  }
  function typeCheck(checker, macro, ctx) {
    let node = macro.args[0];
    if (node.op !== ".")
      throw checker.createError("invalid_macro_argument", invalidHasArgument, node);
    if (!macro.macroHasProps) {
      const props = [];
      while (node.op === "." || node.op === ".?")
        node = props.push(node) && node.args[0];
      if (node.op !== "id")
        throw checker.createError("invalid_macro_argument", invalidHasArgument, node);
      checker.check(node, ctx);
      props.push(node);
      macro.macroHasProps = props;
    }
    return checker.getType("bool");
  }
  return function({ args }) {
    return { args, evaluate, typeCheck, async: false };
  };
}
function registerMacros(registry) {
  const functionOverload = (sig, handler) => registry.registerFunctionOverload(sig, handler);
  functionOverload("has(ast): bool", createHasExpander());
  functionOverload("list.all(ast, ast): bool", createQuantifierExpander({
    name: "all",
    transform({ ast: callAst, predicate, opts }) {
      return {
        init: callAst.clone(OPERATORS.value, true),
        condition: identity,
        step: predicate.clone(OPERATORS.ternary, [
          predicate,
          predicate.clone(OPERATORS.value, true),
          predicate.clone(OPERATORS.value, false)
        ])
      };
    }
  }));
  functionOverload("list.exists(ast, ast): bool", createQuantifierExpander({
    name: "exists",
    condition(accu) {
      return !accu;
    },
    transform({ ast: callAst, predicate, opts }) {
      return {
        init: callAst.clone(OPERATORS.value, false),
        condition: opts.condition,
        step: predicate.clone(OPERATORS.ternary, [
          predicate,
          predicate.clone(OPERATORS.value, true),
          predicate.clone(OPERATORS.value, false)
        ])
      };
    }
  }));
  functionOverload("list.exists_one(ast, ast): bool", createQuantifierExpander({
    name: "exists_one",
    errorsAreFatal: true,
    result(accu) {
      return accu === 1;
    },
    transform({ ast: callAst, predicate, opts }) {
      const accuValue = callAst.clone(OPERATORS.accuValue);
      return {
        init: callAst.clone(OPERATORS.value, 0),
        step: predicate.clone(OPERATORS.ternary, [predicate, callAst.clone(OPERATORS.accuInc), accuValue]),
        result: opts.result
      };
    }
  }));
  functionOverload("list.map(ast, ast): list<dyn>", createMapExpander(false));
  functionOverload("list.map(ast, ast, ast): list<dyn>", createMapExpander(true));
  functionOverload("list.filter(ast, ast): list<dyn>", createFilterExpander());

  class CelNamespace {
  }
  const celNamespace = new CelNamespace;
  registry.registerType("CelNamespace", CelNamespace);
  registry.registerConstant("cel", "CelNamespace", celNamespace);
  function bindTypeCheck(checker, m, ctx) {
    m.bindCtx = ctx.forkWithVariable(m.var, checker.check(m.val, ctx));
    const type = checker.check(m.exp, m.bindCtx);
    if (m.val.maybeAsync || m.exp.maybeAsync)
      return type;
    m.ast.setMeta("async", false);
    m.evaluate = bindEvaluateSync;
    return type;
  }
  function bindOptionalEvaluate(ev, exp, bindCtx, ctx, boundValue) {
    const res = ev.run(exp, ctx = bindCtx.reuse(ctx).setIterValue(boundValue, ev));
    if (res instanceof Promise && ctx === bindCtx)
      ctx.async = true;
    return res;
  }
  function bindEvaluate(ev, { val, exp, bindCtx }, ctx) {
    const v = ev.run(val, ctx);
    if (v instanceof Promise)
      return v.then((_v) => bindOptionalEvaluate(ev, exp, bindCtx, ctx, _v));
    return bindOptionalEvaluate(ev, exp, bindCtx, ctx, v);
  }
  function bindEvaluateSync(ev, { val, exp, bindCtx }, ctx) {
    return ev.run(exp, bindCtx.reuse(ctx).setIterValue(ev.run(val, ctx), ev));
  }
  functionOverload("CelNamespace.bind(ast, dyn, ast): dyn", ({ ast, args }) => {
    return {
      ast,
      var: assertIdentifier(args[0], "invalid variable argument"),
      val: args[1],
      exp: args[2],
      bindCtx: undefined,
      typeCheck: bindTypeCheck,
      evaluate: bindEvaluate
    };
  });
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/overloads.js
function registerOverloads(registry) {
  const unaryOverload = (op, t, h, ret) => registry.unaryOverload(op, t, h, ret, false);
  const binaryOverload = (l, op, r, h, ret) => registry.binaryOverload(l, op, r, h, ret, false);
  function verifyInteger(v, ast) {
    if (v <= MAX_INT && v >= MIN_INT)
      return v;
    throw evaluationError("numeric_overflow", `integer overflow: ${v}`, ast);
  }
  function throwDivisionByZero(ast) {
    throw evaluationError("division_by_zero", "division by zero", ast);
  }
  function throwModuloByZero(ast) {
    throw evaluationError("modulo_by_zero", "modulo by zero", ast);
  }
  unaryOverload("!", "bool", (a) => !a);
  unaryOverload("-", "int", (a) => -a);
  binaryOverload("dyn<int>", `==`, `double`, (a, b) => a == b);
  binaryOverload("dyn<int>", `==`, `uint`, (a, b) => a == b.valueOf());
  binaryOverload("int", "*", "int", (a, b, ast) => verifyInteger(a * b, ast));
  binaryOverload("int", "+", "int", (a, b, ast) => verifyInteger(a + b, ast));
  binaryOverload("int", "-", "int", (a, b, ast) => verifyInteger(a - b, ast));
  binaryOverload("int", "/", "int", (a, b, ast) => {
    if (b === MIN_UINT)
      return throwDivisionByZero(ast);
    return a / b;
  });
  binaryOverload("int", "%", "int", (a, b, ast) => {
    if (b === MIN_UINT)
      return throwModuloByZero(ast);
    return a % b;
  });
  unaryOverload("-", "double", (a) => -a);
  binaryOverload("double", "*", "double", (a, b) => a * b);
  binaryOverload("double", "+", "double", (a, b) => a + b);
  binaryOverload("double", "-", "double", (a, b) => a - b);
  binaryOverload("double", "/", "double", (a, b) => a / b);
  binaryOverload("string", "+", "string", (a, b) => a + b);
  binaryOverload("list<V>", "+", "list<V>", (a, b) => [...a, ...b]);
  binaryOverload("bytes", "+", "bytes", (a, b) => {
    if (!a.length)
      return b;
    if (!b.length)
      return a;
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
  });
  const GPD = "google.protobuf.Duration";
  binaryOverload(GPD, "+", GPD, (a, b) => a.addDuration(b));
  binaryOverload(GPD, "-", GPD, (a, b) => a.subtractDuration(b));
  binaryOverload(GPD, "==", GPD, (a, b) => a.seconds === b.seconds && a.nanos === b.nanos);
  const GPT = "google.protobuf.Timestamp";
  binaryOverload(GPT, "==", GPT, (a, b) => a.getTime() === b.getTime());
  binaryOverload(GPT, "-", GPT, (a, b) => Duration.fromMilliseconds(a.getTime() - b.getTime()), GPD);
  binaryOverload(GPT, "-", GPD, (a, b) => b.subtractTimestamp(a));
  binaryOverload(GPT, "+", GPD, (a, b) => b.extendTimestamp(a));
  binaryOverload(GPD, "+", GPT, (a, b) => a.extendTimestamp(b));
  function listIncludes(value, list, ast, ev) {
    if (list instanceof Set && list.has(value))
      return true;
    for (const v of list)
      if (isEqual(value, v, ast, ev))
        return true;
    return false;
  }
  function mapIncludes(a, b) {
    if (b instanceof Map)
      return b.get(a) !== undefined;
    return hasOwn(b, a) ? b[a] !== undefined : false;
  }
  function listMembership(value, list, ast, ev) {
    return listIncludes(value, list, ast, ev);
  }
  binaryOverload("V", "in", "list<V>", listMembership);
  binaryOverload("K", "in", "map<K, V>", mapIncludes);
  for (const t of ["type", "null", "bool", "string", "int", "double"]) {
    binaryOverload(t, "==", t, (a, b) => a === b);
  }
  binaryOverload("bytes", `==`, "bytes", (a, b) => {
    if (a === b)
      return true;
    let i = a.length;
    if (i !== b.length)
      return false;
    while (i--)
      if (a[i] !== b[i])
        return false;
    return true;
  });
  binaryOverload("list<V>", `==`, "list<V>", (a, b, ast, ev) => {
    if (a === b)
      return true;
    if (isArray(a) && isArray(b)) {
      const length = a.length;
      if (length !== b.length)
        return false;
      for (let i = 0;i < length; i++) {
        if (!isEqual(a[i], b[i], ast, ev))
          return false;
      }
      return true;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size)
        return false;
      for (const value of a)
        if (!b.has(value))
          return false;
      return true;
    }
    const arr = a instanceof Set ? b : a;
    const set = a instanceof Set ? a : b;
    if (!isArray(arr))
      return false;
    if (arr.length !== set?.size)
      return false;
    for (let i = 0;i < arr.length; i++)
      if (!set.has(arr[i]))
        return false;
    return true;
  });
  binaryOverload("map<K, V>", `==`, "map<K, V>", (a, b, ast, ev) => {
    if (a === b)
      return true;
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size)
        return false;
      for (const [key, value] of a)
        if (!(b.has(key) && isEqual(value, b.get(key), ast, ev)))
          return false;
      return true;
    }
    if (a instanceof Map || b instanceof Map) {
      const obj = a instanceof Map ? b : a;
      const map = a instanceof Map ? a : b;
      const keysObj = objKeys(obj);
      if (map.size !== keysObj.length)
        return false;
      for (const [key, value] of map) {
        if (!((key in obj) && isEqual(value, obj[key], ast, ev)))
          return false;
      }
      return true;
    }
    const keysA = objKeys(a);
    const keysB = objKeys(b);
    if (keysA.length !== keysB.length)
      return false;
    for (let i = 0;i < keysA.length; i++) {
      const key = keysA[i];
      if (!((key in b) && isEqual(a[key], b[key], ast, ev)))
        return false;
    }
    return true;
  });
  binaryOverload("uint", "==", "uint", (a, b) => a.valueOf() === b.valueOf());
  binaryOverload("dyn<uint>", `==`, `double`, (a, b) => a.valueOf() == b);
  binaryOverload("uint", "+", "uint", (a, b) => new UnsignedInt(a.valueOf() + b.valueOf()));
  binaryOverload("uint", "-", "uint", (a, b) => new UnsignedInt(a.valueOf() - b.valueOf()));
  binaryOverload("uint", "*", "uint", (a, b) => new UnsignedInt(a.valueOf() * b.valueOf()));
  binaryOverload("uint", "/", "uint", (a, b, ast) => {
    if (b.valueOf() === MIN_UINT)
      return throwDivisionByZero(ast);
    return new UnsignedInt(a.valueOf() / b.valueOf());
  });
  binaryOverload("uint", "%", "uint", (a, b, ast) => {
    if (b.valueOf() === MIN_UINT)
      return throwModuloByZero(ast);
    return new UnsignedInt(a.valueOf() % b.valueOf());
  });
  for (const [left, right] of [
    ["bool", "bool"],
    ["int", "int"],
    ["uint", "uint"],
    ["double", "double"],
    ["string", "string"],
    ["google.protobuf.Timestamp", "google.protobuf.Timestamp"],
    ["google.protobuf.Duration", "google.protobuf.Duration"],
    ["int", "uint"],
    ["int", "double"],
    ["double", "int"],
    ["double", "uint"],
    ["uint", "int"],
    ["uint", "double"]
  ]) {
    binaryOverload(left, "<", right, (a, b) => a < b);
    binaryOverload(left, "<=", right, (a, b) => a <= b);
    binaryOverload(left, ">", right, (a, b) => a > b);
    binaryOverload(left, ">=", right, (a, b) => a >= b);
  }
}
function isEqual(a, b, ast, ev) {
  if (a === b)
    return true;
  switch (typeof a) {
    case "undefined":
    case "string":
    case "boolean":
      return false;
    case "bigint":
      if (typeof b === "number")
        return a == b;
      return false;
    case "number":
      if (typeof b === "bigint")
        return a == b;
      return false;
    case "object":
      if (typeof b !== "object")
        return false;
      const leftType = ev.debugType(a);
      const rightType = ev.debugType(b);
      if (leftType !== rightType)
        return false;
      const overload = ev.registry.findBinaryOverload("==", leftType, rightType);
      if (!overload)
        return false;
      return overload.handler(a, b, ast, ev);
  }
  throw evaluationError("invalid_comparison_type", `Cannot compare values of type ${typeof a}`, ast);
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/type-checker.js
var toDynTypeBinding = new Map().set("A", "dyn").set("T", "dyn").set("K", "dyn").set("V", "dyn");

class TypeChecker extends Base {
  constructor(opts, isEvaluating) {
    super(opts);
    this.createError = isEvaluating ? evaluationError : typeError;
  }
  check(ast, ctx) {
    try {
      return ast.checkedType ??= ast.check(this, ast, ctx);
    } catch (error) {
      throw attachErrorAst(error, ast);
    }
  }
  checkAccessOnType(ast, ctx, leftType, allowMissingField = false) {
    if (leftType === this.dynType)
      return leftType;
    const indexTypeName = (ast.op === "[]" || ast.op === "[?]" ? this.check(ast.args[1], ctx) : this.stringType).type;
    if (leftType.kind === "list") {
      if (indexTypeName === "int" || indexTypeName === "dyn")
        return leftType.valueType;
      throw this.createError("invalid_index_type", `List index must be int, got '${indexTypeName}'`, ast);
    }
    if (leftType.kind === "map")
      return leftType.valueType;
    const customType = this.objectTypes.get(leftType.name);
    if (customType) {
      if (!(indexTypeName === "string" || indexTypeName === "dyn")) {
        throw this.createError("invalid_index_type", `Cannot index type '${leftType.name}' with type '${indexTypeName}'`, ast);
      }
      if (customType.fields) {
        let keyName;
        if (ast.op === "." || ast.op === ".?")
          keyName = ast.args[1];
        else if (ast.args[1].op === "value")
          keyName = ast.args[1].args;
        if (typeof keyName === "string") {
          const fieldType = customType.fields[keyName];
          if (fieldType)
            return fieldType;
          if (allowMissingField)
            return this.dynType;
          throw this.createError("no_such_key", `No such key: ${keyName}`, ast);
        }
      }
      return this.dynType;
    }
    throw this.createError("cannot_index_type", `Cannot index type '${this.formatType(leftType)}'`, ast);
  }
  formatType(type) {
    if (!type.hasPlaceholderType)
      return type.name;
    return type.templated(this.registry, toDynTypeBinding).name;
  }
  formatTypeList(types) {
    return types.map((t) => this.formatType(t)).join(", ");
  }
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/parser.js
var TOKEN = {
  EOF: 0,
  NUMBER: 1,
  STRING: 2,
  BOOLEAN: 3,
  NULL: 4,
  IDENTIFIER: 5,
  PLUS: 6,
  MINUS: 7,
  MULTIPLY: 8,
  DIVIDE: 9,
  MODULO: 10,
  EQ: 11,
  NE: 12,
  LT: 13,
  LE: 14,
  GT: 15,
  GE: 16,
  AND: 17,
  OR: 18,
  NOT: 19,
  IN: 20,
  LPAREN: 21,
  RPAREN: 22,
  LBRACKET: 23,
  RBRACKET: 24,
  LBRACE: 25,
  RBRACE: 26,
  DOT: 27,
  COMMA: 28,
  COLON: 29,
  QUESTION: 30,
  BYTES: 31
};
var OP_FOR_TOKEN = {
  [TOKEN.EQ]: OPERATORS["=="],
  [TOKEN.PLUS]: OPERATORS["+"],
  [TOKEN.MINUS]: OPERATORS["-"],
  [TOKEN.MULTIPLY]: OPERATORS["*"],
  [TOKEN.DIVIDE]: OPERATORS["/"],
  [TOKEN.MODULO]: OPERATORS["%"],
  [TOKEN.LE]: OPERATORS["<="],
  [TOKEN.LT]: OPERATORS["<"],
  [TOKEN.GE]: OPERATORS[">="],
  [TOKEN.GT]: OPERATORS[">"],
  [TOKEN.NE]: OPERATORS["!="],
  [TOKEN.IN]: OPERATORS["in"]
};
var TOKEN_BY_NUMBER = {};
for (const key in TOKEN)
  TOKEN_BY_NUMBER[TOKEN[key]] = key;
var HEX_CODES = new Uint8Array(128);
for (const ch of "0123456789abcdefABCDEF")
  HEX_CODES[ch.charCodeAt(0)] = 1;
var ESCAPE_ERRORS = {
  bytes_unicode_escape: (e) => `\\${e} not allowed in bytes literals`,
  invalid_unicode_escape: (e) => `Invalid Unicode escape: \\${e}`,
  invalid_unicode_surrogate: (e) => `Invalid Unicode surrogate: \\${e}`,
  invalid_hex_escape: (e) => `Invalid hex escape: \\${e}`,
  invalid_octal_escape: () => "Octal escape must be 3 digits",
  octal_escape_out_of_range: (e) => `Octal escape out of range: \\${e}`,
  invalid_escape_sequence: (e) => `Invalid escape sequence: \\${e}`
};
var STRING_ESCAPES = {
  "\\": "\\",
  "?": "?",
  '"': '"',
  "'": "'",
  "`": "`",
  a: "\x07",
  b: "\b",
  f: "\f",
  n: `
`,
  r: "\r",
  t: "\t",
  v: "\v"
};

class ASTNode {
  #meta;
  #input;
  constructor(input, pos, start, end, op, args) {
    this.#meta = { check: op.check, evaluate: op.evaluate };
    this.#input = input;
    this.op = op.name;
    this.args = args;
    this.pos = pos;
    this.start = start;
    this.end = end;
  }
  clone(op, args) {
    return new ASTNode(this.#input, this.pos, this.start, this.end, op, args);
  }
  get meta() {
    return this.#meta;
  }
  get input() {
    return this.#input;
  }
  #computeIsAsync() {
    const ast = this.#meta.alternate ?? this;
    switch (ast.op) {
      case "value":
      case "id":
      case "accuValue":
      case "accuInc":
        return false;
      case "accuPush":
        return ast.args.maybeAsync;
      case "!_":
      case "-_":
        if (ast.candidates?.async !== false)
          return true;
        return ast.args.maybeAsync;
      case "!=":
      case "==":
      case "in":
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (ast.candidates?.async !== false)
          return true;
        return ast.args.some((a) => a.maybeAsync);
      case "call":
      case "rcall":
        if (ast.candidates?.async !== false)
          return true;
        return (ast.receiverWithArgs || ast.args[1]).some((a) => a.maybeAsync);
      case "comprehension":
        return ast.args.iterable.maybeAsync || ast.args.step.maybeAsync;
      case ".":
      case ".?":
        return ast.args[0].maybeAsync;
      case "?:":
      case "list":
      case "[]":
      case "[?]":
        return ast.args.some((a) => a.maybeAsync);
      case "||":
      case "&&":
        return ast.args.some((a) => a.maybeAsync);
      case "map":
        return ast.args.some((a) => a[0].maybeAsync || a[1].maybeAsync);
      default:
        return true;
    }
  }
  get maybeAsync() {
    return this.#meta.async ??= this.#computeIsAsync();
  }
  check(chk, ast, ctx) {
    const meta = this.#meta;
    if (meta.alternate)
      return chk.check(meta.alternate, ctx);
    else if (meta.macro)
      return meta.macro.typeCheck(chk, meta.macro, ctx);
    return meta.check(chk, ast, ctx);
  }
  evaluate(ev, ast, ctx) {
    const meta = this.#meta;
    if (meta.alternate)
      this.evaluate = this.#evaluateAlternate;
    else if (meta.macro)
      this.evaluate = this.#evaluateMacro;
    else
      this.evaluate = meta.evaluate;
    return this.evaluate(ev, ast, ctx);
  }
  #evaluateAlternate(ev, ast, ctx) {
    return (ast = this.#meta.alternate).evaluate(ev, ast, ctx);
  }
  #evaluateMacro(ev, ast, ctx) {
    return (ast = this.#meta.macro).evaluate(ev, ast, ctx);
  }
  setMeta(key, value) {
    return this.#meta[key] = value, this;
  }
  get range() {
    return { start: this.start, end: this.end };
  }
  toOldStructure() {
    const args = Array.isArray(this.args) ? this.args : [this.args];
    return [this.op, ...args.map((a) => a instanceof ASTNode ? a.toOldStructure() : a)];
  }
}

class Lexer {
  input;
  pos;
  length;
  tokenPos;
  tokenType;
  tokenValue;
  reset(input) {
    this.pos = 0;
    this.input = input;
    this.length = input.length;
    return input;
  }
  token(pos, type, value) {
    this.tokenPos = pos;
    this.tokenType = type;
    this.tokenValue = value;
    return this;
  }
  nextToken() {
    while (true) {
      const { pos, input, length } = this;
      if (pos >= length)
        return this.token(pos, TOKEN.EOF);
      const ch = input[pos];
      switch (ch) {
        case " ":
        case "\t":
        case `
`:
        case "\r":
          this.pos++;
          continue;
        case "=":
          if (input[pos + 1] !== "=")
            break;
          return this.token((this.pos += 2) - 2, TOKEN.EQ);
        case "&":
          if (input[pos + 1] !== "&")
            break;
          return this.token((this.pos += 2) - 2, TOKEN.AND);
        case "|":
          if (input[pos + 1] !== "|")
            break;
          return this.token((this.pos += 2) - 2, TOKEN.OR);
        case "+":
          return this.token(this.pos++, TOKEN.PLUS);
        case "-":
          return this.token(this.pos++, TOKEN.MINUS);
        case "*":
          return this.token(this.pos++, TOKEN.MULTIPLY);
        case "/":
          if (input[pos + 1] === "/") {
            while (this.pos < length && this.input[this.pos] !== `
`)
              this.pos++;
            continue;
          }
          return this.token(this.pos++, TOKEN.DIVIDE);
        case "%":
          return this.token(this.pos++, TOKEN.MODULO);
        case "<":
          if (input[pos + 1] === "=")
            return this.token((this.pos += 2) - 2, TOKEN.LE);
          return this.token(this.pos++, TOKEN.LT);
        case ">":
          if (input[pos + 1] === "=")
            return this.token((this.pos += 2) - 2, TOKEN.GE);
          return this.token(this.pos++, TOKEN.GT);
        case "!":
          if (input[pos + 1] === "=")
            return this.token((this.pos += 2) - 2, TOKEN.NE);
          return this.token(this.pos++, TOKEN.NOT);
        case "(":
          return this.token(this.pos++, TOKEN.LPAREN);
        case ")":
          return this.token(this.pos++, TOKEN.RPAREN);
        case "[":
          return this.token(this.pos++, TOKEN.LBRACKET);
        case "]":
          return this.token(this.pos++, TOKEN.RBRACKET);
        case "{":
          return this.token(this.pos++, TOKEN.LBRACE);
        case "}":
          return this.token(this.pos++, TOKEN.RBRACE);
        case ".":
          return this.token(this.pos++, TOKEN.DOT);
        case ",":
          return this.token(this.pos++, TOKEN.COMMA);
        case ":":
          return this.token(this.pos++, TOKEN.COLON);
        case "?":
          return this.token(this.pos++, TOKEN.QUESTION);
        case `"`:
        case `'`:
          return this.readString(ch);
        case "b":
        case "B":
        case "r":
        case "R": {
          const next = input[pos + 1];
          if (next === '"' || next === "'")
            return ++this.pos && this.readString(next, ch);
          return this.readIdentifier();
        }
        default: {
          const code = ch.charCodeAt(0);
          if (code <= 57 && code >= 48)
            return this.readNumber();
          if (this._isIdentifierCharCode(code))
            return this.readIdentifier();
        }
      }
      throw parseError("unexpected_character", `Unexpected character: ${ch}`, {
        pos,
        start: pos,
        end: pos + 1,
        input
      });
    }
  }
  _isIdentifierCharCode(c) {
    if (c < 48 || c > 122)
      return false;
    return c >= 97 || c >= 65 && c <= 90 || c <= 57 || c === 95;
  }
  _parseAsDouble(start, end) {
    const value = Number(this.input.substring(start, end));
    if (Number.isFinite(value))
      return this.token(start, TOKEN.NUMBER, value);
    throw parseError("invalid_number", `Invalid number: ${value}`, {
      pos: start,
      start,
      end,
      input: this.input
    });
  }
  _parseAsBigInt(start, end, isHex, unsigned) {
    const string = this.input.substring(start, end);
    if (unsigned === "u" || unsigned === "U") {
      this.pos++;
      try {
        return this.token(start, TOKEN.NUMBER, new UnsignedInt(string));
      } catch (_err) {}
    } else {
      try {
        return this.token(start, TOKEN.NUMBER, BigInt(string));
      } catch (_err) {}
    }
    throw parseError(isHex ? "invalid_hex_integer" : "invalid_integer", isHex ? `Invalid hex integer: ${string}` : `Invalid integer: ${string}`, { pos: start, start, end: this.pos, input: this.input });
  }
  _readDigits(input, length, pos, code) {
    while (pos < length && (code = input.charCodeAt(pos)) && !(code > 57 || code < 48))
      pos++;
    return pos;
  }
  _readExponent(input, length, pos) {
    let ch = pos < length && input[pos];
    if (ch === "e" || ch === "E") {
      ch = ++pos < length && input[pos];
      if (ch === "-" || ch === "+")
        pos++;
      const start = pos;
      pos = this._readDigits(input, length, pos);
      if (start === pos)
        throw parseError("invalid_exponent", "Invalid exponent", {
          pos,
          start: pos,
          end: Math.min(pos + 1, input.length),
          input
        });
    }
    return pos;
  }
  readNumber() {
    const { input, length, pos: start } = this;
    let pos = start;
    if (input[pos] === "0" && (input[pos + 1] === "x" || input[pos + 1] === "X")) {
      pos += 2;
      while (pos < length && HEX_CODES[input[pos].charCodeAt(0)])
        pos++;
      return this._parseAsBigInt(start, this.pos = pos, true, input[pos]);
    }
    pos = this._readDigits(input, length, pos);
    if (pos + 1 < length) {
      let isDouble = false;
      let afterpos = input[pos] === "." ? this._readDigits(input, length, pos + 1) : pos + 1;
      if (afterpos !== pos + 1)
        (isDouble = true) && (pos = afterpos);
      afterpos = this._readExponent(input, length, pos);
      if (afterpos !== pos)
        (isDouble = true) && (pos = afterpos);
      if (isDouble)
        return this._parseAsDouble(start, this.pos = pos);
    }
    return this._parseAsBigInt(start, this.pos = pos, false, input[pos]);
  }
  readString(del, prefix) {
    const { input: i, pos: s } = this;
    if (i[s + 1] === del && i[s + 2] === del)
      return this.readTripleQuotedString(del, prefix);
    return this.readSingleQuotedString(del, prefix);
  }
  _closeQuotedString(rawStart, rawValue, prefix, pos) {
    switch (prefix) {
      case "b":
      case "B": {
        const processed = this.processEscapes(rawStart, rawValue, true);
        const bytes = new Uint8Array(processed.length);
        for (let i = 0;i < processed.length; i++)
          bytes[i] = processed.charCodeAt(i) & 255;
        return this.token(pos - 1, TOKEN.BYTES, bytes);
      }
      case "r":
      case "R": {
        return this.token(pos - 1, TOKEN.STRING, rawValue);
      }
      default: {
        const value = this.processEscapes(rawStart, rawValue, false);
        return this.token(pos, TOKEN.STRING, value);
      }
    }
  }
  readSingleQuotedString(delimiter, prefix) {
    const { input, length, pos: start } = this;
    let ch;
    let pos = this.pos + 1;
    while (pos < length && (ch = input[pos])) {
      switch (ch) {
        case delimiter:
          const rawStart = start + 1;
          const rawValue = input.slice(rawStart, pos);
          this.pos = ++pos;
          return this._closeQuotedString(rawStart, rawValue, prefix, start);
        case `
`:
        case "\r":
          throw parseError("newline_in_string", "Newlines not allowed in single-quoted strings", {
            pos,
            start: pos,
            end: pos + 1,
            input
          });
        case "\\":
          pos++;
      }
      pos++;
    }
    throw parseError("unterminated_string", "Unterminated string", {
      pos: start,
      start,
      end: input.length,
      input
    });
  }
  readTripleQuotedString(delimiter, prefix) {
    const { input, length, pos: start } = this;
    let ch;
    let pos = this.pos + 3;
    while (pos < length && (ch = input[pos])) {
      switch (ch) {
        case delimiter:
          if (input[pos + 1] === delimiter && input[pos + 2] === delimiter) {
            const rawStart = start + 3;
            const rawValue = input.slice(rawStart, pos);
            this.pos = pos + 3;
            return this._closeQuotedString(rawStart, rawValue, prefix, start);
          }
          break;
        case "\\":
          pos++;
      }
      pos++;
    }
    throw parseError("unterminated_triple_quoted_string", "Unterminated triple-quoted string", {
      pos: start,
      start,
      end: input.length,
      input
    });
  }
  #escapeErr(code, offset, len, i, chars, extra) {
    const start = offset + i;
    return parseError(code, ESCAPE_ERRORS[code](extra), {
      input: this.input,
      pos: start,
      start,
      end: Math.min(start + chars, offset + len)
    });
  }
  processEscapes(offset, str, isBytes) {
    if (!str.includes("\\"))
      return str;
    const len = str.length;
    let result = "";
    let i = 0;
    while (i < len) {
      if (str[i] !== "\\" || i + 1 >= len) {
        result += str[i++];
        continue;
      }
      const next = str[i + 1];
      if (STRING_ESCAPES[next]) {
        result += STRING_ESCAPES[next];
        i += 2;
      } else if (next === "u" || next === "U") {
        if (isBytes)
          throw this.#escapeErr("bytes_unicode_escape", offset, len, i, 2, next);
        const hexLen = next === "u" ? 4 : 8;
        const hex = str.substring(i + 2, i + 2 + hexLen);
        const c = Number.parseInt(hex, 16);
        if (hex.length !== hexLen || !/^[0-9a-fA-F]+$/.test(hex) || c > 1114111)
          throw this.#escapeErr("invalid_unicode_escape", offset, len, i, 2 + hexLen, next + hex);
        if (c >= 55296 && c <= 57343)
          throw this.#escapeErr("invalid_unicode_surrogate", offset, len, i, 2 + hexLen, next + hex);
        result += String.fromCodePoint(c);
        i += 2 + hexLen;
      } else if (next === "x" || next === "X") {
        const h = str.substring(i + 2, i + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(h))
          throw this.#escapeErr("invalid_hex_escape", offset, len, i, 4, next + h);
        result += String.fromCharCode(Number.parseInt(h, 16));
        i += 4;
      } else if (next >= "0" && next <= "7") {
        const o = str.substring(i + 1, i + 4);
        if (!/^[0-7]{3}$/.test(o))
          throw this.#escapeErr("invalid_octal_escape", offset, len, i, 4);
        const value = Number.parseInt(o, 8);
        if (value > 255)
          throw this.#escapeErr("octal_escape_out_of_range", offset, len, i, 4, o);
        result += String.fromCharCode(value);
        i += 4;
      } else {
        throw this.#escapeErr("invalid_escape_sequence", offset, len, i, 2, next);
      }
    }
    return result;
  }
  readIdentifier() {
    const { pos, input, length } = this;
    let p = pos;
    while (p < length && this._isIdentifierCharCode(input[p].charCodeAt(0)))
      p++;
    const value = input.substring(pos, this.pos = p);
    switch (value) {
      case "true":
        return this.token(pos, TOKEN.BOOLEAN, true);
      case "false":
        return this.token(pos, TOKEN.BOOLEAN, false);
      case "null":
        return this.token(pos, TOKEN.NULL, null);
      case "in":
        return this.token(pos, TOKEN.IN);
      default:
        return this.token(pos, TOKEN.IDENTIFIER, value);
    }
  }
}
var globalLexer = new Lexer;

class Parser {
  lexer = globalLexer;
  input = null;
  maxDepthRemaining = null;
  astNodesRemaining = null;
  type = null;
  pos = null;
  constructor(limits, registry) {
    this.limits = limits;
    this.registry = registry;
  }
  #limitExceeded(limitKey, pos = this.pos) {
    throw parseError("limit_exceeded", `Exceeded ${limitKey} (${this.limits[limitKey]})`, {
      pos,
      start: pos,
      end: pos,
      input: this.input
    });
  }
  #node(start, end, op, args, pos = start) {
    const node = new ASTNode(this.input, pos, start, end, op, args);
    if (!this.astNodesRemaining--)
      this.#limitExceeded("maxAstNodes", pos);
    return node;
  }
  #infixNode(op, left, right) {
    return this.#node(left.start, right.end, op, [left, right]);
  }
  #ternaryNode(expression, consequent, alternate) {
    return this.#node(expression.start, alternate.end, OPERATORS.ternary, [
      expression,
      consequent,
      alternate
    ]);
  }
  #unaryNode(pos, op, arg) {
    return this.#node(pos, arg.end, op, arg);
  }
  #accessNode(op, left, right, end, pos = left.start) {
    return this.#node(left.start, end, op, [left, right], pos);
  }
  #advanceToken(returnValue = this.pos) {
    const l = this.lexer.nextToken();
    this.pos = l.tokenPos;
    this.type = l.tokenType;
    return returnValue;
  }
  get value() {
    return this.lexer.tokenValue;
  }
  consume(expectedType) {
    if (this.type === expectedType)
      return this.#advanceToken();
    throw parseError("expected_token", `Expected ${TOKEN_BY_NUMBER[expectedType]}, got ${TOKEN_BY_NUMBER[this.type]}`, { pos: this.pos, start: this.pos, end: this.lexer.pos, input: this.input });
  }
  match(type) {
    return this.type === type;
  }
  parse(input) {
    if (typeof input !== "string") {
      throw parseError("expression_must_be_string", "Expression must be a string");
    }
    this.input = this.lexer.reset(input);
    this.#advanceToken();
    this.maxDepthRemaining = this.limits.maxDepth;
    this.astNodesRemaining = this.limits.maxAstNodes;
    const result = this.parseExpression();
    if (this.match(TOKEN.EOF))
      return result;
    throw parseError("unexpected_character", `Unexpected character: '${this.input[this.lexer.pos - 1]}'`, {
      pos: this.pos,
      start: this.pos,
      end: this.lexer.pos,
      input: this.input
    });
  }
  #expandMacro(start, end, op, args) {
    const methodName = args[0];
    const receiver = op === OPERATORS.rcall ? args[1] : null;
    const fnArgs = op === OPERATORS.rcall ? args[2] : args[1];
    const decl = this.registry.findMacro(methodName, !!receiver, fnArgs.length);
    const ast = this.#node(start, end, op, args);
    if (!decl)
      return ast;
    const macro = decl.handler({ ast, args: fnArgs, receiver, methodName, parser: this });
    if (macro.callAst)
      return ast.setMeta("alternate", macro.callAst);
    return ast.setMeta("macro", macro).setMeta("async", isAsync(macro.evaluate, macro.async));
  }
  parseExpression() {
    if (!this.maxDepthRemaining--)
      this.#limitExceeded("maxDepth");
    const expr = this.parseLogicalOr();
    if (!this.match(TOKEN.QUESTION))
      return ++this.maxDepthRemaining && expr;
    this.#advanceToken();
    const consequent = this.parseExpression();
    this.consume(TOKEN.COLON);
    const alternate = this.parseExpression();
    this.maxDepthRemaining++;
    return this.#ternaryNode(expr, consequent, alternate);
  }
  parseLogicalOr() {
    let expr = this.parseLogicalAnd();
    while (this.match(TOKEN.OR)) {
      this.#advanceToken();
      expr = this.#infixNode(OPERATORS["||"], expr, this.parseLogicalAnd());
    }
    return expr;
  }
  parseLogicalAnd() {
    let expr = this.parseEquality();
    while (this.match(TOKEN.AND)) {
      this.#advanceToken();
      expr = this.#infixNode(OPERATORS["&&"], expr, this.parseEquality());
    }
    return expr;
  }
  parseEquality() {
    let expr = this.parseRelational();
    while (this.match(TOKEN.EQ) || this.match(TOKEN.NE)) {
      const op = OP_FOR_TOKEN[this.type];
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseRelational());
    }
    return expr;
  }
  parseRelational() {
    let expr = this.parseAdditive();
    while (this.match(TOKEN.LT) || this.match(TOKEN.LE) || this.match(TOKEN.GT) || this.match(TOKEN.GE) || this.match(TOKEN.IN)) {
      const op = OP_FOR_TOKEN[this.type];
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseAdditive());
    }
    return expr;
  }
  parseAdditive() {
    let expr = this.parseMultiplicative();
    while (this.match(TOKEN.PLUS) || this.match(TOKEN.MINUS)) {
      const op = OP_FOR_TOKEN[this.type];
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseMultiplicative());
    }
    return expr;
  }
  parseMultiplicative() {
    let expr = this.parseUnary();
    while (this.match(TOKEN.MULTIPLY) || this.match(TOKEN.DIVIDE) || this.match(TOKEN.MODULO)) {
      const op = OP_FOR_TOKEN[this.type];
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseUnary());
    }
    return expr;
  }
  parseUnary() {
    if (this.type === TOKEN.NOT) {
      return this.#unaryNode(this.#advanceToken(), OPERATORS.unaryNot, this.parseUnary());
    }
    if (this.type === TOKEN.MINUS) {
      return this.#unaryNode(this.#advanceToken(), OPERATORS.unaryMinus, this.parseUnary());
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let expr = this.parsePrimary();
    const depth = this.maxDepthRemaining;
    while (true) {
      if (this.match(TOKEN.DOT)) {
        const dot = this.#advanceToken();
        if (!this.maxDepthRemaining--)
          this.#limitExceeded("maxDepth", dot);
        const op = this.match(TOKEN.QUESTION) && this.registry.enableOptionalTypes && this.#advanceToken() ? OPERATORS.optionalFieldAccess : OPERATORS.fieldAccess;
        const propertyValue = this.value;
        const start = this.pos;
        const end = this.lexer.pos;
        this.consume(TOKEN.IDENTIFIER);
        if (op === OPERATORS.fieldAccess && this.match(TOKEN.LPAREN) && this.#advanceToken()) {
          const args = this.parseArgumentList();
          const closeEnd = this.lexer.pos;
          this.consume(TOKEN.RPAREN);
          expr = this.#expandMacro(expr.start, closeEnd, OPERATORS.rcall, [propertyValue, expr, args]);
        } else {
          expr = this.#accessNode(op, expr, propertyValue, end, start);
        }
        continue;
      }
      if (this.match(TOKEN.LBRACKET)) {
        const bracket = this.#advanceToken();
        if (!this.maxDepthRemaining--)
          this.#limitExceeded("maxDepth", bracket);
        const op = this.match(TOKEN.QUESTION) && this.registry.enableOptionalTypes && this.#advanceToken() ? OPERATORS.optionalBracketAccess : OPERATORS.bracketAccess;
        const index = this.parseExpression();
        const closeEnd = this.lexer.pos;
        this.consume(TOKEN.RBRACKET);
        expr = this.#accessNode(op, expr, index, closeEnd);
        continue;
      }
      break;
    }
    this.maxDepthRemaining = depth;
    return expr;
  }
  parsePrimary() {
    switch (this.type) {
      case TOKEN.NUMBER:
      case TOKEN.STRING:
      case TOKEN.BYTES:
      case TOKEN.BOOLEAN:
      case TOKEN.NULL:
        return this.#consumeLiteral();
      case TOKEN.IDENTIFIER:
        return this.#parseIdentifierPrimary();
      case TOKEN.LPAREN:
        return this.#parseParenthesizedExpression();
      case TOKEN.LBRACKET:
        return this.parseList();
      case TOKEN.LBRACE:
        return this.parseMap();
    }
    throw parseError("unexpected_token", `Unexpected token: ${TOKEN_BY_NUMBER[this.type]}`, {
      pos: this.pos,
      start: this.pos,
      end: this.lexer.pos,
      input: this.input
    });
  }
  #consumeLiteral() {
    return this.#advanceToken(this.#node(this.pos, this.lexer.pos, OPERATORS.value, this.value));
  }
  #parseIdentifierPrimary() {
    const value = this.value;
    const end = this.lexer.pos;
    const start = this.consume(TOKEN.IDENTIFIER);
    if (RESERVED.has(value)) {
      throw parseError("reserved_identifier", `Reserved identifier: ${value}`, {
        pos: start,
        start,
        end,
        input: this.input
      });
    }
    if (!this.match(TOKEN.LPAREN))
      return this.#node(start, end, OPERATORS.id, value);
    this.#advanceToken();
    const args = this.parseArgumentList();
    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RPAREN);
    return this.#expandMacro(start, closeEnd, OPERATORS.call, [value, args]);
  }
  #parseParenthesizedExpression() {
    this.consume(TOKEN.LPAREN);
    const expr = this.parseExpression();
    this.consume(TOKEN.RPAREN);
    return expr;
  }
  parseList() {
    const start = this.consume(TOKEN.LBRACKET);
    const elements = [];
    let remainingElements = this.limits.maxListElements;
    if (!this.match(TOKEN.RBRACKET)) {
      elements.push(this.parseExpression());
      if (!remainingElements--)
        this.#limitExceeded("maxListElements", elements.at(-1).pos);
      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RBRACKET))
          break;
        elements.push(this.parseExpression());
        if (!remainingElements--)
          this.#limitExceeded("maxListElements", elements.at(-1).pos);
      }
    }
    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RBRACKET);
    return this.#node(start, closeEnd, OPERATORS.list, elements);
  }
  parseMap() {
    const start = this.consume(TOKEN.LBRACE);
    const props = [];
    let remainingEntries = this.limits.maxMapEntries;
    if (!this.match(TOKEN.RBRACE)) {
      props.push(this.parseProperty());
      if (!remainingEntries--)
        this.#limitExceeded("maxMapEntries", props.at(-1)[0].pos);
      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RBRACE))
          break;
        props.push(this.parseProperty());
        if (!remainingEntries--)
          this.#limitExceeded("maxMapEntries", props.at(-1)[0].pos);
      }
    }
    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RBRACE);
    return this.#node(start, closeEnd, OPERATORS.map, props);
  }
  parseProperty() {
    return [this.parseExpression(), (this.consume(TOKEN.COLON), this.parseExpression())];
  }
  parseArgumentList() {
    const args = [];
    let remainingArgs = this.limits.maxCallArguments;
    if (!this.match(TOKEN.RPAREN)) {
      args.push(this.parseExpression());
      if (!remainingArgs--)
        this.#limitExceeded("maxCallArguments", args.at(-1).pos);
      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RPAREN))
          break;
        args.push(this.parseExpression());
        if (!remainingArgs--)
          this.#limitExceeded("maxCallArguments", args.at(-1).pos);
      }
    }
    return args;
  }
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/options.js
var DEFAULT_LIMITS = objFreeze({
  maxAstNodes: 1e5,
  maxDepth: 250,
  maxListElements: 1000,
  maxMapEntries: 1000,
  maxCallArguments: 32
});
var LIMIT_KEYS = new Set(objKeys(DEFAULT_LIMITS));
function createLimits(overrides, base = DEFAULT_LIMITS) {
  const keys = overrides ? objKeys(overrides) : undefined;
  if (!keys?.length)
    return base;
  const merged = { ...base };
  for (const key of keys) {
    if (!LIMIT_KEYS.has(key))
      throw new TypeError(`Unknown limits option: ${key}`);
    const value = overrides[key];
    if (typeof value !== "number")
      continue;
    merged[key] = value;
  }
  return objFreeze(merged);
}
var DEFAULT_OPTIONS = objFreeze({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: true,
  enableOptionalTypes: false,
  limits: DEFAULT_LIMITS
});
function bool(a, b, key) {
  const value = a?.[key] ?? b?.[key];
  if (typeof value !== "boolean")
    throw new TypeError(`Invalid option: ${key}`);
  return value;
}
function createOptions(opts, base = DEFAULT_OPTIONS) {
  if (!opts)
    return base;
  return objFreeze({
    unlistedVariablesAreDyn: bool(opts, base, "unlistedVariablesAreDyn"),
    homogeneousAggregateLiterals: bool(opts, base, "homogeneousAggregateLiterals"),
    enableOptionalTypes: bool(opts, base, "enableOptionalTypes"),
    limits: createLimits(opts.limits, base.limits)
  });
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/evaluator.js
var globalRegistry = createRegistry({ enableOptionalTypes: false });
registerFunctions(globalRegistry);
registerOverloads(globalRegistry);
registerMacros(globalRegistry);

class Environment {
  #registry;
  #evaluator;
  #typeChecker;
  #evalTypeChecker;
  #parser;
  constructor(opts, inherited) {
    this.opts = createOptions(opts, inherited?.opts);
    this.#registry = (inherited instanceof Environment ? inherited.#registry : globalRegistry).clone(this.opts);
    const childOpts = { registry: this.#registry, opts: this.opts };
    this.#typeChecker = new TypeChecker(childOpts);
    this.#evalTypeChecker = new TypeChecker(childOpts, true);
    this.#evaluator = new Evaluator(childOpts);
    this.#parser = new Parser(this.opts.limits, this.#registry);
    Object.freeze(this);
  }
  clone(opts) {
    return new Environment(opts, this);
  }
  registerFunction(signature, handler, opts) {
    this.#registry.registerFunctionOverload(signature, handler, opts);
    return this;
  }
  registerOperator(string, handler, opts) {
    this.#registry.registerOperatorOverload(string, handler, opts);
    return this;
  }
  registerType(typename, constructor) {
    this.#registry.registerType(typename, constructor);
    return this;
  }
  registerVariable(name, type, opts) {
    this.#registry.registerVariable(name, type, opts);
    return this;
  }
  registerConstant(name, type, value) {
    this.#registry.registerConstant(name, type, value);
    return this;
  }
  hasVariable(name) {
    return this.#registry.variables.has(name);
  }
  getDefinitions() {
    return this.#registry.getDefinitions();
  }
  check(expression) {
    try {
      return this.#checkAST(this.#parser.parse(expression));
    } catch (error) {
      return { valid: false, error };
    }
  }
  #checkAST(ast) {
    try {
      const typeDecl = this.#typeChecker.check(ast, new RootContext(this.#registry));
      return { valid: true, type: this.#formatTypeForCheck(typeDecl) };
    } catch (error) {
      return { valid: false, error };
    }
  }
  #formatTypeForCheck(typeDecl) {
    if (typeDecl.name === `list<dyn>`)
      return "list";
    if (typeDecl.name === `map<dyn, dyn>`)
      return "map";
    return typeDecl.name;
  }
  parse(expression) {
    const ast = this.#parser.parse(expression);
    const evaluateParsed = this.#evaluateAST.bind(this, ast);
    evaluateParsed.check = this.#checkAST.bind(this, ast);
    evaluateParsed.ast = ast;
    return evaluateParsed;
  }
  evaluate(expression, context) {
    return this.#evaluateAST(this.#parser.parse(expression), context);
  }
  #evaluateAST(ast, ctx) {
    if (ast.checkedType) {
      return ast.evaluate(this.#evaluator, ast, new RootContext(this.#registry, ctx));
    } else {
      this.#evalTypeChecker.check(ast, ctx = new RootContext(this.#registry, ctx));
      return ast.evaluate(this.#evaluator, ast, ctx);
    }
  }
}

class Evaluator extends Base {
  constructor(opts) {
    super(opts);
    this.createError = evaluationError;
  }
  #firstMapElement(coll) {
    if (coll instanceof Map)
      return coll.entries().next().value;
    for (const key in coll)
      return [key, coll[key]];
  }
  debugRuntimeType(value, checkedType) {
    return checkedType?.hasDynType === false ? checkedType : this.debugTypeDeep(value);
  }
  debugTypeDeep(value) {
    const runtimeType = this.debugType(value);
    switch (runtimeType.kind) {
      case "list": {
        const first = value instanceof Array ? value[0] : value.values().next().value;
        if (first === undefined)
          return runtimeType;
        return this.registry.getListType(this.debugTypeDeep(first));
      }
      case "map": {
        const first = this.#firstMapElement(value);
        if (!first)
          return runtimeType;
        return this.registry.getMapType(runtimeType.keyType.hasDynType ? this.debugTypeDeep(first[0]) : runtimeType.keyType, runtimeType.valueType.hasDynType ? this.debugTypeDeep(first[1]) : runtimeType.valueType);
      }
      default:
        return runtimeType;
    }
  }
  tryEval(ast, ctx) {
    try {
      const res = this.run(ast, ctx);
      if (res instanceof Promise)
        return res.catch((err) => err);
      return res;
    } catch (err) {
      return err;
    }
  }
  run(ast, ctx) {
    return ast.evaluate(this, ast, ctx);
  }
}
var globalEnvironment = new Environment({
  unlistedVariablesAreDyn: true
});
function parse(expression) {
  return globalEnvironment.parse(expression);
}
function evaluate(expression, context) {
  return globalEnvironment.evaluate(expression, context);
}
function check(expression) {
  return globalEnvironment.check(expression);
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/serialize.js
function serializeValue(value) {
  if (value === null)
    return "null";
  if (typeof value === "boolean")
    return String(value);
  if (typeof value === "bigint")
    return String(value);
  if (typeof value === "string")
    return serializeString(value);
  if (value instanceof Uint8Array)
    return serializeBytes(value);
  if (value instanceof UnsignedInt)
    return `${value.value}u`;
  if (value instanceof Optional) {
    if (value.hasValue())
      return `optional.of(${serializeValue(value.value())})`;
    return "optional.none()";
  }
  if (typeof value === "number") {
    return value % 1 === 0 ? `${value}.0` : value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 9 });
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.every((k) => /^\d+$/.test(k))) {
      const bytes = new Uint8Array(keys.length);
      for (let i = 0;i < keys.length; i++)
        bytes[i] = value[i];
      return serializeBytes(bytes);
    }
  }
  return String(value);
}
function serialize(ast) {
  const { op, args } = ast;
  switch (op) {
    case "value":
      return serializeValue(args);
    case "id":
      return args;
    case "||":
    case "&&":
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=":
    case "in":
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
      return `${wrap(args[0], op)} ${op} ${wrap(args[1], op)}`;
    case "!_":
      return `!${wrap(args, op)}`;
    case "-_":
      return ["+", "-", "*", "/", "%"].includes(args.op) ? `-(${serialize(args)})` : `-${serialize(args)}`;
    case ".":
      return `${wrap(args[0], op)}.${args[1]}`;
    case ".?":
      return `${wrap(args[0], op)}.?${args[1]}`;
    case "[]":
      return `${wrap(args[0], op)}[${serialize(args[1])}]`;
    case "[?]":
      return `${wrap(args[0], op)}[?${serialize(args[1])}]`;
    case "call":
      return `${args[0]}(${args[1].map(serialize).join(", ")})`;
    case "rcall":
      return `${wrap(args[1], op)}.${args[0]}(${args[2].map(serialize).join(", ")})`;
    case "list":
      return `[${args.map(serialize).join(", ")}]`;
    case "map":
      return `{${args.map(([k, v]) => `${serialize(k)}: ${serialize(v)}`).join(", ")}}`;
    case "?:":
      return `${wrap(args[0], op)} ? ${wrap(args[1], op)} : ${serialize(args[2])}`;
    default:
      throw new Error(`Unknown AST operation: ${op}`);
  }
}
function serializeString(str) {
  const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\f/g, "\\f").replace(/[\b]/g, "\\b").replace(/\v/g, "\\v");
  let result = "";
  for (let i = 0;i < escaped.length; i++) {
    const code = escaped.charCodeAt(i);
    if (code < 32 || code > 126) {
      result += code <= 65535 ? `\\u${code.toString(16).padStart(4, "0")}` : `\\U${code.toString(16).padStart(8, "0")}`;
    } else {
      result += escaped[i];
    }
  }
  return `"${result}"`;
}
function serializeBytes(bytes) {
  let result = 'b"';
  for (const byte of bytes) {
    if (byte === 92)
      result += "\\\\";
    else if (byte === 34)
      result += "\\\"";
    else if (byte === 10)
      result += "\\n";
    else if (byte === 13)
      result += "\\r";
    else if (byte === 9)
      result += "\\t";
    else if (byte >= 32 && byte <= 126)
      result += String.fromCharCode(byte);
    else
      result += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${result}"`;
}
var PRECEDENCE = {
  "?:": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  in: 5,
  "+": 6,
  "-": 6,
  "-_": 6,
  "*": 7,
  "/": 7,
  "%": 7,
  "!_": 8,
  ".": 9,
  ".?": 9,
  "[]": 9,
  "[?]": 9,
  call: 9,
  rcall: 9
};
function needsParentheses(ast, parentOp) {
  const childOp = ast.op;
  const parentPrec = PRECEDENCE[parentOp] || 0;
  const childPrec = PRECEDENCE[childOp] || 0;
  if (childOp === "value" || childOp === "id" || childOp === "call" || childOp === "rcall" || childOp === "list" || childOp === "map") {
    return false;
  }
  if ((parentOp === "*" || parentOp === "/" || parentOp === "%") && childOp === "-_")
    return false;
  if (parentOp === "*" && childOp === "*" && ast.args[0].op === "-_")
    return false;
  if ((childOp === "." || childOp === "[]" || childOp === ".?" || childOp === "[?]") && (parentOp === "." || parentOp === "[]" || parentOp === ".?" || parentOp === "[?]" || parentOp === "rcall"))
    return false;
  if (parentOp === "?:")
    return childOp === "?:";
  if (parentOp === "!_" || parentOp === "-_")
    return childPrec < parentPrec;
  if (parentOp === "/" && (childOp === "*" || childOp === "+" || childOp === "-"))
    return true;
  if (childOp === "/" && parentOp !== undefined)
    return true;
  if ((parentOp === "*" || parentOp === "/") && ["+", "-", "*", "/"].includes(childOp)) {
    return true;
  }
  if (childPrec < parentPrec)
    return true;
  if (childPrec === parentPrec && (parentOp === "/" || parentOp === "%") && (childOp === "/" || childOp === "%"))
    return true;
  return false;
}
function wrap(ast, parentOp) {
  return needsParentheses(ast, parentOp) ? `(${serialize(ast)})` : serialize(ast);
}

// design/v0.2-custom-rules/node_modules/@marcbachmann/cel-js/lib/index.js
var lib_default = {
  parse,
  evaluate,
  check,
  Environment,
  ParseError,
  EvaluationError,
  TypeError: TypeError2,
  serialize,
  Optional
};
export {
  serialize,
  parse,
  evaluate,
  lib_default as default,
  check,
  TypeError2 as TypeError,
  ParseError,
  Optional,
  EvaluationError,
  Environment
};

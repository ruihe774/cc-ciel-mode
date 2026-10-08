// The CEL environment programs run in: data helpers, and the conversions between
// JSON (what tools return and take) and CEL values. Pure and free of the mods API.
// The host functions (call, tryCall, callEach) are added per run in program.ts.
import { Environment } from './vendor/cel/cel.js'

// ---- JSON <-> CEL ----

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map)

/** JSON data as CEL sees it: whole numbers become ints (bigint), the rest stays. */
export function fromJson(v: unknown): unknown {
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v
  if (Array.isArray(v)) return v.map(fromJson)
  if (isRecord(v)) {
    // A null-prototype copy: no key of a tool's data can reach Object.prototype
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, x] of Object.entries(v)) out[k] = fromJson(x)
    return out
  }
  return v
}

/** A CEL value as JSON data: ints become numbers, maps become objects. */
export function toJson(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(toJson)
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), toJson(x)]))
  if (v instanceof Uint8Array) return Array.from(v)
  if (v && typeof v === 'object' && v.constructor?.name === 'UnsignedInt') return Number((v as { value: bigint }).value)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]))
  return v
}

/** A program's result as the model reads it: a string as it is, anything else as compact JSON. */
export function render(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(toJson(v)) ?? 'null'
}

// ---- Helpers ----

/** The value at a dotted path (`user.login`) of an element, or undefined. */
function at(x: unknown, path: string): unknown {
  for (const k of path.split('.')) {
    if (x instanceof Map) x = x.get(k)
    else if (x && typeof x === 'object' && !Array.isArray(x) && Object.hasOwn(x, k)) x = (x as Record<string, unknown>)[k]
    else return undefined
  }
  return x
}

/** Total order for sort keys of one kind: numbers (int or double), strings, or bools. */
function compare(a: unknown, b: unknown): number {
  const num = (x: unknown) => typeof x === 'bigint' || typeof x === 'number'
  if (num(a) && num(b)) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
  if (typeof a === typeof b && (typeof a === 'string' || typeof a === 'boolean')) return a < (b as string) ? -1 : a > (b as string) ? 1 : 0
  // Missing keys and nulls sort last
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  throw new Error(`cannot compare ${typeName(a)} with ${typeName(b)}`)
}

function typeName(v: unknown): string {
  if (typeof v === 'bigint') return 'int'
  if (typeof v === 'number') return 'double'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'list'
  if (v && typeof v === 'object') return 'map'
  return typeof v
}

/** `-field` sorts descending. */
function sortBy(l: unknown[], key: string): unknown[] {
  const desc = key.startsWith('-')
  const path = desc ? key.slice(1) : key
  return l
    .map((x, i) => [at(x, path), i, x] as const)
    .sort((a, b) => (desc ? compare(b[0], a[0]) : compare(a[0], b[0])) || a[1] - b[1])
    .map(([, , x]) => x)
}

/** Group keys are strings: an int or bool key is spelled as CEL prints it. */
function groupKey(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return 'null'
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
  return JSON.stringify(toJson(v))
}

function groupBy(l: unknown[], key: (x: unknown) => unknown): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>()
  for (const x of l) {
    const k = groupKey(key(x))
    const g = m.get(k)
    if (g) g.push(x)
    else m.set(k, [x])
  }
  return m
}

/** Counts, most frequent first (ties keep first-seen order). */
function countBy(l: unknown[], key: (x: unknown) => unknown): Map<string, bigint> {
  const groups = [...groupBy(l, key)].sort((a, b) => b[1].length - a[1].length)
  return new Map(groups.map(([k, g]) => [k, BigInt(g.length)]))
}

function numbers(l: unknown[], what: string): (bigint | number)[] {
  for (const x of l) if (typeof x !== 'bigint' && typeof x !== 'number') throw new Error(`${what}: not a number: ${typeName(x)}`)
  return l as (bigint | number)[]
}

function sum(l: unknown[]): bigint | number {
  const xs = numbers(l, 'sum')
  if (xs.every((x) => typeof x === 'bigint')) return (xs as bigint[]).reduce((a, b) => a + b, 0n)
  return xs.reduce<number>((a, b) => a + Number(b), 0)
}

function extreme(l: unknown[], what: string, sign: 1 | -1): unknown {
  if (!l.length) throw new Error(`${what}: empty list`)
  return l.reduce((a, b) => (compare(b, a) * sign > 0 ? b : a))
}

function regex(re: string): RegExp {
  try {
    return new RegExp(re, 'g')
  } catch (e) {
    throw new Error(`invalid regex: ${(e as Error).message}`)
  }
}

const jsonParse = (s: string) => {
  try {
    return fromJson(JSON.parse(s))
  } catch (e) {
    throw new Error(`json: ${(e as Error).message}`)
  }
}

// ---- The environment ----

/** Structural limits on a program's statements: generous for data work, tight against abuse. */
export const LIMITS = { maxAstNodes: 5000, maxDepth: 64, maxListElements: 1000, maxMapEntries: 1000, maxCallArguments: 16 }

export const baseEnv = new Environment({ homogeneousAggregateLiterals: false, enableOptionalTypes: true, limits: LIMITS })
  .registerFunction('json(string): dyn', jsonParse)
  .registerFunction('toJson(dyn): string', (v: unknown) => JSON.stringify(toJson(v)) ?? 'null')
  .registerFunction('map.keys(): list<dyn>', (m: unknown) => (m instanceof Map ? [...m.keys()] : Object.keys(m as object)))
  .registerFunction('map.values(): list<dyn>', (m: unknown) => (m instanceof Map ? [...m.values()] : Object.values(m as object)))
  .registerFunction('keys(map): list<dyn>', (m: unknown) => (m instanceof Map ? [...m.keys()] : Object.keys(m as object)))
  .registerFunction('values(map): list<dyn>', (m: unknown) => (m instanceof Map ? [...m.values()] : Object.values(m as object)))
  .registerFunction('map.take(int): map<string, dyn>', (m: unknown, n: bigint) =>
    new Map((m instanceof Map ? [...m] : Object.entries(m as object)).slice(0, Math.max(0, Number(n)))),
  )
  .registerFunction('list.take(int): list<dyn>', (l: unknown[], n: bigint) => l.slice(0, Math.max(0, Number(n))))
  .registerFunction('list.drop(int): list<dyn>', (l: unknown[], n: bigint) => l.slice(Math.max(0, Number(n))))
  .registerFunction('list.reverse(): list<dyn>', (l: unknown[]) => [...l].reverse())
  .registerFunction('list.sort(): list<dyn>', (l: unknown[]) => [...l].sort(compare))
  .registerFunction('list.sortBy(string): list<dyn>', sortBy)
  // The targets of the lambda forms (program.ts desugar): lists of [key, element] pairs
  .registerFunction('list.sortPairs_(): list<dyn>', (l: [unknown, unknown][]) =>
    l
      .map((p, i) => [p, i] as const)
      .sort((a, b) => compare(a[0][0], b[0][0]) || a[1] - b[1])
      .map(([p]) => p[1]),
  )
  .registerFunction('list.groupPairs_(): map<string, list<dyn>>', (l: [unknown, unknown][]) => {
    const m = new Map<string, unknown[]>()
    for (const [k, x] of l) {
      const g = m.get(groupKey(k))
      if (g) g.push(x)
      else m.set(groupKey(k), [x])
    }
    return m
  })
  .registerFunction('list.distinct(): list<dyn>', (l: unknown[]) => {
    const seen = new Set<string>()
    return l.filter((x) => {
      const k = typeof x === 'string' ? `s${x}` : `j${JSON.stringify(toJson(x))}`
      return !seen.has(k) && !!seen.add(k)
    })
  })
  .registerFunction('list.flatten(): list<dyn>', (l: unknown[]) => l.flat())
  .registerFunction('list.groupBy(string): map<string, list<dyn>>', (l: unknown[], k: string) => groupBy(l, (x) => at(x, k)))
  .registerFunction('list.countBy(string): map<string, int>', (l: unknown[], k: string) => countBy(l, (x) => at(x, k)))
  .registerFunction('list.countBy(): map<string, int>', (l: unknown[]) => countBy(l, (x) => x))
  .registerFunction('list.sum(): dyn', sum)
  .registerFunction('list.min(): dyn', (l: unknown[]) => extreme(l, 'min', -1))
  .registerFunction('list.max(): dyn', (l: unknown[]) => extreme(l, 'max', 1))
  .registerFunction('string.replace(string, string): string', (s: string, a: string, b: string) => s.split(a).join(b))
  .registerFunction('string.find(string): string', (s: string, re: string) => s.match(regex(re))?.[0] ?? '')
  .registerFunction('string.findAll(string): list<string>', (s: string, re: string) => s.match(regex(re)) ?? [])
  .registerFunction('string.lines(): list<string>', (s: string) => s.split(/\r?\n/))
  .registerFunction('string.truncate(int): string', (s: string, n: bigint) => {
    const max = Math.max(0, Number(n))
    return s.length > max ? `${s.slice(0, max)}…` : s
  })

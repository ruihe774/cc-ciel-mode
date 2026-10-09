// Programs: `let name = <CEL>` and `var name = <CEL>` statements and a final CEL
// expression, compiled (parsed and type-checked) as a whole before anything runs, then
// run against an injected host that makes the tool calls. A `var` outlives its run in a
// store the caller keeps. Pure and free of the mods API, so it
// can be unit tested; register.ts supplies the host.
import { baseEnv, fromJson, render, toJson } from './stdlib.ts'
import type { Environment } from './vendor/cel/cel.js'

// ---- Parsing: statements from lines ----

export interface Statement {
  line: number // 1-based line the statement starts on
  name?: string // the bound name; absent for the final expression
  kind?: 'let' | 'var' // how it is bound; absent for the final expression
  source: string // the CEL expression
}

const BIND = /^\s*(let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
// A line that starts with one of these continues the statement above it
const LEADING_OP = /^\s*(\.|\?|:|&&|\|\||\+|\*|\/|%|==|!=|<|>|in\s|\]|\)|\})/
// A statement that ends with one of these continues on the next line
const TRAILING_OP = /(\.|\?|:|&&|\|\||\+|-|\*|\/|%|==|!=|<=|>=|<|>|,|\(|\[|\{|\bin)\s*$/

/** Where a line leaves a statement: open brackets, an open triple-quoted string, and the
 *  line without its `//` comment. Strings are skipped so their brackets don't count. */
function scan(line: string, state: { depth: number; triple: string | null }): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (state.triple) {
      const end = line.indexOf(state.triple, i)
      if (end < 0) return out + line.slice(i)
      out += line.slice(i, end + 3)
      i = end + 3
      state.triple = null
      continue
    }
    const c = line[i]!
    if (c === '/' && line[i + 1] === '/') break
    if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) {
        state.triple = c.repeat(3)
        out += state.triple
        i += 3
        continue
      }
      // A one-line string: up to its closing quote, past escapes (raw strings have none
      // that matter here, since \" can't close one either)
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      out += line.slice(i, j + 1)
      i = j + 1
      continue
    }
    if ('([{'.includes(c)) state.depth++
    else if (')]}'.includes(c)) state.depth--
    out += c
    i++
  }
  return out
}

export class ProgramError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`)
  }
}

/** Splits a program into statements. A line starting `let x =` or `var x =` begins a binding;
 *  any other line begins the final expression, unless the statement above is still
 *  open (an open bracket or string, or a trailing operator) or the line starts with
 *  an operator or a `.`, in which case it continues that statement. */
export function parseProgram(text: string): Statement[] {
  const stmts: (Statement & { open: boolean })[] = []
  const state = { depth: 0, triple: null as string | null }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const cur = stmts.at(-1)
    const inside = !!cur && (state.depth > 0 || !!state.triple || cur.open)
    if (!inside && !raw.trim()) continue
    if (!inside && !raw.trim().startsWith('//')) {
      const m = BIND.exec(raw)
      if (m || !cur || !LEADING_OP.test(raw)) {
        if (m && (m[2] === 'let' || m[2] === 'var')) throw new ProgramError(`"${m[2]}" is not a name`, i + 1)
        const body = m ? raw.slice(m[0].length) : raw
        const code = scan(body, state)
        const bind = m ? { name: m[2]!, kind: m[1] as 'let' | 'var' } : {}
        stmts.push({ line: i + 1, ...bind, source: body, open: TRAILING_OP.test(code) || (!!m && !code.trim()) })
        continue
      }
    }
    if (!cur) continue // a comment before the first statement
    const code = scan(raw, state)
    cur.source += '\n' + raw
    if (code.trim()) cur.open = TRAILING_OP.test(code)
  }
  if (!stmts.length) throw new ProgramError('the program is empty')
  stmts.forEach((s, i) => {
    if (!s.source.trim()) throw new ProgramError(`${s.kind} ${s.name} has no expression`, s.line)
    if (s.name === undefined && i < stmts.length - 1)
      throw new ProgramError(
        'only the last statement can be a bare expression; start this one with `let <name> =` (or `var`), or join it to the line above',
        s.line,
      )
  })
  return stmts.map(({ open: _, ...s }) => s)
}

// ---- Lambda forms: sugar over map ----

const LAMBDA = /\.(sortBy|sort|groupBy|countBy)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/y

/** The index just past the bracket that closes the one opened before `from`, skipping
 *  strings; -1 when it never closes. */
function closing(src: string, from: number): number {
  let depth = 1
  for (let i = from; i < src.length; i++) {
    const c = src[i]!
    if (c === '"' || c === "'") {
      const q = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      let j = i + q.length
      while (j < src.length && !src.startsWith(q, j)) j += src[j] === '\\' ? 2 : 1
      i = j + q.length - 1
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) return i + 1
  }
  return -1
}

/** Rewrites the lambda forms of the helpers into map plus the field-less helpers:
 *  `xs.sortBy(x, key)` (or `xs.sort(x, key)`) sorts by a computed key, `xs.groupBy(x, key)` and
 *  `xs.countBy(x, key)` group and count by one. Strings and comments are left alone. */
export function desugar(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '"' || c === "'") {
      const q = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      let j = i + q.length
      while (j < src.length && !src.startsWith(q, j)) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + q.length)
      i = j + q.length
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      out += end < 0 ? src.slice(i) : src.slice(i, end)
      i = end < 0 ? src.length : end
      continue
    }
    LAMBDA.lastIndex = i
    const m = c === '.' ? LAMBDA.exec(src) : null
    if (m) {
      const bodyStart = i + m[0].length
      const end = closing(src, bodyStart)
      if (end > 0) {
        const [, fn, v] = m
        const body = desugar(src.slice(bodyStart, end - 1))
        out += fn === 'countBy' ? `.map(${v}, ${body}).countBy()` : `.map(${v}, [${body}, ${v}]).${fn === 'groupBy' ? 'groupPairs_' : 'sortPairs_'}()`
        i = end
        continue
      }
    }
    out += c
    i++
  }
  return out
}

// ---- Compiling ----

/** Which tools a program may call. */
export type Scope = (tool: string) => boolean

/** The vars kept across a session's programs: at most `max` of them, in memory only. */
export interface VarStore {
  values: Map<string, unknown>
  max: number
}

/** A var's line is `null` and nothing else: it clears the var. */
const clears = (s: Statement) => s.kind === 'var' && s.source.replace(/\/\/.*$/gm, '').trim() === 'null'

export interface Compiled {
  statements: readonly { line: number; name?: string; kind?: 'let' | 'var'; fn: (ctx: Record<string, unknown>) => unknown }[]
  tools: readonly string[] // the tools the program names with string literals, in order
  run: RunState // the state the host functions read, reset by each run
}

interface RunState {
  store: VarStore
  host?: Host
  limits?: Limits
  signal?: AbortSignal
  calls: number
}

export interface Limits {
  maxCalls: number // tool calls per run, across call, tryCall and callEach
  concurrency: number // calls callEach runs at once
}

/** The outcome of one tool call: its text, or why it failed or was refused. */
export type CallOutcome = { ok: true; text: string } | { ok: false; error: string }

export interface Host {
  call(tool: string, args: Record<string, unknown>): Promise<CallOutcome>
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!

// What to do about the mistakes programs make most, added to their errors
const HINTS: [RegExp, string][] = [
  [/Unexpected character: =$|Unexpected token: =/, 'CEL has no assignment or mutation: bind values with `let`, count with .countBy(), group with .groupBy()'],
  [/No such key: (text|content|structuredContent)$/, 'call() already returns the tool output itself, parsed, not content blocks: use the value directly; see its shape with .take(2) or .keys()'],
  [/No such key/, 'for a field that may be missing use has(x.field) or x.?field.orValue(default)'],
  [/overload for '\w+\.(parseJSON|parseJson|toJSON|toJson|json)\(/, 'parse text with json(text), print a value with toJson(value)'],
  [/overload for 'string\((list|map)/, 'print a list or map with toJson(value)'],
  [/Reserved identifier: let/, '`let` only starts a line; inside an expression bind a value with cel.bind(name, value, expression)'],
  [/has\(\) invalid argument/, 'has() takes a field of a name, like has(x.field); bind an element first, e.g. let first = xs[0]'],
  [/Unknown variable: (for|while|if|return|const|function)\b/, 'CEL has no statements but `let` and `var`: use .map/.filter and `cond ? a : b`'],
  [/no matching overload/i, 'check the value types; a value from a tool is dyn, so convert with string(x), int(x) or double(x) where needed'],
]
const withHint = (message: string) => {
  const hint = HINTS.find(([re]) => re.test(message))?.[1]
  return hint ? `${message} (${hint})` : message
}
// String literals passed as a tool name: checked against the scope before anything runs
const LITERAL_TOOL = /\b(?:call|tryCall|callEach)\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g

/** A tool's text as data: JSON when it parses as JSON, else the text itself. */
export function decode(text: string): unknown {
  const t = text.trim()
  if (/^[[{"]|^-?\d|^(true|false|null)$/.test(t)) {
    try {
      return fromJson(JSON.parse(t))
    } catch {}
  }
  return text
}

// Keys of a tool.call input that are the engine's, not the tool's: `consent` would speak
// for the user to the permission check, so a program may set none of them
export const RESERVED_ARGS = ['tool', 'tool_use_id', 'consent', 'requestMeta', 'agentId']

function toArgs(v: unknown, tool: string): Record<string, unknown> {
  const args = toJson(v)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: arguments must be a map`)
  const reserved = RESERVED_ARGS.filter((k) => Object.hasOwn(args, k))
  if (reserved.length) throw new Error(`${tool}: ${reserved.join(', ')} cannot be passed as an argument`)
  return args as Record<string, unknown>
}

/** One tool call: counted, scoped, and abortable. */
async function invoke(st: RunState, scope: Scope, tool: string, args: unknown): Promise<CallOutcome> {
  const { host, limits, signal } = st
  if (!host || !limits) throw new Error('the program is not running')
  if (signal?.aborted) throw new Error('interrupted')
  if (!scope(tool)) throw new Error(`${tool} is not a tool this program may call`)
  if (++st.calls > limits.maxCalls) throw new Error(`more than ${limits.maxCalls} tool calls in one run`)
  return host.call(tool, toArgs(args, tool))
}

async function callOrThrow(st: RunState, scope: Scope, tool: string, args: unknown): Promise<unknown> {
  const r = await invoke(st, scope, tool, args)
  if (!r.ok) throw new Error(`${tool} failed: ${r.error}`)
  return decode(r.text)
}

/** Runs `fn` over `items`, at most `n` at a time, keeping their order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new Error('interrupted')
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
  return out
}

/** The base environment plus the host functions, bound to one compiled program's run state. */
function programEnv(st: RunState, scope: Scope): Environment {
  return baseEnv
    .clone()
    .registerFunction('call(string, map<string, dyn>): dyn', (tool: string, args: unknown) => callOrThrow(st, scope, tool, args))
    .registerFunction('vars(): list<string>', () => [...st.store.values.keys()].sort())
    .registerFunction('call(string): dyn', (tool: string) => callOrThrow(st, scope, tool, new Map()))
    .registerFunction('tryCall(string, map<string, dyn>): map<string, dyn>', async (tool: string, args: unknown) => {
      const r = await invoke(st, scope, tool, args)
      return new Map<string, unknown>(r.ok ? [['ok', true], ['value', decode(r.text)], ['error', '']] : [['ok', false], ['value', null], ['error', r.error]])
    })
    .registerFunction('callEach(string, list): list<dyn>', async (tool: string, argsList: unknown[]) => {
      // Every call's scope and the call budget are checked before the first one starts
      if (!scope(tool)) throw new Error(`${tool} is not a tool this program may call`)
      const limits = st.limits!
      if (st.calls + argsList.length > limits.maxCalls)
        throw new Error(`callEach would make ${argsList.length} calls; with ${st.calls} made, that is more than ${limits.maxCalls} in one run`)
      return pool(argsList, limits.concurrency, (a) => callOrThrow(st, scope, tool, a), st.signal)
    })
}

/** What a program's vars will be once it runs, checked against the cap before it does. */
function checkVars(stmts: readonly Statement[], store: VarStore) {
  const names = new Set(store.values.keys())
  for (const s of stmts) {
    if (s.kind !== 'var') continue
    if (clears(s)) names.delete(s.name!)
    else names.add(s.name!)
    if (names.size > store.max)
      throw new ProgramError(
        store.max === 0
          ? 'var is turned off (max_vars is 0); use let'
          : `more than ${store.max} vars would be kept (kept now: ${[...store.values.keys()].join(', ') || 'none'}); clear one with \`var <name> = null\`, or use let`,
        s.line,
      )
  }
}

/** The hint for an unknown name: the vars there are, when there are any. */
function varsHint(message: string, store: VarStore): string {
  if (!/Unknown variable/.test(message) || /\(/.test(message) || store.max === 0) return message
  const kept = [...store.values.keys()]
  return kept.length ? `${message} (vars kept from earlier programs: ${kept.sort().join(', ')})` : `${message} (no vars are kept: a \`let\` lasts one program, a \`var\` the session)`
}

/** Parses and type-checks a whole program, so a mistake costs no tool calls. `store`
 *  holds the vars earlier programs kept; they are bound here as dyn. */
export function compileProgram(text: string, scope: Scope, store: VarStore = { values: new Map(), max: 0 }): Compiled {
  const stmts = parseProgram(text)
  const run: RunState = { store, calls: 0 }
  const env = programEnv(run, scope)
  for (const name of store.values.keys()) env.registerVariable(name, 'dyn')
  const statements: Compiled['statements'][number][] = []
  const tools = new Set<string>()
  const bound = new Set<string>() // names this program binds
  for (const s of stmts) {
    for (const m of s.source.matchAll(LITERAL_TOOL)) {
      const tool = m[1] ?? m[2]!
      if (!scope(tool)) throw new ProgramError(`${tool} is not a tool this program may call (see the tools tool)`, s.line)
      tools.add(tool)
    }
    if (s.name !== undefined) {
      const kept = store.values.has(s.name) && !bound.has(s.name)
      // A var may replace one an earlier program kept; any other name is bound once
      if (!IDENT.test(s.name) || (env.hasVariable(s.name) && !(kept && s.kind === 'var')))
        throw new ProgramError(
          kept ? `"${s.name}" is a var from an earlier program; use another name, or \`var ${s.name} = ...\` to replace it` : `"${s.name}" is already bound`,
          s.line,
        )
    }
    const source = desugar(s.source)
    const res = env.check(source)
    if (!res.valid) throw new ProgramError(varsHint(withHint(firstLine(res.error)), store), s.line)
    let fn: (ctx: Record<string, unknown>) => unknown
    try {
      fn = env.parse(source) as unknown as typeof fn
    } catch (e) {
      throw new ProgramError(withHint(firstLine(e)), s.line)
    }
    if (s.name !== undefined) {
      bound.add(s.name)
      // A var is dyn, as it will be in later programs; a cleared one isn't bound at all
      if (!env.hasVariable(s.name) && !clears(s)) env.registerVariable(s.name, s.kind === 'var' ? 'dyn' : String(res.type))
    }
    statements.push({ line: s.line, ...(s.name === undefined ? {} : { name: s.name, kind: s.kind! }), fn })
  }
  checkVars(stmts, store)
  return { statements, tools: [...tools], run }
}

// ---- Running ----

export type RunResult = { ok: true; output: string; calls: number } | { ok: false; error: string; calls: number }

export interface RunOptions extends Limits {
  maxOutput: number // characters of the rendered result
  signal?: AbortSignal
  /** The session's vars; without it a `var` is refused, as with a cap of 0. */
  vars?: VarStore
  /** Asked once the program compiles, before its first call, with the tools it names:
   *  resolves to null to run it, or to why it may not run. */
  approve?: (tools: readonly string[]) => Promise<string | null>
}

/** Cuts a result to `max` characters, saying how much was left out. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated: ${text.length} characters in all; return less, e.g. with .take(n), .map() to fewer fields, or .truncate(n)]`
}

/** Compiles and runs a program. Every failure, whether compiling, a tool, a
 *  limit or an interrupt, is a result, never a throw. */
export async function runProgram(text: string, scope: Scope, host: Host, opts: RunOptions): Promise<RunResult> {
  let compiled: Compiled
  try {
    compiled = compileProgram(text, scope, opts.vars)
  } catch (e) {
    return { ok: false, error: e instanceof ProgramError ? e.message : `the program does not compile: ${firstLine(e)}`, calls: 0 }
  }
  if (opts.approve) {
    const refused = await opts.approve(compiled.tools)
    if (refused !== null) return { ok: false, error: refused, calls: 0 }
  }
  const st = compiled.run
  Object.assign(st, { host, limits: { maxCalls: opts.maxCalls, concurrency: opts.concurrency }, signal: opts.signal, calls: 0 })
  const store = st.store
  const vars: Record<string, unknown> = Object.fromEntries(store.values)
  let value: unknown
  for (const s of compiled.statements) {
    try {
      value = await s.fn(vars)
    } catch (e) {
      const where = s.name === undefined ? `line ${s.line}` : `line ${s.line} (${s.kind} ${s.name})`
      return { ok: false, error: `${where}: ${withHint(firstLine(e))}`, calls: st.calls }
    }
    if (s.name === undefined) continue
    if (s.kind === 'let') vars[s.name] = value
    // A var is kept as soon as its line runs, so a later failure doesn't lose it; null clears it
    else if (value === null) {
      store.values.delete(s.name)
      delete vars[s.name]
    } else if (!store.values.has(s.name) && store.values.size >= store.max) {
      return { ok: false, error: `line ${s.line} (var ${s.name}): more than ${store.max} vars would be kept; clear one with \`var <name> = null\``, calls: st.calls }
    } else {
      store.values.set(s.name, value)
      vars[s.name] = value
    }
  }
  return { ok: true, output: truncate(render(value), opts.maxOutput), calls: st.calls }
}

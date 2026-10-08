// code-mode: the model writes a small CEL program that calls tools, filters and joins
// their results, and returns only what it needs. Programs run in a sandbox (CEL can
// reach nothing but the functions program.ts gives it); every tool call goes back
// through $.tool.call, so permission checks and other mods' hooks still apply.
import { OWN_PREFIX, PLUGIN, index, scopeOf, scopeText } from './catalog.ts'
import { runProgram, type CallOutcome, type RunResult } from './program.ts'
import { spilledFile, spilledText } from './spill.ts'

const RUN = 'run'
const TOOLS = 'tools'

function runDescription(scope: string, maxOutput: number): string {
  return `Run a small program that calls tools and returns only its result, so big tool outputs never reach you. Prefer it to calling a tool directly when the output may be large (lists, search results, big JSON) and you need only part of it, when you would make many similar calls, or when you need to count, rank or join results.

Do the whole job in one program when you can (fetch, filter, rank, fan out to more calls, aggregate) and return just the answer: the result goes into your context, so aim for a few hundred characters, not raw records.

A program is sandboxed CEL (Common Expression Language): \`let <name> = <expression>\` lines, then one last expression, the result (a string as it is, anything else as compact JSON). An expression can span lines while a bracket is open or a line starts with \`.\`. \`//\` comments. CEL has no assignment, mutation or loops: every value is a \`let\` or an expression built with .map/.filter and the helpers below.

Calling tools (each call goes through the usual permission checks):
- \`call("<tool>", {"arg": value})\` returns the tool's output itself as data: its JSON parsed (a list, a map, ...), else its text. Never content blocks or a "saved to a file" notice: output of any size arrives whole inside the program. A failed call stops the program.
- \`tryCall("<tool>", {...})\` returns \`{"ok": bool, "value": output, "error": text}\` and never stops the program.
- \`callEach("<tool>", [{...}, {...}])\` makes one call per argument map, in parallel; outputs in order.
Callable: ${scope} (${OWN_PREFIX}${TOOLS} lists them). Use the argument names of the tool's input schema; if you don't have it, load it with ToolSearch ("select:<tool>").

Recipes:
- Don't call a big tool directly just to see its output; see its shape from a program: \`call("<tool>", {...}).take(2)\`, \`call(...).keys()\` for a map, or \`toJson(x).truncate(500)\`
- Count and rank: \`items.map(i, i.labels).flatten().countBy()\` gives \`{"docs": 24, "ui": 19, ...}\`, most frequent first; \`items.countBy(i, i.author)\` counts by a key
- Top N: \`items.sortBy(i, -i.comments).take(5).map(i, {"n": i.number, "title": i.title})\`
- Fan out: \`callEach("<tool>", ids.map(id, {"id": id})).map(r, r.title)\`
- Several answers at once: return a map, \`{"count": size(xs), "top": ...}\`

CEL reference:
- Operators \`== != < <= > >= && || ! ?: in + - * / %\` (\`+\` joins strings and lists), \`size(x)\`, \`string(x) int(x) double(x)\`, literals \`[1, 2]\` \`{"k": v}\`, \`cel.bind(name, value, expr)\` to name a value inside an expression. Whole numbers are ints: \`1\`, not \`1.0\`.
- Lists: \`.filter(x, cond)\` \`.map(x, expr)\` \`.map(x, cond, expr)\` \`.exists(x, cond)\` \`.all(x, cond)\` \`.exists_one(x, cond)\` \`l[0]\` \`.join(sep)\`, and \`.take(n) .drop(n) .reverse() .sort() .distinct() .flatten() .sum() .min() .max()\`, and with a key computed per element: \`.sortBy(x, key)\` (ascending; \`-key\` for descending numbers, else add \`.reverse()\`) \`.groupBy(x, key)\` (a map of key to elements) \`.countBy(x, key)\` (a map of key to count, most frequent first) \`.countBy()\` (counts the elements themselves). A field name works as the key too: \`.sortBy("updated_at")\`, \`.sortBy("-comments")\`, \`.countBy("user.login")\`
- Maps: \`m.key\` \`m["key"]\` \`m.keys()\` \`m.values()\` \`m.take(n)\` (first n entries, e.g. of a countBy); a missing key is an error, so for optional fields use \`has(m.key)\` or \`m.?key.orValue(default)\`
- Strings: \`.contains .startsWith .endsWith .matches(re) .lowerAscii() .upperAscii() .trim() .split(sep) .substring(i, j) .indexOf(s) .replace(old, new) .find(re) .findAll(re) .lines() .truncate(n)\`; \`json(text)\` parses, \`toJson(value)\` prints

Example (one program: list, filter, count, then fetch details of the top 3 in parallel):
let issues = call("mcp__github__list_issues", {"owner": "o", "repo": "r", "state": "open"})
let stale = issues.filter(i, i.updated_at < "2026-01-01")
let top = stale.sortBy(i, -i.comments).take(3)
let details = callEach("mcp__github__get_issue", top.map(i, {"owner": "o", "repo": "r", "issue_number": i.number}))
{"stale": size(stale), "labels": stale.map(i, i.labels.map(l, l.name)).flatten().countBy().take(5), "top": details.map(d, {"n": d.number, "assignee": d.?assignee.?login.orValue("none")})}

Results over ${maxOutput} characters are cut.`
}

/** One tool call from a program, through every hook and the permission check. */
async function callTool($: any, tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
  let r: any
  try {
    r = await $.tool.call({ ...args, tool })
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
  if (typeof r?.deny === 'string') return { ok: false, error: `refused: ${r.deny}` }
  const text = typeof r?.text === 'string' ? r.text : typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? null)
  if (r?.isError === true) return { ok: false, error: text }
  // Output over Claude Code's size limit comes back as a notice naming the file it was saved to
  const file = spilledFile(text, await configDir($))
  if (file === undefined) return { ok: true, text }
  try {
    return { ok: true, text: spilledText(file, await $.fs.read(file)) }
  } catch (e) {
    return { ok: false, error: `the output was too large and could not be read back from ${file}: ${String((e as Error)?.message ?? e)}` }
  }
}

/** Claude Code's config dir, where it saves oversized tool results. */
async function configDir($: any): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  return `${((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, '')}/.claude`
}

/** Runs a program with this session's settings. */
async function run($: any, program: unknown, options: Settings, signal?: AbortSignal): Promise<RunResult> {
  if (typeof program !== 'string' || !program.trim()) return { ok: false, error: 'program is required', calls: 0 }
  const host = { call: (tool: string, args: Record<string, unknown>) => callTool($, tool, args) }
  return runProgram(program, options.scope, host, { ...options, signal })
}

interface Settings {
  pattern?: string
  scope: (tool: string) => boolean
  denyDirect: boolean
  maxCalls: number
  concurrency: number
  maxOutput: number
}

const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback)

export function settings(options: Record<string, unknown> | undefined): Settings {
  const pattern = typeof options?.tools === 'string' ? options.tools : undefined
  return {
    pattern,
    scope: scopeOf(pattern),
    denyDirect: options?.deny_direct === true,
    maxCalls: positive(options?.max_calls, 100),
    concurrency: positive(options?.concurrency, 8),
    maxOutput: positive(options?.max_output, 20000),
  }
}

export function register(on: any, options?: Record<string, unknown>) {
  const s = settings(options)

  on('session.start', async ($: any, e: any, next: any) => {
    await $.tool.register({
      name: RUN,
      description: runDescription(scopeText(s.pattern), s.maxOutput),
      inputSchema: {
        type: 'object',
        properties: { program: { type: 'string', description: 'The program: `let` lines, then the result expression' } },
        required: ['program'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: TOOLS,
      description: `List the tools a ${OWN_PREFIX}${RUN} program can call, one line each. \`query\` narrows the list (a case-insensitive regex over names and descriptions).`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional filter, e.g. "github|issue"' } } },
      isDeferred: false,
    })
    await $.command.register({ name: PLUGIN, description: 'Run a code-mode program yourself: `let` lines, then the result expression', argumentHint: '<program>' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__code-mode__run' }, async ($: any, e: any, next: any) => {
    const r = await run($, e.program, s, next.signal)
    return r.ok ? { result: r.output } : { isError: true, result: `Error: ${r.error}` }
  }).catch(async ($: any, e: any, next: any) => ({ isError: true, result: `Error: the program was stopped (${next.error.kind}: ${next.error.message})` }))

  on('tool.call', { tool: 'mcp__code-mode__tools' }, async ($: any, e: any) => {
    return { result: index(await $.tool.list(), s.scope, typeof e.query === 'string' ? e.query : undefined) }
  })

  // Opt-in: the model's own calls to callable MCP tools are turned away to a program.
  // The calls a program makes are this plugin's, and pass.
  on('tool.call', { tool: /^mcp__/ }, async ($: any, e: any, next: any) => {
    if (!s.denyDirect || next.origin?.plugin === PLUGIN || e.tool.startsWith(OWN_PREFIX) || !s.scope(e.tool)) return next(e)
    return {
      deny: `Call ${e.tool} from a program instead: ${OWN_PREFIX}${RUN} with \`call("${e.tool}", {...})\`, returning only what you need.`,
    }
  })

  on('command.run', { command: 'code-mode' }, async ($: any, e: any, next: any) => {
    const r = await run($, e.args, s, next.signal)
    return r.ok ? { text: r.output } : { text: `Error: ${r.error}`, exitCode: 1 }
  })
}

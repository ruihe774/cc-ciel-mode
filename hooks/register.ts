// code-mode: the model writes a small CEL program that calls tools, filters and joins
// their results, and returns only what it needs. Programs run in a sandbox (CEL can
// reach nothing but the functions program.ts gives it); every tool call goes back
// through $.tool.call, so permission checks and other mods' hooks still apply.
import { APPROVE, DECLINE, Pending, approvalQuestion, callKey, unapprovedReason } from './approval.ts'
import { OWN_PREFIX, PLUGIN, alwaysOf, index, scopeOf, scopeText } from './catalog.ts'
import { runProgram, type CallOutcome, type RunResult } from './program.ts'
import { spilledFile, spilledText } from './spill.ts'

const RUN = 'run'
const TOOLS = 'tools'

// Claude Code passes a registered tool's description to the model up to its first 2048
// characters, so the description says what the tool is for and the language reference
// goes in the description of its `program` parameter.
export function runDescription(scope: string, maxOutput: number): string {
  return `Run a small program that calls tools and returns only its result, so big tool outputs never reach you. Prefer it to calling a tool directly when the output may be large (lists, search results, big JSON) and you need only part of it, when you would make many similar calls, or when you need to count, rank or join results. Do the whole job in one program when you can (fetch, filter, rank, fan out, aggregate) and return just the answer, a few hundred characters, not raw records.

A program is sandboxed CEL: \`let <name> = <expression>\` lines, then a last expression, the result. CEL has no assignment, mutation or loops; build values with .map/.filter and the helpers. The \`program\` parameter's description has the full reference: read it before writing one.

- \`call("<tool>", {"arg": value})\` returns the tool's output as data (JSON parsed, else text; never content blocks or a "saved to a file" notice, whatever its size). A failed call stops the program.
- \`tryCall("<tool>", {...})\` returns \`{"ok", "value", "error"}\` and never stops it.
- \`callEach("<tool>", [{...}, ...])\` calls in parallel; outputs in order.
Callable: ${scope} (${OWN_PREFIX}${TOOLS} lists them). Use argument names from the tool's input schema; load it with ToolSearch ("select:<tool>") if you lack it. Name tools with string literals: before the program runs, the user approves the ones that need approval, and a call to a tool named any other way that needs approval is refused.

Example:
let issues = call("mcp__github__list_issues", {"owner": "o", "repo": "r", "state": "open"})
let stale = issues.filter(i, i.updated_at < "2026-01-01")
{"stale": size(stale), "labels": stale.map(i, i.labels.map(l, l.name)).flatten().countBy().take(5), "oldest": stale.sortBy(i, i.updated_at).take(3).map(i, i.number)}

Results over ${maxOutput} characters are cut.`
}

/** The language reference, as the description of the `program` parameter. */
export const PROGRAM_REFERENCE = `The program: \`let <name> = <expression>\` lines, then the result expression (a string as it is, anything else as compact JSON). An expression continues onto the next lines while a bracket is open or a line starts with \`.\` or an operator. \`//\` comments.

Recipes:
- See an output's shape (don't call a big tool directly for that): \`call("<tool>", {...}).take(2)\`, \`call(...).keys()\` for a map, \`toJson(x).truncate(500)\`
- Count and rank: \`items.map(i, i.labels).flatten().countBy()\` gives \`{"docs": 24, "ui": 19}\`, most frequent first; \`items.countBy(i, i.author)\` counts by a key
- Top N: \`items.sortBy(i, -i.comments).take(5).map(i, {"n": i.number, "title": i.title})\`
- Fan out: \`callEach("<tool>", ids.map(id, {"id": id})).map(r, r.title)\`
- Several answers at once: return a map, \`{"count": size(xs), "top": ...}\`

CEL reference:
- Operators \`== != < <= > >= && || ! ?: in + - * / %\` (\`+\` joins strings and lists), \`size(x)\`, \`string(x) int(x) double(x)\`, literals \`[1, 2]\` \`{"k": v}\`, \`cel.bind(name, value, expr)\` to name a value inside an expression. Whole numbers are ints: \`1\`, not \`1.0\`.
- Lists: \`.filter(x, cond)\` \`.map(x, expr)\` \`.map(x, cond, expr)\` \`.exists(x, cond)\` \`.all(x, cond)\` \`.exists_one(x, cond)\` \`l[0]\` \`.join(sep)\` \`.take(n) .drop(n) .reverse() .sort() .distinct() .flatten() .sum() .min() .max()\`, and with a key per element: \`.sortBy(x, key)\` (ascending; \`-key\` for descending numbers, else add \`.reverse()\`), \`.groupBy(x, key)\` (key to elements), \`.countBy(x, key)\` (key to count, most frequent first), \`.countBy()\` (counts the elements). A field name works as the key: \`.sortBy("updated_at")\`, \`.sortBy("-comments")\`, \`.countBy("user.login")\`
- Maps: \`m.key\` \`m["key"]\` \`m.keys()\` \`m.values()\` \`m.take(n)\` (first n entries); a missing key is an error, so for optional fields use \`has(m.key)\` or \`m.?key.orValue(default)\`
- Strings: \`.contains .startsWith .endsWith .matches(re) .lowerAscii() .upperAscii() .trim() .split(sep) .substring(i, j) .indexOf(s) .replace(old, new) .find(re) .findAll(re) .lines() .truncate(n)\`; \`json(text)\` parses, \`toJson(value)\` prints

Example, fetching details of the top 3 in parallel:
let top = call("mcp__github__list_issues", {"owner": "o", "repo": "r"}).sortBy(i, -i.comments).take(3)
let details = callEach("mcp__github__get_issue", top.map(i, {"owner": "o", "repo": "r", "issue_number": i.number}))
details.map(d, {"n": d.number, "assignee": d.?assignee.?login.orValue("none")})`

// Programs' calls on their way to tool.check, and among them the calls of approved tools,
// whose `ask` becomes `allow`. code-mode's other calls (the approval dialog) aren't in them.
const inFlight = new Pending()
const approvedCalls = new Pending()

/** One tool call from a program, through every hook and the permission check. A call
 *  of an approved tool is marked, so tool.check lets it run. */
async function callTool($: any, tool: string, args: Record<string, unknown>, approved: boolean): Promise<CallOutcome> {
  let r: any
  const key = callKey(tool, args)
  inFlight.add(key)
  if (approved) approvedCalls.add(key)
  try {
    r = await $.tool.call({ ...args, tool })
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    inFlight.delete(key)
    if (approved) approvedCalls.delete(key)
  }
  if (typeof r?.deny === 'string') return { ok: false, error: `refused: ${r.deny}` }
  const text = typeof r?.text === 'string' ? r.text : typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? null)
  if (r?.isError === true) return { ok: false, error: text }
  // Output over Claude Code's size limit comes back as a notice naming the file it was saved to
  const file = spilledFile(text, await configDir($), await $.session.id())
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

/** The tools among `tools` whose calls need the user's approval: those the permission
 *  rules would ask about, and that `always_allow` doesn't cover. */
async function needingApproval($: any, tools: readonly string[], options: Settings): Promise<string[]> {
  const out: string[] = []
  for (const tool of tools) {
    if (options.always(tool)) continue
    let decision = 'ask'
    try {
      decision = (await $.tool.check({ tool, input: {} })).decision
    } catch {}
    if (decision === 'ask') out.push(tool)
  }
  return out
}

/** Runs a program with this session's settings. Before its first call, the user approves
 *  the tools it names that need approval: in a dialog, or by having typed the program
 *  (`byUser`, /code-mode). */
async function run($: any, program: unknown, options: Settings, signal: AbortSignal | undefined, byUser: boolean): Promise<RunResult> {
  if (typeof program !== 'string' || !program.trim()) return { ok: false, error: 'program is required', calls: 0 }
  const approved = new Set<string>()
  const approve = async (tools: readonly string[]): Promise<string | null> => {
    const ask = await needingApproval($, tools, options)
    if (ask.length && !byUser) {
      let answer = ''
      try {
        answer = await $.ui.ask(approvalQuestion(ask), { options: [APPROVE, DECLINE], header: 'code-mode' })
      } catch {
        return `the user's approval is needed to call ${ask.join(', ')}, and none was given (the dialog was dismissed, or no one can be asked). Call ${ask.length === 1 ? 'it' : 'them'} directly instead.`
      }
      if (answer !== APPROVE) return `the user declined to run this program${answer && answer !== DECLINE ? `: ${answer}` : ''}`
    }
    for (const tool of ask) approved.add(tool)
    return null
  }
  const host = { call: (tool: string, args: Record<string, unknown>) => callTool($, tool, args, approved.has(tool) || options.always(tool)) }
  return runProgram(program, options.scope, host, { ...options, signal, approve })
}

interface Settings {
  pattern?: string
  scope: (tool: string) => boolean
  always: (tool: string) => boolean
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
    always: alwaysOf(typeof options?.always_allow === 'string' ? options.always_allow : undefined),
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
        properties: { program: { type: 'string', description: PROGRAM_REFERENCE } },
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
    const r = await run($, e.program, s, next.signal, false)
    return r.ok ? { result: r.output } : { isError: true, result: `Error: ${r.error}` }
  }).catch(async ($: any, e: any, next: any) => ({ isError: true, result: `Error: the program was stopped (${next.error.kind}: ${next.error.message})` }))

  on('tool.call', { tool: 'mcp__code-mode__tools' }, async ($: any, e: any) => {
    return { result: index(await $.tool.list(), s.scope, typeof e.query === 'string' ? e.query : undefined) }
  })

  // A program's call that the permission rules would ask about runs only when its tool was
  // approved for the program (or is always allowed). Claude Code doesn't put a plugin's
  // call to the auto-mode classifier, so without this it would run unasked in auto mode.
  on('tool.check', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (next.origin?.plugin !== PLUGIN || !e.tool_use_id || r?.decision !== 'ask') return r
    const key = callKey(e.tool, e.input)
    if (!inFlight.has(key)) return r
    if (approvedCalls.has(key)) return { ...r, decision: 'allow', reason: `approved for this code-mode program` }
    return { decision: 'deny', reason: unapprovedReason(e.tool) }
  }).catch(async ($: any, e: any, next: any) => ({ decision: 'deny', reason: `code-mode could not check this call (${next.error.message})` }))

  // Opt-in: the model's own calls to callable MCP tools are turned away to a program.
  // The calls a program makes are this plugin's, and pass.
  on('tool.call', { tool: /^mcp__/ }, async ($: any, e: any, next: any) => {
    if (!s.denyDirect || next.origin?.plugin === PLUGIN || e.tool.startsWith(OWN_PREFIX) || !s.scope(e.tool)) return next(e)
    return {
      deny: `Call ${e.tool} from a program instead: ${OWN_PREFIX}${RUN} with \`call("${e.tool}", {...})\`, returning only what you need.`,
    }
  })

  on('command.run', { command: 'code-mode' }, async ($: any, e: any, next: any) => {
    const r = await run($, e.args, s, next.signal, true)
    return r.ok ? { text: r.output } : { text: `Error: ${r.error}`, exitCode: 1 }
  })
}

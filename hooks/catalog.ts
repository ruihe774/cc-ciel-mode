// Which tools a program may call, and the one-line index the `tools` tool shows.
// Pure and free of the mods API, so it can be unit tested.
import type { Scope } from './program.ts'

export const PLUGIN = 'ciel-mode'
export const OWN_PREFIX = `mcp__${PLUGIN}__`
export const DEFAULT_TOOLS = '^(mcp__.+|Read|Glob|Grep|WebFetch|WebSearch)$'

/** The scope a `tools` pattern (a regex over full tool names) allows. This mod's own
 *  tools are never in it, so a program can't start another program. */
export function scopeOf(pattern: string | undefined): Scope {
  let re: RegExp
  try {
    re = new RegExp(pattern?.trim() || DEFAULT_TOOLS)
  } catch {
    // A broken pattern in the settings allows nothing, rather than everything
    return () => false
  }
  return (tool) => !tool.startsWith(OWN_PREFIX) && re.test(tool)
}

/** The tools a program may call without asking the user (`always_allow`, a regex over
 *  full tool names): none when it is empty or broken. */
export function alwaysOf(pattern: string | undefined): (tool: string) => boolean {
  const p = pattern?.trim()
  if (!p) return () => false
  try {
    const re = new RegExp(p)
    return (tool) => re.test(tool)
  } catch {
    return () => false
  }
}

/** Plain-language list of what a scope covers, for the tool descriptions. */
export function scopeText(pattern: string | undefined): string {
  const p = pattern?.trim()
  return !p || p === DEFAULT_TOOLS ? 'MCP tools, and Read, Glob, Grep, WebFetch and WebSearch' : `tools whose names match /${p}/`
}

export interface ToolInfo {
  name: string
  description: string
  mcp: boolean
}

const firstLine = (s: string) => s.trim().split(/\n/)[0]!.trim()
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One line per callable tool that matches `query` (a case-insensitive regex, or plain
 *  text when it isn't one), matched against the name and description. */
export function index(tools: readonly ToolInfo[], scope: Scope, query?: string): string {
  let match: (t: ToolInfo) => boolean = () => true
  const q = query?.trim()
  if (q) {
    let re: RegExp
    try {
      re = new RegExp(q, 'i')
    } catch {
      re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    match = (t) => re.test(t.name) || re.test(t.description)
  }
  const lines = tools.filter((t) => scope(t.name) && match(t)).map((t) => `${t.name}: ${cut(firstLine(t.description), 140)}`)
  if (!lines.length) return q ? `No callable tool matches ${JSON.stringify(q)}.` : 'No callable tools.'
  return `${lines.join('\n')}\n\nLoad a tool's full description and input schema with ToolSearch ("select:<name>") before calling it with arguments you are unsure of.`
}

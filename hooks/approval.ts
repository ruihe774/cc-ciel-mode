// Approval of a program's calls. Claude Code skips the auto-mode classifier for a call a
// plugin raises and lets it run, so ciel-mode decides such calls itself: a call whose
// permission decision is `ask` runs only when the user approved its tool for this
// program, in one dialog before the program starts, or allows it always (`always_allow`).
// Every other `ask` is refused. Pure and free of the mods API; register.ts asks and checks.

/** JSON with keys in a fixed order, so equal inputs give equal text. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** One call, as the program makes it and as `tool.check` sees it. */
export const callKey = (tool: string, input: unknown) => `${tool}\u0000${stableJson(input ?? {})}`

/** The calls of approved tools that are on their way to `tool.check`, counted, so two
 *  identical calls in flight are two entries. */
export class Pending {
  private readonly counts = new Map<string, number>()
  add(key: string) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }
  delete(key: string) {
    const n = (this.counts.get(key) ?? 0) - 1
    if (n > 0) this.counts.set(key, n)
    else this.counts.delete(key)
  }
  has(key: string) {
    return this.counts.has(key)
  }
}

/** The question of the approval dialog. */
export function approvalQuestion(tools: readonly string[]): string {
  return `A ciel-mode program wants to call ${tools.length === 1 ? 'this tool, which needs' : 'these tools, which need'} your approval: ${tools.join(', ')}. Let this program call ${tools.length === 1 ? 'it' : 'them'} with any arguments?`
}

export const APPROVE = 'Run the program'
export const DECLINE = "Don't run it"

/** What Claude reads when a call needing approval was not approved before the program ran. */
export function unapprovedReason(tool: string): string {
  return `${tool} needs approval, and a running program can't ask for it. Name the tool with a string literal (call("${tool}", ...)) so it is approved before the program starts, or call it directly.`
}

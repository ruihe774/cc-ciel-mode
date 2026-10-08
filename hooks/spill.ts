// Claude Code keeps a tool result that is over a size limit out of the
// conversation: it saves the output to a file and hands back a notice naming
// the file. A program wants the data, so the host reads that file instead.
// Pure and free of the mods API; register.ts does the read.

// Two notices name the file: one for MCP output over its token limit (plain text
// saved), one for any result over the size kept inline (the result's blocks as JSON)
const NOTICES = [
  /^(?:Error: )?result \([\d,]+ characters[^)]*\) exceeds maximum allowed tokens\. Output has been saved to (\/[^\n]+?)\.\n/,
  /^<persisted-output>\nOutput too large \([^)\n]*\)\. Full output saved to: (\/[^\n]+)\n/,
]

/** The file a spill notice names, when `text` is one and the file is where Claude Code
 *  keeps spilled results: a tool-results folder of a session under
 *  `<configDir>/projects/`. A tool can't point the host at any other file by returning
 *  text that looks like a notice. */
export function spilledFile(text: string, configDir: string): string | undefined {
  let path: string | undefined
  for (const re of NOTICES) path ??= re.exec(text)?.[1]
  if (!path) return undefined
  const projects = `${configDir.replace(/\/+$/, '')}/projects/`
  if (!path.startsWith(projects) || path.split('/').some((p) => p === '..' || p === '.')) return undefined
  const rest = path.slice(projects.length).split('/')
  // <project>/<session>/tool-results/<file>
  if (rest.length !== 4 || rest[2] !== 'tool-results' || rest.some((p) => !p)) return undefined
  return path
}

/** A spilled file's content as the tool's text: a saved list of content blocks is
 *  joined back into the text the model would have read. */
export function spilledText(path: string, content: string): string {
  if (!path.endsWith('.json')) return content
  let blocks: unknown
  try {
    blocks = JSON.parse(content)
  } catch {
    return content
  }
  const isText = (b: unknown): b is { type: 'text'; text: string } =>
    !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
  if (!Array.isArray(blocks) || !blocks.length || !blocks.every((b) => !!b && typeof b === 'object' && 'type' in b)) return content
  return blocks.filter(isText).map((b) => b.text).join('\n')
}

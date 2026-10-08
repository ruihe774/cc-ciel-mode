#!/usr/bin/env node
// A stdio MCP server with no dependencies, serving deterministic data for code-mode's tests.
// MOCK_EXTRA_TOOLS=N adds N filler tools, enough to make Claude Code defer MCP tools.
import { createInterface } from 'node:readline'

// ---- Data: 300 issues from a seeded generator, so every run sees the same values ----

let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
const LABELS = ['bug', 'feature', 'docs', 'perf', 'security', 'ui', 'api', 'tests', 'build', 'question']
const AUTHORS = ['ada', 'linus', 'grace', 'ken', 'barbara', 'dennis', 'margaret', 'guido']
const WORDS = 'crash slow login export button cache parser timeout memory leak render config upload search token retry'.split(' ')
const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10)

export const ISSUES = Array.from({ length: 300 }, (_, i) => {
  const created = Math.floor(rand() * 500)
  const labels = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(LABELS)))]
  return {
    number: i + 1,
    title: `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`,
    state: rand() < 0.6 ? 'open' : 'closed',
    labels,
    author: pick(AUTHORS),
    created_at: day(created),
    updated_at: day(created + Math.floor(rand() * 200)),
    comments: Math.floor(rand() * 40),
    body: Array.from({ length: 40 }, () => pick(WORDS)).join(' '),
  }
})

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const TOOLS = {
  list_issues: {
    description:
      'List issues in the tracker.\n\nReturns a JSON array of issue objects with number, title, state, labels, author, created_at, updated_at, comments and body.\nFilter by state with `state`: "open", "closed" or "all" (the default).\nThis second paragraph exists so tests can check that a description is returned in full, not cut at its first line.',
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] } } },
    run: (a) => text(JSON.stringify(ISSUES.filter((x) => !a.state || a.state === 'all' || x.state === a.state))),
  },
  get_issue: {
    description: 'Get one issue by number, with its comments.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
    run: (a) => {
      const x = ISSUES.find((i) => i.number === a.number)
      if (!x) return { ...text(`no issue #${a.number}`), isError: true }
      return text(JSON.stringify({ ...x, thread: Array.from({ length: x.comments % 5 }, (_, k) => ({ by: AUTHORS[(x.number + k) % AUTHORS.length], text: `comment ${k} on #${x.number}` })) }))
    },
  },
  get_issue_full: {
    description: 'Get one issue by number with its whole comment thread: every comment, with its author (`by`) and text.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
    run: (a) => {
      const x = ISSUES.find((i) => i.number === a.number)
      if (!x) return { ...text(`no issue #${a.number}`), isError: true }
      const thread = Array.from({ length: x.comments }, (_, k) => ({
        by: AUTHORS[(x.number * 7 + k * 3 + (k >> 2)) % AUTHORS.length],
        text: `comment ${k} on #${x.number}: ` + Array.from({ length: 12 }, (_, w) => WORDS[(x.number + k * 5 + w * 3) % WORDS.length]).join(' '),
      }))
      return text(JSON.stringify({ ...x, thread }))
    },
  },
  stats: {
    description: 'Tracker statistics as structured content.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { total: { type: 'integer' }, open: { type: 'integer' } }, required: ['total', 'open'] },
    run: () => {
      const s = { total: ISSUES.length, open: ISSUES.filter((x) => x.state === 'open').length }
      return { ...text(JSON.stringify(s)), structuredContent: s }
    },
  },
  echo_text: {
    description: 'Echo the given text back as plain (non-JSON) text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (a) => text(`echo: ${a.text}`),
  },
  fail: {
    description: 'Always fails with an error result.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ ...text('the fail tool failed, as it always does'), isError: true }),
  },
}
for (let i = 0; i < Number(process.env.MOCK_EXTRA_TOOLS || 0); i++)
  TOOLS[`filler_${i}`] = { description: `Filler tool ${i}. ${'Padding text. '.repeat(30)}`, inputSchema: { type: 'object', properties: { x: { type: 'string' } } }, run: () => text(`filler ${i}`) }

// ---- JSON-RPC over stdio, one message per line ----

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain)
  createInterface({ input: process.stdin }).on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.id === undefined) return // a notification
    const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } })
      case 'tools/list':
        return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}) })) })
      case 'tools/call': {
        const t = TOOLS[m.params?.name]
        if (!t) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } })
        return reply(t.run(m.params.arguments ?? {}))
      }
      case 'ping':
        return reply({})
      default:
        return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } })
    }
  })

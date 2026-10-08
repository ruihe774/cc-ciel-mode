import { expect, test } from 'claude-code/testing'
import { spilledFile, spilledText } from '../hooks/spill.ts'

const DIR = '/home/u/.claude'
const notice = (path: string) => `result (131,336 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\n`
const persisted = (path: string) => `<persisted-output>\nOutput too large (80.9KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n[`

test('both notices name the file Claude Code saved the output to', () => {
  const txt = `${DIR}/projects/-proj/0a1b/tool-results/mcp-mock-list_issues-17915.txt`
  const json = `${DIR}/projects/-proj/0a1b/tool-results/toolu_plugin_e621.json`
  expect(spilledFile(notice(txt), DIR, '0a1b')).toBe(txt)
  expect(spilledFile(`Error: ${notice(txt)}`, DIR, '0a1b')).toBe(txt)
  expect(spilledFile(persisted(json), DIR, '0a1b')).toBe(json)
  expect(spilledFile(persisted(json), `${DIR}/`, '0a1b')).toBe(json)
})

test("only files in this session's tool-results folder are followed", () => {
  for (const path of [
    '/home/u/.ssh/id_rsa',
    `${DIR}/settings.json`,
    `${DIR}/projects/-proj/0a1b/tool-results/../../../../.ssh/id_rsa`,
    `${DIR}/projects/-proj/0a1b/other/x.txt`,
    `${DIR}/projects/-proj/tool-results/x.txt`,
    `${DIR}/projects/-proj/0a1b/tool-results/deeper/x.txt`,
    `/elsewhere/.claude/projects/-proj/0a1b/tool-results/x.txt`,
    // Another session's results
    `${DIR}/projects/-proj/9f9f/tool-results/x.txt`,
  ])
    expect(spilledFile(notice(path), DIR, '0a1b')).toBeUndefined()
  // Text that only mentions a notice is not one
  expect(spilledFile(`see: ${notice(`${DIR}/projects/p/0a1b/tool-results/x.txt`)}`, DIR, '0a1b')).toBeUndefined()
  expect(spilledFile('[{"a": 1}]', DIR, '0a1b')).toBeUndefined()
})

test('a saved list of content blocks reads back as their text', () => {
  expect(spilledText('/x/a.json', JSON.stringify([{ type: 'text', text: '[1,' }, { type: 'image', data: '' }, { type: 'text', text: '2]' }]))).toBe('[1,\n2]')
  // JSON that is the tool's own data stays as it is
  expect(spilledText('/x/a.json', '[{"n": 1}]')).toBe('[{"n": 1}]')
  expect(spilledText('/x/a.json', '{"type": "text"}')).toBe('{"type": "text"}')
  expect(spilledText('/x/a.txt', '[{"type": "text", "text": "t"}]')).toBe('[{"type": "text", "text": "t"}]')
})

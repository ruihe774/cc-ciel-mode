import { expect, test } from 'claude-code/testing'
import { Pending, approvalQuestion, callKey, stableJson, unapprovedReason } from '../hooks/approval.ts'

test('a call is keyed by its tool and its input, whatever the key order', () => {
  expect(stableJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}')
  expect(callKey('mcp__t__get', { a: 1, b: 2 })).toBe(callKey('mcp__t__get', { b: 2, a: 1 }))
  expect(callKey('mcp__t__get', { a: 1 })).not.toBe(callKey('mcp__t__list', { a: 1 }))
  expect(callKey('mcp__t__get', undefined)).toBe(callKey('mcp__t__get', {}))
})

test('pending calls are counted, so identical calls in flight are each matched', () => {
  const p = new Pending()
  p.add('k')
  p.add('k')
  p.delete('k')
  expect(p.has('k')).toBe(true)
  p.delete('k')
  expect(p.has('k')).toBe(false)
})

test('the dialog names every tool that needs approval', () => {
  expect(approvalQuestion(['mcp__a__x'])).toContain('this tool, which needs your approval: mcp__a__x.')
  expect(approvalQuestion(['mcp__a__x', 'Bash'])).toContain('these tools, which need your approval: mcp__a__x, Bash.')
  expect(unapprovedReason('Bash')).toContain('call("Bash", ...)')
})

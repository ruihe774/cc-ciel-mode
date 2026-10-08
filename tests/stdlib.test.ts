import { expect, test } from 'claude-code/testing'
import { baseEnv, fromJson, render, toJson } from '../hooks/stdlib.ts'

// Evaluates one expression over `d`, data as a tool would return it, and renders the result
const D = fromJson({
  items: [
    { n: 3, t: 'c', s: 0.5, u: { login: 'z' }, tags: ['x', 'y'] },
    { n: 1, t: 'a', s: 2, u: { login: 'y' }, tags: ['y'] },
    { n: 2, t: 'b', s: 1.5, tags: [] },
  ],
  m: { a: 1, b: 'two' },
})
const env = baseEnv.clone().registerVariable('d', 'dyn')
const ev = async (src: string) => {
  const check = env.check(src)
  if (!check.valid) throw new Error(`does not check: ${check.error}`)
  return render(await env.parse(src)({ d: D }))
}
const fails = async (src: string) => {
  try {
    await ev(src)
  } catch (e) {
    return String((e as Error).message).split('\n')[0]
  }
  throw new Error(`${src} did not fail`)
}

test('JSON comes in with whole numbers as ints and goes out as plain JSON', () => {
  expect(fromJson({ a: 1, b: 1.5, c: [2] })).toEqual(Object.assign(Object.create(null), { a: 1n, b: 1.5, c: [2n] }))
  expect(toJson(new Map<string, unknown>([['a', 1n], ['b', [2n, 'x']]]))).toEqual({ a: 1, b: [2, 'x'] })
  expect(render('text stays text')).toBe('text stays text')
  expect(render(new Map([['k', 1n]]))).toBe('{"k":1}')
})

test('sorting, by a field or a dotted path, ascending or descending', async () => {
  expect(await ev('d.items.sortBy("n").map(x, x.t)')).toBe('["a","b","c"]')
  expect(await ev('d.items.sortBy("-s").map(x, x.t)')).toBe('["a","b","c"]')
  // Elements missing the key sort last either way
  expect(await ev('d.items.sortBy("u.login").map(x, x.t)')).toBe('["a","c","b"]')
  expect(await ev('[3, 1, 2].sort()')).toBe('[1,2,3]')
  expect(await ev('["b", "a"].sort().reverse()')).toBe('["b","a"]')
  expect(await fails('[1, "a"].sort()')).toContain('cannot compare')
})

test('grouping and counting', async () => {
  expect(await ev('d.items.countBy("u.login")')).toBe('{"z":1,"y":1,"null":1}')
  expect(await ev('d.items.map(x, x.tags).flatten().countBy()')).toBe('{"y":2,"x":1}')
  expect(await ev('d.items.groupBy("t").keys()')).toBe('["c","a","b"]')
  expect(await ev('d.items.groupBy("t")["a"].map(x, x.n)')).toBe('[1]')
})

test('numbers: sum, min, max over ints, doubles or both', async () => {
  expect(await ev('d.items.map(x, x.n).sum()')).toBe('6')
  expect(await ev('d.items.map(x, x.s).sum()')).toBe('4')
  expect(await ev('d.items.map(x, x.n).max()')).toBe('3')
  expect(await ev('d.items.map(x, x.s).min()')).toBe('0.5')
  expect(await ev('[].sum()')).toBe('0')
  expect(await fails('[].max()')).toContain('empty list')
  expect(await fails('["a"].sum()')).toContain('not a number')
})

test('list and map helpers work on dyn values from tools', async () => {
  expect(await ev('d.items.take(2).map(x, x.n)')).toBe('[3,1]')
  expect(await ev('d.items.drop(2).map(x, x.n)')).toBe('[2]')
  expect(await ev('d.items.map(x, x.tags).flatten().distinct()')).toBe('["x","y"]')
  expect(await ev('d.m.keys()')).toBe('["a","b"]')
  expect(await ev('d.m.values()')).toBe('[1,"two"]')
  expect(await ev('{"k": 1}.keys()')).toBe('["k"]')
  expect(await ev('keys(d.m)')).toBe('["a","b"]')
  expect(await ev('values({"k": 1})')).toBe('[1]')
  expect(await ev('d.items.map(x, x.tags).flatten().countBy().take(1)')).toBe('{"y":2}')
})

test('string helpers', async () => {
  expect(await ev('"a.b.a".replace("a", "x")')).toBe('x.b.x')
  expect(await ev('"v1.2 and v3.4".find("v[0-9.]+")')).toBe('v1.2')
  expect(await ev('"v1.2 and v3.4".findAll("v[0-9.]+")')).toBe('["v1.2","v3.4"]')
  expect(await ev('"none".find("[0-9]")')).toBe('')
  expect(await ev('"a\\nb\\r\\nc".lines()')).toBe('["a","b","c"]')
  expect(await ev('"abcdef".truncate(3)')).toBe('abc…')
  expect(await ev('"abc".truncate(3)')).toBe('abc')
  expect(await fails('"x".find("(")')).toContain('invalid regex')
})

test('json and toJson', async () => {
  expect(await ev('json("{\\"a\\": [1, 2.5]}").a')).toBe('[1,2.5]')
  expect(await ev('toJson(d.m)')).toBe('{"a":1,"b":"two"}')
  expect(await fails('json("{")')).toContain('json:')
})

test('optional fields', async () => {
  expect(await ev('d.items.map(x, x.?u.?login.orValue("none"))')).toBe('["z","y","none"]')
  expect(await ev('d.items.filter(x, has(x.u)).size()')).toBe('2')
  expect(await fails('d.items[2].u')).toContain('No such key')
})

test('no way out of the data: prototype keys are not fields', async () => {
  expect(await fails('d.__proto__')).toContain('No such key')
  expect(await fails('d.constructor')).toContain('No such key')
  expect(await fails('d["constructor"]')).toContain('No such key')
  expect(await fails('d.items.constructor')).toBeDefined()
  expect(await fails('"x".constructor')).toBeDefined()
  // A __proto__ key in a map literal is dropped, not set
  expect(await ev('{"__proto__": {"polluted": true}}')).toBe('{}')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  // Tool data is copied without a prototype, whatever keys it has
  const evil = fromJson(JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}')) as Record<string, unknown>
  expect(Object.getPrototypeOf(evil)).toBeNull()
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})

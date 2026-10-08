# code-mode

A Claude Mod that gives Claude Code a **Code Mode**: instead of calling an MCP tool and reading its whole output, Claude writes a small program that calls the tools, filters, ranks and joins their results, and returns only the answer. A 100 KB issue list becomes `{"stale": 90, "labels": {"docs": 24, ...}}` before it reaches the context.

Programs are written in [CEL](https://cel.dev) (Common Expression Language) and run in a **sandbox**. Unlike Code Mode setups that run JavaScript or Python, a program here can't touch the file system, the network, processes or the host, so it does nothing but compute and call tools. Every tool call it makes goes back through Claude Code, so permission rules, permission prompts and other mods' hooks apply to it just as they do to Claude's own calls.

## Why

MCP tools often return far more than the task needs: every issue in a repository, every row of a query, a whole document. Claude reads all of it, and on a long task the context fills with data it looked at once. The Claude API has [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) and Codex and Cloudflare have Code Mode for this; community MCP wrappers do it by running scripts in a proxy that holds its own copies of your MCP servers and credentials. This mod does it inside Claude Code, with the MCP servers Claude Code already has connected, and with a language that can't do harm.

## What Claude gets

| Tool | What it does |
| --- | --- |
| `mcp__code-mode__run` | Runs a program and returns its result. |
| `mcp__code-mode__tools` | Lists the tools a program may call, one line each, optionally filtered. Claude loads a tool's full description and input schema with ToolSearch, Claude Code's own schema loader. |

And for you, `/code-mode <program>` runs a program by hand.

A program is `let` lines and a final expression:

```
let issues = call("mcp__github__list_issues", {"owner": "o", "repo": "r", "state": "open"})
let stale = issues.filter(i, i.updated_at < "2026-01-01")
let top = stale.sortBy(i, -i.comments).take(3)
let details = callEach("mcp__github__get_issue", top.map(i, {"owner": "o", "repo": "r", "issue_number": i.number}))
{"stale": size(stale),
 "labels": stale.map(i, i.labels.map(l, l.name)).flatten().countBy().take(5),
 "top": details.map(d, {"n": d.number, "assignee": d.?assignee.?login.orValue("none")})}
```

- `call(tool, args)` returns the tool's output as data (JSON parsed, else text). A failed call stops the program with the tool's error and the line it was on.
- `tryCall(tool, args)` returns `{ok, value, error}` and never stops the program.
- `callEach(tool, [args, ...])` makes the calls in parallel and keeps their order.
- Standard CEL (`filter`, `map`, `exists`, `all`, `has`, optional fields `x.?f.orValue(d)`, string functions), plus helpers for data work: `take`, `drop`, `reverse`, `sort`, `sortBy`, `distinct`, `flatten`, `groupBy`, `countBy`, `sum`, `min`, `max`, `keys`, `values`, `replace`, `find`, `findAll`, `lines`, `truncate`, `json`, `toJson`. `sortBy`, `groupBy` and `countBy` take a key per element (`xs.sortBy(x, -x.n)`) or a field name (`xs.sortBy("-n")`).
- The whole program is parsed and type-checked before anything runs, so a typo costs no tool calls. Errors name the line, and the common mistakes get a hint.
- Outputs that Claude Code would save to a file because they are too large come back whole inside the program.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `tools` | `^(mcp__.+\|Read\|Glob\|Grep\|WebFetch\|WebSearch)$` | A regex over full tool names: the tools a program may call. code-mode's own tools are never callable, so a program can't start another. |
| `deny_direct` | off | Deny Claude's direct calls to callable MCP tools, pointing it to `run`. A program's calls still pass. Built-in tools are never denied. |
| `max_calls` | 100 | Tool calls one program may make; the program is stopped past it. `callEach` is checked before it starts. |
| `concurrency` | 8 | Calls `callEach` runs at once. |
| `max_output` | 20000 | Characters of a result Claude reads; the rest is cut with a note. |

Set them in `/plugin`, or under `pluginConfigs` in your settings.

**Try `deny_direct` if Claude keeps calling the tools directly.** By default Claude chooses, and smaller models often call a big tool directly once first, which brings its output (or Claude Code's notice that it saved the output to a file) into the context and costs a turn.

## Measured

`e2e/run.sh` asks claude-haiku-5-5 three questions about a mock issue tracker (300 issues) three ways: without code-mode, with it, and with it and `deny_direct`. Every answer was correct. (One baseline run ranked Q2's issues by number, not by comment count, and was counted as failed.) Input tokens summed over each run's requests, for three runs:

| Question | Without code-mode | code-mode | code-mode + `deny_direct` |
| --- | --- | --- | --- |
| Q1: count open stale issues and their top labels (one 81 KB list) | 74k, 74k, 74k | 57k, 79k, 100k | 97k, 97k, 117k |
| Q2: top 5 issues by comments, then each one's commenters (list + 5 calls) | 95k, 116k, 119k | 123k, 225k, 267k | 159k, 162k, 237k |
| Q3: top 3 commenters across 40 full threads (40 calls, 115 KB in all) | 96k, 96k, 96k | 77k, 77k, 162k | 77k, 78k, 98k |

What this shows:

- **code-mode saves tokens when the data would otherwise land in the context.** In Q3 each output is under Claude Code's size limits, so without code-mode all 115 KB is read inline. One program reads it instead, about 20% less here. In a longer session the saving grows, since data in the context is re-read on every later request.
- **It costs tokens when the data would not have landed anyway.** Claude Code already saves an output over its size limit to a file. In Q1 and Q2 the baseline read that file with one Bash+Python command, which works but runs an unsandboxed script. Most of each request is Claude Code's own system prompt and tools, so every extra request costs as much as the data saved. Haiku often needs two or three attempts to get a CEL program right, and those extra requests outweigh the saving.
- **`deny_direct` makes runs consistent when the task suits code-mode** (Q3). On the other tasks it adds the refused first call.

A stronger model writes the program right the first time more often. The error hints and the lambda forms (`sortBy(x, key)`) were added for the mistakes Haiku made in these runs.

## Safety

- **Sandbox.** CEL has no I/O, no loops beyond list macros, and no access to the host beyond the functions this mod registers. Field access reads only a value's own fields (`x.__proto__` and `x.constructor` are missing keys), tool data is copied without prototypes, and parse limits cap a program's size and nesting.
- **Same checks as Claude's own calls.** Every call goes through `$.tool.call`: permission rules, prompts and modes, managed hooks and every other mod's `tool.call` hooks. A program can't set the keys Claude Code reserves on a call (such as `consent`, which speaks for the user to the permission check).
- **Scope.** By default only MCP tools and the read-only built-ins (Read, Glob, Grep, WebFetch, WebSearch) are callable. A tool named by a string literal is checked before the program runs; one named by a computed string, when it is called.
- **Limits.** `max_calls` and `max_output` bound a run, and an interrupt stops a program before its next call.
- **Spilled output.** A result Claude Code saved to a file is read back only from a `tool-results` folder of a session under Claude Code's config dir, so a tool can't point code-mode at another file by returning text that looks like Claude Code's notice.

A program can still call any tool in its scope with any arguments, including MCP tools that write (send a message, create an issue). Keep `tools` narrow, or keep those tools behind permission prompts, if that matters to you.

## Installation

Requires Claude Code v2.1.287 or later. Load it from a checkout:

```
claude --plugin-dir /path/to/code-mode
```

## Development

- `claude plugin validate .` and `claude plugin test` (unit and test-kit tests in `tests/`)
- Typecheck: load once with `claude --plugin-dir .` to generate `.claude-plugin/types/`, then `npx -p typescript tsc -p .`
- `e2e/run.sh quick` runs the deterministic end-to-end checks against a real Claude Code; `e2e/run.sh` adds the model runs. See [CLAUDE.md](CLAUDE.md).

## License

[Unlicense](LICENSE). Bundles [cel-js](https://github.com/marcbachmann/cel-js) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

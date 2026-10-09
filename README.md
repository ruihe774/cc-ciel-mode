# ciel-mode

A Claude Mod that gives Claude Code **ciel-mode** (**C**all-**i**n-**CEL** mode): instead of calling an MCP tool and reading its whole output, Claude writes a small program that calls the tools, filters, ranks and joins their results, and returns only the answer. A 100 KB issue list becomes `{"stale": 90, "labels": {"docs": 24, ...}}` before it reaches the context.

Programs are written in [CEL](https://cel.dev) (Common Expression Language) and run in a **sandbox**. Unlike Code Mode setups that run JavaScript or Python, a program here can't touch the file system, the network, processes or the host, so it does nothing but compute and call tools. Every tool call it makes goes back through Claude Code, so permission rules and other mods' hooks apply to it as they do to Claude's own calls, and a call your rules would ask about needs your approval, given once for the program before it runs.

## Why

MCP tools often return far more than the task needs: every issue in a repository, every row of a query, a whole document. Claude reads all of it, and on a long task the context fills with data it looked at once. The Claude API has [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) and Codex and Cloudflare have Code Mode for this; community MCP wrappers do it by running scripts in a proxy that holds its own copies of your MCP servers and credentials. This mod does it inside Claude Code, with the MCP servers Claude Code already has connected, and with a language that can't do harm.

## What Claude gets

| Tool | What it does |
| --- | --- |
| `mcp__ciel-mode__run` | Runs a program and returns its result. |
| `mcp__ciel-mode__tools` | Lists the tools a program may call, one line each, optionally filtered. Claude loads a tool's full description and input schema with ToolSearch, Claude Code's own schema loader. |

And for you, `/ciel-mode <program>` runs a program by hand.

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
- `var` in place of `let` keeps a value for the session's later programs, in memory: `var issues = call(...)` in one program, `issues.filter(...)` in the next, with no second call. Another `var issues = ...` line replaces it, `var issues = null` drops it, and `vars()` lists what is kept. A `let` lasts one program. A var is kept as soon as its line runs, so a later failure in the same program doesn't lose it. At most `max_vars` are kept at once; the session's end (and `/clear`, `/resume`) drops them all.
- The whole program is parsed and type-checked before anything runs, so a typo costs no tool calls. Errors name the line, and the common mistakes get a hint.
- Outputs that Claude Code would save to a file because they are too large come back whole inside the program.

## Approval

When a program names a tool that your permission rules would ask about, ciel-mode shows one dialog before the program starts, listing every such tool:

```
A ciel-mode program wants to call these tools, which need your approval: mcp__gmail__send_message, mcp__github__create_issue. Let this program call them with any arguments?
❯ 1. Run the program
  2. Don't run it
```

- Approval covers that program only, and only the tools it names with string literals (`call("mcp__gmail__send_message", ...)`). A call to a tool named any other way (a computed string) that needs approval is refused, since a running program can't stop to ask.
- Tools your rules already allow run without a dialog; tools they deny stay denied, approved or not.
- With no one to ask (`claude -p`) or the dialog dismissed, the program doesn't run, and Claude is told to make the calls directly instead.
- A program you type yourself with `/ciel-mode` counts as approved for the tools it names.
- `always_allow` lists tools programs may call without the dialog.

This holds in every permission mode. It matters most in auto mode: Claude Code doesn't put a plugin's tool calls to its auto-mode classifier and lets them run (its debug log says `Skipping auto mode classifier for Bash: called by plugin ciel-mode`), so without the approval step a program could do in auto mode what the classifier would have blocked had Claude made the call itself.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `tools` | `^(mcp__.+\|Read\|Glob\|Grep\|WebFetch\|WebSearch)$` | A regex over full tool names: the tools a program may call. ciel-mode's own tools are never callable, so a program can't start another. Widen it (to `Bash`, `Write`, ...) only on purpose. |
| `always_allow` | empty | A regex over full tool names: tools a program may call without the approval dialog, even when your rules would ask. Empty means none. |
| `deny_direct` | off | Deny Claude's direct calls to callable MCP tools, pointing it to `run`. A program's calls still pass. Built-in tools are never denied. |
| `max_calls` | 100 | Tool calls one program may make; the program is stopped past it. `callEach` is checked before it starts. |
| `concurrency` | 8 | Calls `callEach` runs at once. |
| `max_output` | 20000 | Characters of a result Claude reads; the rest is cut with a note. |
| `max_vars` | 20 | `var` values kept for the session at once; a program that would keep more is stopped before it runs. 0 turns `var` off. |

Set them in `/plugin`, or under `pluginConfigs` in your settings.

**Try `deny_direct` if Claude keeps calling the tools directly.** By default Claude chooses, and smaller models often call a big tool directly once first, which brings its output (or Claude Code's notice that it saved the output to a file) into the context and costs a turn.

## Measured

`e2e/pubmed.sh` runs a real literature question through claude-sonnet-5-5 with the pubmed-literature-search skill and Anthropic's PubMed MCP server:

> /pubmed-literature-search Is insufficient or irregular sleep a carcinogenic risk factor? If so, what's the estimated odds ratio?

Each session is a fresh `claude -p` in one of three arms: without ciel-mode (off), with it (on), and with it and `deny_direct`. The PubMed tools and the read-only built-ins (Read, Glob, Grep) are allowed, and for programs `always_allow`'ed, so no session stops for a prompt. Claude Code also lets read-only Bash commands such as `jq` run. 51 sessions in all. Medians, with the range in brackets:

| | Without ciel-mode | ciel-mode | ciel-mode + `deny_direct` |
| --- | --- | --- | --- |
| Sessions | 18 | 18 | 15 |
| Sessions that ran a program | 0 | 0 | 15 |
| Input tokens, all requests | 284k (182k–441k) | 290k (127k–457k) | 303k (243k–502k) |
| of which written to the cache | 47k (29k–60k) | 49k (28k–74k) | 32k (26k–37k) |
| Output tokens | 4.2k | 4.0k | 4.5k |
| Tool output that reached the context | 81 KB (33–116 KB) | 76 KB (32–143 KB) | 40 KB (22–51 KB) |
| Turns (tool calls) | 11 | 10 | 10 |
| Cost per session, median (mean) | $0.27 ($0.28) | $0.29 ($0.29) | $0.24 ($0.23) |

**Quality check.** The skill exists because abstracts mislead. Manouchehri et al. 2021 ([PMID 33653334](https://pubmed.ncbi.nlm.nih.gov/33653334/)), a meta-analysis of night-shift work and breast cancer, reports a long-term RR of 1.08 (0.99–1.17) in its abstract. Its Results give the publication-bias correction: Egger's test p = 0.003, and after trim-and-fill RR 1.02 (0.91–1.15), essentially null. The report counts an answer that cites the paper without that correction as a failure. No session in any arm fetched the paper's full text. Three answers cited it, all from the abstract, and all three fail: one without ciel-mode and two in the ciel-mode arm (sessions that called PubMed directly and never ran a program). No `deny_direct` answer cited it. Every other answer reached the same conclusion: short sleep is not associated with overall cancer (pooled OR about 1.0), and night-shift work has a weak, contested link to breast cancer.

What this shows:

- **Sonnet doesn't use ciel-mode unprompted here.** In all 18 ciel-mode sessions it called PubMed directly, so that arm measures the mod sitting unused (its tools in the prompt), which costs nothing visible. The skill's own workflow (search, then metadata, then full text) names the PubMed tools, which may be why.
- **With `deny_direct`, every session wrote programs and kept about half the tool output out of the context.** It first tries PubMed directly once or twice, is refused, then runs 4 to 11 programs that return the fields it wants, such as titles and abstracts, or sentences matching `Egger|publication bias` in a full text, rather than whole records.
- **Total input tokens don't fall, but cost does, by about 15%.** Most of each request is Claude Code's own prompt plus the conversation so far, read back from the cache. Less data in the context means fewer cache writes (32k against 47k), which cost more than cache reads. The extra request or two for the refused direct calls and for retried programs adds cache reads.
- **Over a longer session the saving grows**, since data in the context is read again on every later request.

`e2e/run.sh` still runs the earlier synthetic model checks, against a mock issue tracker with claude-haiku-5-5.

## Safety

- **Sandbox.** CEL has no I/O, no loops beyond list macros, and no access to the host beyond the functions this mod registers. Field access reads only a value's own fields (`x.__proto__` and `x.constructor` are missing keys), tool data is copied without prototypes, and parse limits cap a program's size and nesting.
- **Same rules as Claude's own calls, plus approval.** Every call goes through `$.tool.call`: permission rules, managed and settings hooks, and every other mod's `tool.call` hooks. A call the rules would ask about runs only if you approved its tool for the program (see [Approval](#approval)); ciel-mode decides this itself in a `tool.check` hook, because Claude Code would otherwise let a plugin's call run unreviewed in auto mode. A program can't set the keys Claude Code reserves on a call (such as `consent`, which speaks for the user to the permission check).
- **Scope.** By default only MCP tools and the read-only built-ins (Read, Glob, Grep, WebFetch, WebSearch) are callable. A tool named by a string literal is checked before the program runs; one named by a computed string, when it is called.
- **Limits.** `max_calls` and `max_output` bound a run, and an interrupt stops a program before its next call. `max_vars` bounds how many values programs keep in memory between runs (not their size).
- **Spilled output.** A result Claude Code saved to a file is read back only from this session's `tool-results` folder under Claude Code's config dir, so a tool can't point ciel-mode at another file by returning text that looks like Claude Code's notice.

Approving a tool for a program lets that program call it with any arguments, as many times as `max_calls` allows, including MCP tools that write (send a message, create an issue). Read the program in the transcript before you approve it, and keep `always_allow` to tools whose every call you would allow.

## Installation

Requires Claude Code v2.1.287 or later. Load it from a checkout:

```
claude --plugin-dir /path/to/ciel-mode
```

## Development

- `claude plugin validate .` and `claude plugin test` (unit and test-kit tests in `tests/`)
- Typecheck: load once with `claude --plugin-dir .` to generate `.claude-plugin/types/`, then `npx -p typescript tsc -p .`
- `e2e/run.sh quick` runs the deterministic end-to-end checks against a real Claude Code; `e2e/run.sh` adds the model runs. `SKILL_DIR=<pubmed-literature-search skill dir> e2e/pubmed.sh [runs]` runs the PubMed benchmark above. See [CLAUDE.md](CLAUDE.md).

## License & Acknowledgements

[Unlicense](LICENSE). Bundles [cel-js](https://github.com/marcbachmann/cel-js) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

kzarzycki's eval-kernel was the first Claude mod implemnting a tool call executor. It used a standalone Bun process.

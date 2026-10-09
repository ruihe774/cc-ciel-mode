# ciel-mode

A Claude Mod (v2.1.287+) that adds ciel-mode (**C**all-**i**n-**CEL** mode): Claude writes a small CEL program that calls tools, filters and joins their results, and returns only the answer. Programs are sandboxed (CEL reaches nothing but the functions we register) and every tool call goes back through `$.tool.call`, so permissions and other mods' hooks still apply. A mod is a plugin directory whose hooks run as JS/TS middleware.

## Layout

- `.claude-plugin/plugin.json`: manifest; `userConfig` holds `tools`, `always_allow`, `deny_direct`, `max_calls`, `concurrency`, `max_output`, `max_vars`
- `hooks/hooks.json`: `modules` points to `./register.ts`
- `hooks/register.ts`: the only file that touches `$`. Registers `mcp__ciel-mode__run`, `mcp__ciel-mode__tools` and `/ciel-mode`; the host that turns a program's calls into `$.tool.call`; the approval dialog and the `tool.check` hook that enforces it; the opt-in `deny_direct` hook; the session's `var` store (module state, emptied on `session.end`)
- `hooks/approval.ts`: pure. Call keys, the pending-call multiset, the dialog text
- `hooks/program.ts`: pure. Splits a program into `let`/`var` statements and a result, desugars the lambda helpers, type-checks the whole program, runs it against an injected `Host`
- `hooks/stdlib.ts`: pure. The CEL environment and helpers, JSON <-> CEL values
- `hooks/catalog.ts`: pure. The scope (which tools a program may call) and the `tools` index
- `hooks/spill.ts`: pure. Recognizes Claude Code's "output saved to a file" notices and checks the path
- `hooks/vendor/cel/`: cel-js 8.0.0, vendored; don't edit (see THIRD_PARTY_NOTICES.md to rebuild)
- `tests/*.test.ts`: run with `claude plugin test`
- `e2e/mock-mcp.mjs`: a stdio MCP server with deterministic data (300 issues; `list_issues` about 131 KB, `get_issue`, `get_issue_full` with whole threads, `stats`, `echo_text`, `fail`); `e2e/run.sh`: end-to-end checks
- `e2e/pubmed.sh` (+ `pubmed-report.py`): the README's benchmark. claude-sonnet-5-5 with the pubmed-literature-search skill (copied in from `SKILL_DIR` as a project skill) and Anthropic's public PubMed MCP server (`https://pubmed.mcp.claude.com/mcp`, named `PubMed`; a child `claude -p` doesn't get claude.ai connectors). Arms off/on/deny (`deny_direct`). The report checks answers that cite Manouchehri 2021 (PMID 33653334) for the Results-only trim-and-fill RR 1.02. `stream-json` doesn't echo a slash command's expanded skill body; the session transcript under `~/.claude/projects/` has it

## Conventions

- Always call the mods API in full, `$.fs.read(...)`. The loader rejects `$.tool` read as a value, and `$` passed to anything but a function declared at the top level of the file.
- Matchers must be literals (`{ tool: 'mcp__ciel-mode__run' }`); `claude plugin validate` can't read a template literal and shows `{tool=?}`.
- cel-js signatures: a receiver type has no spaces or commas (`map.keys()`, not `map<K, V>.keys()`). Generic list helpers (`list<A>.x(): list<A>`) lose their type on a `dyn` receiver, which is every tool output, so helpers take `list` and return `list<dyn>`/`dyn`.
- A hooks module can import only code files (no `.json`).
- Types live in `.claude-plugin/types/claude-code/index.d.ts` (generated per version, authoritative, gitignored). An interactive `claude --plugin-dir .` writes them; `-p` does not.

## How the mods API behaves (verified by spikes on 2.1.295)

- `$.tool.list()` returns `{ name, description, mcp }` only: no input schemas, and descriptions cut at 300 characters. No method or event gives a mod an MCP tool's input schema.
- `tool.describe` fires for every tool, deferred MCP tools included, at the first model request, with the full description. Not used now.
- `$.tool.call({ tool: 'ToolSearch', query: 'select:...' })` from a mod resolves to `{ result: { matches, query, total_deferred_tools }, text: '' }`: no schemas reach the mod, and returning that object from a tool hook fails output validation. So Claude loads schemas with ToolSearch itself.
- `$.tool.call` on an MCP tool resolves to `{ ref, result, text }`. `text` is what the model reads. `result` is a string or a list of content blocks; with an output schema it is still text. An error is `{ isError: true, result: 'Error: <msg>', text: '<msg>' }`, with no `Error: ` prefix in `text`. A refused permission is `{ deny }`. An unknown tool name rejects.
- Mod-raised calls go through the permission check: in `-p` they are denied unless `--allowedTools` covers them. In a test, `--allowedTools 'mcp__mock__*' 'mcp__ciel-mode__*'`.
- `next.origin` on a call this plugin raised is `{ plugin: 'ciel-mode', tier: 'user' }`; the model's own calls come from the engine. `deny_direct` tells them apart this way. `$.tool.call` "runs through every hook but the calling one", so this plugin's other hooks do see its calls.
- Large outputs never reach `text`. Over the MCP token limit (about 131 KB here), `text` reads `result (N characters across …) exceeds maximum allowed tokens. Output has been saved to <path>.txt.` and the file holds the plain text. Over the inline size (about 81 KB here), `text` reads `<persisted-output>\nOutput too large (80.9KB). Full output saved to: <path>.json`, and the file holds the content blocks as JSON. Both paths are `<config dir>/projects/<project>/<session>/tool-results/<file>`. The host reads them back with `$.fs.read` (4 MiB max).
- **Auto mode doesn't review a plugin's calls.** For a call raised with `$.tool.call`, `tool.check` decides `ask`, then the debug log says `Skipping auto mode classifier for Bash: called by plugin <name>` and the call runs. The same command from the model is blocked by the classifier. Hence the approval design: a program's `ask` becomes `allow` only for calls of tools approved before the run (or `always_allow`), matched by `callKey(tool, input)` in a `tool.check` hook (`e.input` equals the program's arguments), and `deny` otherwise. The hook acts only on calls a program has in flight: `$.ui.ask` is itself a `$.tool.call` of AskUserQuestion from this plugin, and denying it would kill the dialog.
- `$.tool.check({ tool, input })` (a query) returns the rules' decision without running anything: no dialog, no classifier, no `PreToolUse` hook. In auto mode it returns `ask` where the classifier would decide; a Bash query returns `ask` even for `ls`. A content deny rule (`Bash(echo denied:*)`) still denies a program's call; `--disallowedTools X` instead removes X from the session (the call rejects: no tool named X).
- `$.ui.ask` shows the AskUserQuestion dialog; it rejects in `-p` and when dismissed. `classic.PreToolUse` fires for a plugin's call with the call's envelope (`tool`, arguments, `tool_use_id`), not the hook stdin JSON, so it carries no permission mode.
- **A registered tool's description reaches the model only up to its first 2048 characters** (Claude Code logs `the description of run (N characters) reaches the model up to its first 2048`). A schema property's description is not cut: the CEL reference lives in the `program` parameter's description, and a model quoted its last line exactly.
- `$.mcp.call(server, tool, args)` reaches any connected server with no permission prompt ("the plugin's call is the grant"), so it is not used: it would bypass permissions and other mods' `tool.call` hooks.
- Module state lasts the session: a `var` kept by one `run` call is there for the next (checked with two `run` calls in one `claude -p`). Each `claude -p` is its own session, so `e2e/run.sh quick` can't test it. cel-js can't re-register a variable, so every var is bound as `dyn`, in its own program too.
- cel-js awaits async function handlers, including inside `map`/`filter` macros (one at a time), so `call()` works anywhere in an expression. `callEach` is the parallel form.
- CEL CPU cost is small: a filter and map over 10k issues takes about 20 ms, far under a hook's 10 s budget, and time inside `$.tool.call` doesn't count anyway.
- Measuring (see README): the result's `num_turns` counts tool calls, not requests (40 parallel calls in one request are 40 turns), and `usage` sums every request. Most of each request is Claude Code's own prompt (about 18k tokens), so ciel-mode saves only when the data it keeps out would otherwise be read inline. Claude Code already keeps an over-limit output out (it saves it to a file), so a single huge output is not the case to test; many medium outputs are.
- With claude-haiku-5-5, Claude tends to call a big MCP tool directly first, see Claude Code's file notice (whose preview shows content blocks), and then index `call()` output as blocks (`raw[0].text`). The error hints in `program.ts` (`HINTS`) target exactly these mistakes. With `deny_direct` on, it writes one program from the start. Haiku also reaches for lambda forms (`sortBy(x, key)`), hence the desugaring.

## Verifying changes

1. `claude plugin validate .` and `claude plugin test`
2. Typecheck: `npx -p typescript tsc -p .` (after the types are generated)
3. `e2e/run.sh quick`: deterministic checks through `/ciel-mode` in `claude -p` (no model turns). `e2e/run.sh`: plus model runs and a token comparison against a run without the mod.

## Running a claude session for spikes and end-to-end tests

- Model: `--model claude-haiku-5-5`. Cheap, and able to write CEL with the hints. claude-haiku-4-5 is not enough for programs.
- Unset every `CLAUDE*` and `AI_AGENT` env var (except `CLAUDE_CODE_PLUGIN_DIRS`), or it runs as a child session; `e2e/run.sh`'s `clean` does this. Auth still works without them; check once with `claude -p "say hi" --model claude-haiku-5-5`.
- `claude -p '/ciel-mode <program>'` runs a program without a model turn; the result's `result` field is `ciel-mode: <output>`.
- MCP: `--mcp-config <file> --strict-mcp-config` with `{"mcpServers":{"mock":{"command":"node","args":["<repo>/e2e/mock-mcp.mjs"]}}}`. `MOCK_EXTRA_TOOLS=N` in its `env` adds filler tools.
- Plugin options for one run: `--settings '{"pluginConfigs":{"ciel-mode@inline":{"options":{"deny_direct":true}}}}'`.
- `--output-format stream-json --verbose` gives every tool call and result; the last `"type":"result"` line has `usage` and `num_turns`.
- Waiting on background runs: don't loop on `pgrep -f <script>`, which matches its own command line and never ends. Run them in the foreground with `&` and `wait`, or have each write a marker line when it finishes.
- `--debug-file <log>`: hook load errors and core's debug lines. `$.ui.log(..., { to: 'debug' })` from this module does not show there (it loads in a worker environment); return debug text in a tool result instead.
- Interactive runs (needed only to regenerate types): tmux, `tmux new-session -d -x 200 -y 50 -c <workdir> "<clean env> claude --model claude-haiku-5-5 --plugin-dir <repo>"`, a fresh scratch workdir, then the theme picker and security notes (`C-m` each) and the folder-trust prompt (`Down`, `C-m`). Submit text with `send-keys -l`, a pause, then `C-m`.

## Docs (downloaded; consult before changing APIs)

- `docs/mods-reference.md`: events, API methods, limits
- `docs/mods-api.md`, `docs/mods-events.md`, `docs/mods-create.md`, `docs/mods-test.md`

Mods change between releases; if docs and types disagree, trust the types.

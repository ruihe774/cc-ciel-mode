#!/usr/bin/env bash
# Real-world benchmark: a PubMed literature question answered by claude-sonnet-5-5 with the
# pubmed-literature-search skill, with ciel-mode on and off.
#
#   SKILL_DIR=<dir holding SKILL.md> e2e/pubmed.sh [runs per mode, default 3]
#
# Uses Anthropic's public PubMed MCP server (https://pubmed.mcp.claude.com/mcp) under the name
# PubMed, so its tools are mcp__PubMed__*, as with the claude.ai connector. The skill is copied
# into a scratch project as .claude/skills/pubmed-literature-search. PubMed tools and the
# read-only built-ins are allowed (and always_allow'ed for programs). Costs a few dollars.
set -u
E2E=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$E2E")
MODEL=${MODEL:-claude-sonnet-5-5}
RUNS=${1:-3}
: "${SKILL_DIR:?set SKILL_DIR to the pubmed-literature-search skill directory}"
T=${OUT:-$(mktemp -d)}
PROMPT="/pubmed-literature-search Is insufficient or irregular sleep a carcinogenic risk factor? If so, what’s the estimated odds ratio?"
READONLY='^(mcp__PubMed__.+|Read|Glob|Grep)$'
ON="{\"pluginConfigs\":{\"ciel-mode@inline\":{\"options\":{\"always_allow\":\"$READONLY\"}}}}"
printf '{"mcpServers":{"PubMed":{"type":"http","url":"https://pubmed.mcp.claude.com/mcp"}}}\n' > "$T/mcp.json"

clean() {
  local v
  for v in $(env | grep -oE '^(CLAUDE[A-Z0-9_]*|AI_AGENT)=' | tr -d '='); do
    [ "$v" = CLAUDE_CODE_PLUGIN_DIRS ] || unset "$v"
  done
  "$@"
}

# run <name> on|off: one session in its own project dir, its stream in $T/<name>.jsonl
run() {
  local name=$1 w="$T/$1"
  mkdir -p "$w/.claude/skills"
  cp -r "$SKILL_DIR" "$w/.claude/skills/pubmed-literature-search"
  local mod=() allow=('mcp__PubMed__*' Read Glob Grep)
  if [ "$2" = on ]; then mod=(--plugin-dir "$ROOT" --settings "$ON"); allow+=('mcp__ciel-mode__*'); fi
  (cd "$w" && clean claude -p "$PROMPT" --model "$MODEL" "${mod[@]}" --mcp-config "$T/mcp.json" --strict-mcp-config \
    --allowedTools "${allow[@]}" --output-format stream-json --verbose < /dev/null > "$T/$name.jsonl" 2> "$T/$name.err")
  echo "done: $name"
}

for i in $(seq 1 "$RUNS"); do run "off$i" off & run "on$i" on & done
wait

# One row per run: tokens, cost, tool calls, how much tool output reached the context, and the
# Manouchehri check (the abstract's RR 1.08 vs the Results' trim-and-fill RR 1.02, 0.91-1.15).
python3 - "$T" "$RUNS" <<'EOF'
import json, re, sys, os
T, runs = sys.argv[1], int(sys.argv[2])
for mode in ('off', 'on'):
    for i in range(1, runs + 1):
        name = f'{mode}{i}'
        res, calls, seen, outch, mano = None, {}, '', 0, False
        for line in open(os.path.join(T, name + '.jsonl')):
            d = json.loads(line)
            if d.get('type') == 'result': res = d
            if d.get('type') == 'assistant':
                for b in d['message']['content']:
                    if b.get('type') == 'tool_use': calls[b['name']] = calls.get(b['name'], 0) + 1
            if d.get('type') == 'user' and isinstance(d['message']['content'], list):
                for b in d['message']['content']:
                    if b.get('type') == 'tool_result':
                        c = b['content'] if isinstance(b['content'], str) else ' '.join(x.get('text', '') for x in b['content'] if isinstance(x, dict))
                        outch += len(c); seen += c
        if not res: print(name, 'no result'); continue
        u = res['usage']
        inp = u['input_tokens'] + u['cache_read_input_tokens'] + u['cache_creation_input_tokens']
        ans = res.get('result', '')
        mano = 'Manouchehri' in seen or 'Manouchehri' in ans
        ok = bool(re.search(r'1\.02', ans) and re.search(r'trim.and.fill', ans, re.I))
        verdict = ('pass' if ok else 'FAIL') if mano else 'no Manouchehri'
        print(f"{name}: {inp} input, {u['output_tokens']} output, ${res.get('total_cost_usd', 0):.2f}, "
              f"{res['num_turns']} turns, {res['duration_ms'] // 1000}s, {outch} chars of tool output; "
              f"Manouchehri: {verdict}; calls: {calls}")
print('streams:', T)
EOF

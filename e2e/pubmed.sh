#!/usr/bin/env bash
# Real-world benchmark: a PubMed literature question answered by claude-sonnet-5-5 with the
# pubmed-literature-search skill: without ciel-mode (off), with it (on), and with it and
# deny_direct (deny).
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
DENY="{\"pluginConfigs\":{\"ciel-mode@inline\":{\"options\":{\"always_allow\":\"$READONLY\",\"deny_direct\":true}}}}"
printf '{"mcpServers":{"PubMed":{"type":"http","url":"https://pubmed.mcp.claude.com/mcp"}}}\n' > "$T/mcp.json"

clean() {
  local v
  for v in $(env | grep -oE '^(CLAUDE[A-Z0-9_]*|AI_AGENT)=' | tr -d '='); do
    [ "$v" = CLAUDE_CODE_PLUGIN_DIRS ] || unset "$v"
  done
  "$@"
}

# run <name> off|on|deny: one session in its own project dir, its stream in $T/<name>.jsonl
run() {
  local name=$1 w="$T/$1"
  mkdir -p "$w/.claude/skills"
  cp -r "$SKILL_DIR" "$w/.claude/skills/pubmed-literature-search"
  local mod=() allow=('mcp__PubMed__*' Read Glob Grep)
  if [ "$2" = on ]; then mod=(--plugin-dir "$ROOT" --settings "$ON"); allow+=('mcp__ciel-mode__*'); fi
  if [ "$2" = deny ]; then mod=(--plugin-dir "$ROOT" --settings "$DENY"); allow+=('mcp__ciel-mode__*'); fi
  (cd "$w" && clean claude -p "$PROMPT" --model "$MODEL" "${mod[@]}" --mcp-config "$T/mcp.json" --strict-mcp-config \
    --allowedTools "${allow[@]}" --output-format stream-json --verbose < /dev/null > "$T/$name.jsonl" 2> "$T/$name.err")
  echo "done: $name"
}

for i in $(seq 1 "$RUNS"); do run "off$i" off & run "on$i" on & run "deny$i" deny & done
wait

# One row per run: tokens, cost, tool calls, how much tool output reached the context, and the
# Manouchehri check. Manouchehri et al. 2021 (PMID 33653334, PMC7927396) reports long-term RR 1.08
# in its abstract; only its Results give the trim-and-fill estimate RR 1.02 (0.91-1.15). An answer
# that cites the paper passes if it gives that estimate, and fails if it doesn't.
python3 "$E2E/pubmed-report.py" "$T" "$RUNS"

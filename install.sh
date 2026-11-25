#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BUILD=0
NO_RULE=0
FORCE=0
PROJECT_RULE_DIR=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install codex-mcp-agy into Antigravity (agy) global config (~/.gemini/config/).

Options:
  --skip-build          Skip 'npm run build'
  --no-rule             Install MCP config + skill only (skip always-on plugin rule)
  --project-rule <dir>  Also copy AGENTS.md as <dir>/GEMINI.md
  --force               Allow overwriting an existing <dir>/GEMINI.md
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-rule)
      NO_RULE=1
      shift
      ;;
    --project-rule)
      if [[ $# -lt 2 ]]; then
        echo "Error: --project-rule requires a directory argument" >&2
        exit 1
      fi
      PROJECT_RULE_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: 'node' not found in PATH" >&2
  exit 1
fi

CODEX_BIN="$(command -v codex || true)"
if [[ -n "$CODEX_BIN" ]]; then
  CODEX_BIN_DIR="$(dirname "$CODEX_BIN")"
else
  CODEX_BIN_DIR="$HOME/.npm-global/bin"
fi

ENTRYPOINT="$SCRIPT_DIR/dist/src/index.js"
if [[ "$SKIP_BUILD" -eq 0 ]] || [[ ! -f "$ENTRYPOINT" ]]; then
  echo "Building codex-mcp-agy in $SCRIPT_DIR..."
  (cd "$SCRIPT_DIR" && npm run build)
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "Error: compiled entrypoint not found at $ENTRYPOINT" >&2
  exit 1
fi

AGY_CONFIG_DIR="$HOME/.gemini/config"
MCP_CONFIG="$AGY_CONFIG_DIR/mcp_config.json"
SKILL_DEST_DIR="$AGY_CONFIG_DIR/skills/codex-orchestrator"
PLUGIN_DEST_DIR="$AGY_CONFIG_DIR/plugins/codex-orchestrator"

mkdir -p "$AGY_CONFIG_DIR" "$SKILL_DEST_DIR"

# Safely merge mcpServers.codex into ~/.gemini/config/mcp_config.json
"$NODE_BIN" -e '
const fs = require("node:fs");
const [mcpPath, nodeBin, entrypoint, codexBinDir] = process.argv.slice(1);
let cfg = {};
if (fs.existsSync(mcpPath)) {
  const raw = fs.readFileSync(mcpPath, "utf8").trim();
  if (raw.length > 0) {
    cfg = JSON.parse(raw);
  }
}
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
  throw new Error("mcp_config.json must contain a JSON object");
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers)) {
  cfg.mcpServers = {};
}
cfg.mcpServers.codex = {
  command: nodeBin,
  args: [entrypoint],
  env: {
    PATH: `${codexBinDir}:/usr/local/bin:/usr/bin:/bin`,
  },
};
fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
' "$MCP_CONFIG" "$NODE_BIN" "$ENTRYPOINT" "$CODEX_BIN_DIR"

cp "$SCRIPT_DIR/agy/skills/codex-orchestrator/SKILL.md" "$SKILL_DEST_DIR/SKILL.md"

if [[ "$NO_RULE" -eq 0 ]]; then
  mkdir -p "$PLUGIN_DEST_DIR/rules"
  cp "$SCRIPT_DIR/agy/plugin/plugin.json" "$PLUGIN_DEST_DIR/plugin.json"
  cp "$SCRIPT_DIR/agy/plugin/rules/AGENTS.md" "$PLUGIN_DEST_DIR/rules/AGENTS.md"
fi

if [[ -n "$PROJECT_RULE_DIR" ]]; then
  mkdir -p "$PROJECT_RULE_DIR"
  TARGET_GEMINI_MD="$PROJECT_RULE_DIR/GEMINI.md"
  if [[ -e "$TARGET_GEMINI_MD" ]] && [[ "$FORCE" -ne 1 ]]; then
    echo "Error: $TARGET_GEMINI_MD already exists (pass --force to overwrite)" >&2
    exit 1
  fi
  cp "$SCRIPT_DIR/agy/plugin/rules/AGENTS.md" "$TARGET_GEMINI_MD"
  echo "Installed project rule: $TARGET_GEMINI_MD"
fi

echo "Installed codex MCP config: $MCP_CONFIG"
echo "Installed skill:            $SKILL_DEST_DIR/SKILL.md"
if [[ "$NO_RULE" -eq 0 ]]; then
  echo "Installed plugin rule:      $PLUGIN_DEST_DIR/rules/AGENTS.md"
  echo ""
  echo "Toggle always-on delegation rule anytime:"
  echo "  agy plugin disable codex-orchestrator"
  echo "  agy plugin enable codex-orchestrator"
fi
echo ""
echo "Restart or reload agy to pick up changes."

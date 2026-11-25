# codex-mcp-agy

Thin MCP Server wrapping `@openai/codex-sdk` for Antigravity (`agy`), modeled after `openai/codex-plugin-cc`.

Gemini acts as the **Orchestrator / Planner / Reviewer** inside `agy`, while Codex runs as a **delegated Implementer / Independent Reviewer** over stdio MCP.

## Tools Exposed

| Tool | Purpose | Sandbox |
| :--- | :--- | :--- |
| `codex_run` | Delegate implementation, debugging, or investigation (sync or `background: true`, supports `threadId` / `resumeLatest` and `allowedPaths` drift check) | `workspace-write` (default) / `read-only` / `danger-full-access` |
| `codex_review` | Read-only code review of uncommitted changes or against `baseRef` | `read-only` (forced) |
| `codex_adversarial_review` | Steerable read-only adversarial review (`focus`, optional `baseRef`) | `read-only` (forced) |
| `codex_status` | Inspect running or recent jobs and live progress | — |
| `codex_result` | Retrieve full output, `threadId` (`codex resume <id>`), usage, and git diff summary | — |
| `codex_cancel` | Cancel an active background job | — |
| `codex_health` | Check `codex` CLI availability, auth file presence (no secrets), and job store status | — |

## Build & Verify

```bash
npm install
npm run build
npm test
npm run smoke
```

- Persistent job state is stored at `~/.local/state/codex-mcp-agy/jobs.json` (override with `CODEX_MCP_STATE_FILE`).
- Model alias `spark` resolves to `gpt-5.3-codex-spark`.

## Installation & `agy` Integration

This repository includes a self-contained `agy` customization bundle and an idempotent installer:

```text
agy/
├── skills/codex-orchestrator/SKILL.md   # Division-of-labor SOP & Task Spec template
└── plugin/
    ├── plugin.json                      # Toggleable agy plugin manifest
    └── rules/AGENTS.md                  # Always-on division-of-labor thresholds
```

Run `./install.sh` to build (if needed), register `mcpServers.codex` in `~/.gemini/config/mcp_config.json`, and install both the `codex-orchestrator` skill and the toggleable always-on plugin rule:

```bash
./install.sh
# Optional flags:
#   ./install.sh --no-rule                 # Install MCP + skill only (manual invocation)
#   ./install.sh --project-rule /path/repo # Also install as <repo>/GEMINI.md
```

Toggle the always-on delegation rule anytime without removing the `codex` MCP tools:

```bash
agy plugin disable codex-orchestrator
agy plugin enable codex-orchestrator
```

Restart or reload `agy` (or check **Additional Options (...) > MCP Servers**) to pick up changes.

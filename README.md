# codex-mcp-agy

Thin MCP server backed by a persistent `codex app-server` connection for Antigravity (`agy`), modeled after `openai/codex-plugin-cc`.

Gemini acts as the **Orchestrator / Planner / Reviewer** inside `agy`, while Codex runs as a **delegated Implementer / Independent Reviewer** over stdio MCP.

## Tools Exposed

| Tool | Purpose | Sandbox |
| :--- | :--- | :--- |
| `codex_run` | Delegate implementation, debugging, or investigation (sync or `background: true`, supports `threadId` / `resumeLatest` and `allowedPaths` drift check) | `workspace-write` (default) / `read-only` / `danger-full-access` |
| `codex_review` | Read-only code review of uncommitted changes or against `baseRef` | `read-only` (forced) |
| `codex_adversarial_review` | Steerable read-only adversarial review (`focus`, optional `baseRef`) | `read-only` (forced) |
| `codex_status` | Inspect running or recent jobs and live progress | — |
| `codex_result` | Retrieve full output, `threadId` (`codex resume <id>`), usage, and git diff summary | — |
| `codex_steer` | Send a new `prompt` to a running turn by `jobId` | — |
| `codex_respond` | Answer a pending approval or input request by `jobId` | — |
| `codex_cancel` | Interrupt an active turn, including one waiting for a response | — |
| `codex_health` | Check `codex` CLI availability, auth file presence (no secrets), runtime, and job store status | — |

## Build & Verify

```bash
npm install
npm run build
npm test
npm run smoke
```

- Persistent job state is stored at `~/.local/state/codex-mcp-agy/jobs.json` (override with `CODEX_MCP_STATE_FILE`).
- Model alias `spark` resolves to `gpt-5.3-codex-spark`.

## Detached Codex runtime

The MCP server connects to `codex app-server` over an authenticated loopback WebSocket. This mode requires Node.js 22.4 or later and a Codex CLI with capability-token WebSocket support. Node versions without a built-in WebSocket default to stdio. The runtime starts with `systemd-run --user` when available and falls back to a detached process. Setting `CODEX_RUNTIME_NO_SYSTEMD=1`, `OPENAI_API_KEY`, or `CODEX_API_KEY` selects the detached process directly.

The job store directory also contains `runtime.json` with connection and process metadata, `runtime.token` with the private connection token, and `runtime.log` with Codex output. The runtime survives an MCP or terminal restart. The MCP server reconnects after a dropped connection or restart, restores finished results, and subscribes to running turns. Use one MCP server at a time per state directory.

Use `codex_cancel` to interrupt a running turn. For test cleanup, call `stopRuntime(stateDir)` from `dist/src/runtime.js`. Set `CODEX_APP_SERVER_TRANSPORT=stdio` to use a Codex child process tied to the MCP server.

## Wake Antigravity when Codex pauses or finishes

1. Start a job with `codex_run` and `background: true`. Save the returned `jobId`.
2. Start the watcher through Antigravity's `run_command`. Use the same `CODEX_MCP_STATE_FILE` as the MCP server if you override the default.

   ```bash
   node /home/fate/code/Harness/dist/src/cli.js watch --job-id "$JOB_ID" --timeout 120 --interval 250
   ```

3. On exit 0, read the JSON summary from stdout. A `waiting_approval` or `waiting_input` summary includes `pendingRequest`. Use `codex_respond` on the connected MCP server, then start another watch if the job is still running. For a terminal state, use the summary or call `codex_result`. Exit 2 means the watch timed out and can be started again.

Synchronous MCP calls also return when a turn pauses. Send `decision` as `accept`, `acceptForSession`, `decline`, or `cancel` for approvals, or send `answers` keyed by question ID, such as `{"color":["blue"]}`. With `wait: true`, `codex_respond` waits for the next pause or completion. Use `codex_steer` with a `jobId` and `prompt` to update a running turn. Use `approvalPolicy: "on-request"` to allow interactive approvals. Codex CLI 0.171.0 rejects the legacy `on-failure` policy in app-server.

For a standalone run, use the CLI directly.

```bash
node dist/src/cli.js run --prompt "Summarize the changes" --cwd "$PWD" --sandbox read-only
```

`run` uses its own app-server and temporary job store. It prints one JSON summary and exits at the first pause or terminal state. Start the job through MCP when you need to steer it or answer a request.

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

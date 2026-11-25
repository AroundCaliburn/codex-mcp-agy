---
name: codex-orchestrator
description: Orchestrate Gemini (Planner/Reviewer) with Codex (Implementer/Reviewer) via the `codex` MCP server. Use when delegating coding tasks, running independent code/adversarial reviews, steering active turns, responding to Codex approvals/questions, or resuming Codex threads from Antigravity.
---

# Codex Orchestrator Workflow (Gemini Planner + Codex Implementer)

Use the `codex` MCP server tools (`codex_run`, `codex_review`, `codex_adversarial_review`, `codex_status`, `codex_result`, `codex_cancel`, `codex_steer`, `codex_respond`, `codex_health`) to delegate implementation and independent review to Codex while keeping Gemini in charge of architecture, planning, and verification.

## 1. Division-of-Labor Thresholds

- **Gemini Direct (no delegation needed)**:
  - Codebase reconnaissance, reading files, architecture & step-by-step planning
  - Answering questions and explaining behavior
  - Trivial edits (single-line typo, tiny config tweak, doc wording)
  - Running verification/build/test commands and performing final code review
- **Mandatory `codex_run` Delegation**:
  - Feature implementation, bug fixes, multi-file refactoring, and writing/updating tests
  - Always explore read-only first in Gemini, supply explicit `allowedPaths` and exact verification commands, then delegate to `codex_run`
  - Independently inspect `git diff` / `gitSummary.outOfScopeFiles` and run verification tests afterward; if fixes are needed, resume via `codex_run` with `threadId` (or `resumeLatest: true`) for up to 2–3 iterations before re-planning in Gemini
- **High-Risk Changes**:
  - Before finalizing changes touching core runtime, concurrency, security, ABI, build scripts, or broad refactors, run an independent read-only `codex_review` (with optional `baseRef`) or `codex_adversarial_review` (with targeted `focus`).

## 2. Task Spec Template (for `codex_run`)

Before calling `codex_run`, explore read-only to locate exact files/symbols and pass a crisp, self-contained prompt:

```text
Objective: <what must change and why>
Context: <exact file paths, line ranges, and interfaces to follow>
Scope: Only modify files within allowedPaths.
Non-goals: <what NOT to refactor, reformat, or change>
Verification: <exact build/test commands to run before finishing>
Abort conditions: If a prerequisite interface is missing or requirements conflict, stop and report instead of guessing.
```

## 3. Tool Cheat Sheet

| Tool | When to use | Key parameters |
| :--- | :--- | :--- |
| `codex_run` | Implement, fix, refactor, or write tests | `prompt`, `workingDirectory`, `allowedPaths`, `sandboxMode` (`workspace-write`), `approvalPolicy` (`never` or `on-request`), `background`, `threadId` / `resumeLatest`, `model` (`spark` -> `gpt-5.3-codex-spark`), `effort` |
| `codex_steer` | Redirect an active `running` turn without cancelling | `jobId`, `prompt` |
| `codex_respond` | Answer `waiting_approval` or `waiting_input` | `jobId`, `decision?` (`accept` / `acceptForSession` / `decline` / `cancel`), `answers?`, `wait?` |
| `codex_review` | Read-only bug/regression review | `workingDirectory`, `baseRef?`, `background?` |
| `codex_adversarial_review` | Steerable read-only design/risk review | `workingDirectory`, `focus?`, `baseRef?`, `background?` |
| `codex_status` | Poll background jobs & progress | `jobId?`, `workingDirectory?`, `limit?` |
| `codex_result` | Fetch full output, `threadId`, `turnId`, `gitSummary` | `jobId?`, `workingDirectory?` |
| `codex_cancel` | Interrupt an active or paused job | `jobId?`, `workingDirectory?` |
| `codex_health` | Verify `codex` CLI & auth readiness | — |

## 4. Background Wakeup & Bidirectional Control

1. **Passive Wakeup (no polling loops)**:
   - For non-trivial tasks, call `codex_run(..., background: true)` to get `jobId`, then immediately run:
     ```bash
     node /home/fate/code/Harness/dist/src/cli.js watch --job-id <jobId> --timeout 300
     ```
     via `run_command` with `WaitMsBeforeAsync: 500` and `NotificationTimeoutSeconds: 310`, and end the turn.
   - `agy` will automatically wake up as soon as the job reaches `completed`, `failed`, `cancelled`, `interrupted`, `waiting_approval`, or `waiting_input` (if `watch` exits with code `2` on timeout while the job is still running, re-arm `watch`).
2. **Handling `waiting_approval` / `waiting_input`**:
   - Inspect `pendingRequest`. For safe in-scope work, reply via `codex_respond` (and re-arm `watch` if `wait: false`); for destructive or out-of-scope requests, ask the user before approving.
3. **Mid-turn Steering**:
   - If `codex_status` shows Codex drifting while `status === "running"`, call `codex_steer` with `jobId` and a concise correction rather than cancelling.
4. **Independent Verification**:
   - Check `gitSummary.outOfScopeFiles`, inspect `git diff`, and re-run verification commands yourself.
   - If checks fail or review finds local issues, resume (`threadId` / `resumeLatest: true`) for up to 2–3 rounds; if design assumptions fail, re-plan in Gemini.

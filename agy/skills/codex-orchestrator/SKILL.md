---
name: codex-orchestrator
description: Orchestrate Gemini (Planner/Reviewer) with Codex (Implementer/Reviewer) via the `codex` MCP server. Use when delegating coding tasks, running independent code/adversarial reviews, or resuming Codex threads from Antigravity.
---

# Codex Orchestrator Workflow (Gemini Planner + Codex Implementer)

Use the `codex` MCP server tools (`codex_run`, `codex_review`, `codex_adversarial_review`, `codex_status`, `codex_result`, `codex_cancel`, `codex_health`) to delegate implementation and independent review to Codex while keeping Gemini in charge of architecture, planning, and verification.

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
| `codex_run` | Implement, fix, refactor, or write tests | `prompt`, `workingDirectory`, `allowedPaths`, `sandboxMode` (`workspace-write`), `approvalPolicy` (`never`), `background`, `threadId` / `resumeLatest`, `model` (`spark` -> `gpt-5.3-codex-spark`), `effort` |
| `codex_review` | Read-only bug/regression review | `workingDirectory`, `baseRef?`, `background?` |
| `codex_adversarial_review` | Steerable read-only design/risk review | `workingDirectory`, `focus?`, `baseRef?`, `background?` |
| `codex_status` | Poll background jobs & progress | `jobId?`, `workingDirectory?`, `limit?` |
| `codex_result` | Fetch full output, `threadId`, `gitSummary` | `jobId?`, `workingDirectory?` |
| `codex_cancel` | Abort a running background job | `jobId?`, `workingDirectory?` |
| `codex_health` | Verify `codex` CLI & auth readiness | — |

## 4. Verification & Iteration Loop

1. Set `background: true` for non-trivial tasks, monitor with `codex_status`, and retrieve results with `codex_result`.
2. Never rely solely on Codex's self-report:
   - Check `gitSummary.outOfScopeFiles` for unexpected file drift.
   - Inspect `git diff` and re-run the verification commands yourself.
3. If checks fail or review finds local issues:
   - Resume the same Codex thread (`threadId` or `resumeLatest: true`) with exact failure logs/review notes.
   - If 2–3 resume rounds fail to converge or a design assumption is wrong, stop delegating and re-plan in Gemini.

# Codex Orchestrator Division of Labor (Gemini Planner + Codex Implementer)

When the `codex` MCP server is available, follow these division-of-labor thresholds:

- **Gemini handles directly**:
  - Codebase exploration, architecture & implementation planning, answering questions
  - Trivial single-line edits (typos, tiny config tweaks)
  - Running build/test verification commands and reviewing diffs

- **Delegate to `codex_run` (mandatory)**:
  - Feature implementation, bug fixes, multi-file refactoring, and writing/updating tests
  - Before calling `codex_run`, inspect relevant files read-only in Gemini and pass a clear spec with explicit `allowedPaths` and exact verification commands
  - After `codex_run` finishes, independently check `gitSummary.outOfScopeFiles`, inspect `git diff`, and run verification commands yourself
  - For follow-up fixes, resume the same thread via `threadId` (or `resumeLatest: true`) up to 2–3 rounds before re-planning in Gemini

- **High-risk changes**:
  - Before finalizing changes to core runtime, concurrency, security, ABI, build scripts, or broad refactors, run a read-only `codex_review` or `codex_adversarial_review`

Follow the `codex-orchestrator` skill for the full task specification template and tool parameters.

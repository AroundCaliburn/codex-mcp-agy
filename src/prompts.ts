export function buildReviewPrompt(options: { baseRef?: string }): string {
  const targetSection = options.baseRef
    ? `Review all changes on the current branch compared to \`${options.baseRef}\` (run \`git diff ${options.baseRef}...HEAD\` and also check \`git status\` / \`git diff\` for any uncommitted changes).`
    : `Review all current uncommitted changes in the working tree (run \`git status\`, \`git diff\`, and \`git diff --cached\`).`;

  return [
    "You are performing a strict, read-only code review.",
    targetSection,
    "",
    "Constraints:",
    "- Do NOT modify, create, or delete any files.",
    "- Focus on concrete correctness bugs, regressions, edge cases, security/safety hazards, resource/error handling gaps, and missing tests.",
    "- Verify claims by reading the relevant surrounding code.",
    "",
    "Output format:",
    "1. Findings ordered by severity (`P0` critical/blocking, `P1` high, `P2` medium/minor). For each finding, cite exact `file:line`, explain the failure mode, and suggest a minimal fix.",
    "2. If no issues are found, state `No blocking issues found` and briefly note what was checked and any residual test gaps.",
  ].join("\n");
}

export function buildAdversarialReviewPrompt(options: {
  baseRef?: string;
  focus?: string;
}): string {
  const targetSection = options.baseRef
    ? `Target: changes relative to \`${options.baseRef}\` (\`git diff ${options.baseRef}...HEAD\`) plus any uncommitted changes.`
    : `Target: current uncommitted changes (\`git status\`, \`git diff\`, \`git diff --cached\`).`;

  const focusSection = options.focus
    ? `\nSpecial focus requested by the orchestrator:\n${options.focus}\n`
    : "";

  return [
    "You are performing a skeptical, read-only adversarial design & implementation review.",
    targetSection,
    focusSection,
    "Constraints:",
    "- Do NOT modify, create, or delete any files.",
    "- Challenge the chosen design, hidden assumptions, tradeoffs, failure modes, race conditions, rollback/recovery behavior, data integrity, and whether a simpler/safer alternative exists.",
    "- Cite concrete code paths (`file:line`) as evidence rather than giving generic advice.",
    "",
    "Output format:",
    "1. Key architectural/behavioral risks ordered by severity (`P0` / `P1` / `P2`).",
    "2. Unverified assumptions or edge cases.",
    "3. Simpler or safer alternatives if warranted, and concrete verification checks that should pass before accepting.",
  ].join("\n");
}

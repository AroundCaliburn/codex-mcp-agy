import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseTextPayload(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const textBlock = result.content?.find((c) => c.type === "text");
  assert.ok(textBlock?.text, "Expected a text content block");
  return JSON.parse(textBlock.text) as Record<string, unknown>;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-smoke-"));
  const stateFile = path.join(tmpDir, "jobs.json");
  const serverEntry = path.resolve(process.cwd(), "dist", "src", "index.js");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      CODEX_MCP_STATE_FILE: stateFile,
      PATH: `/home/fate/.npm-global/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    },
  });

  const client = new Client({
    name: "codex-mcp-smoke-client",
    version: "0.2.0",
  });

  try {
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "codex_adversarial_review",
      "codex_cancel",
      "codex_health",
      "codex_respond",
      "codex_result",
      "codex_review",
      "codex_run",
      "codex_status",
      "codex_steer",
    ]);
    console.log("listTools OK:", names.join(", "));

    const healthRes = await client.callTool({ name: "codex_health", arguments: {} });
    const health = parseTextPayload(healthRes as { content?: Array<{ type: string; text?: string }> });
    console.log("codex_health:", JSON.stringify(health));
    assert.equal(health.ok, true, "codex_health.ok must be true");

    const statusRes = await client.callTool({ name: "codex_status", arguments: {} });
    const statusPayload = parseTextPayload(statusRes as { content?: Array<{ type: string; text?: string }> });
    assert.equal(statusPayload.count, 0);
    console.log("codex_status OK");

    const runRes = await client.callTool({
      name: "codex_run",
      arguments: {
        prompt: "Reply with exactly: CODEX_MCP_OK",
        workingDirectory: process.cwd(),
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
        background: false,
      },
    });
    const runPayload = parseTextPayload(runRes as { content?: Array<{ type: string; text?: string }> });
    console.log("codex_run result:", JSON.stringify({
      jobId: runPayload.jobId,
      status: runPayload.status,
      threadId: runPayload.threadId,
      turnId: runPayload.turnId,
      finalResponse: runPayload.finalResponse,
      error: runPayload.error,
    }));

    assert.equal(runPayload.status, "completed", `Expected completed, got ${String(runPayload.status)}: ${String(runPayload.error)}`);
    assert.ok(typeof runPayload.threadId === "string" && runPayload.threadId.length > 0, "Expected non-empty threadId");
    assert.ok(typeof runPayload.turnId === "string" && runPayload.turnId.length > 0, "Expected non-empty turnId");
    assert.match(String(runPayload.finalResponse ?? ""), /CODEX_MCP_OK/);
    console.log("Codex app-server round-trip OK!");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

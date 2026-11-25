#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  console.log("mock codex app-server");
  process.exit(0);
}
assert.deepEqual(process.argv.slice(2), ["app-server", "--listen", "stdio://"]);

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const threadId = "fixture-thread";
let turnId;
let turnNumber = 0;
let initialized = false;
let pauseCancelled = false;

const request = (id, method, extra) => ({
  jsonrpc: "2.0", id, method,
  params: { threadId, turnId, itemId: `item-${id}`, ...extra },
});
const ask = (...args) => send(request(...args));

lines.on("line", (line) => {
  const { jsonrpc, id, method, params, result } = JSON.parse(line);
  assert.equal(jsonrpc, "2.0");
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const complete = (status) => notify("turn/completed", { threadId, turn: { id: turnId, status } });
  switch (method) {
    case "initialize": {
      assert.equal(id, 1);
      assert.deepEqual(params.capabilities, { experimentalApi: true, requestAttestation: false });
      const response = JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\r\n";
      process.stdout.write(response.slice(0, 7));
      setImmediate(() => process.stdout.write(response.slice(7)));
      break;
    }
    case "initialized":
      initialized = true;
      break;
    case "thread/start":
    case "thread/resume":
      assert.equal(initialized, true);
      reply({ thread: { id: threadId } });
      break;
    case "turn/start": {
      turnId = `fixture-turn-${++turnNumber}`;
      const turn = { id: turnId, status: "inProgress" };
      const prompt = params.input[0].text;
      if (prompt === "delay turn acknowledgment") {
        const timer = setTimeout(() => reply({ turn }), 3000);
        lines.once("close", () => clearTimeout(timer));
        break;
      }
      notify("turn/started", { threadId, turn });
      reply({ turn });
      if (prompt === "approve then answer") {
        ask("approval-1", "item/commandExecution/requestApproval", { command: "echo fixture" });
      } else if (prompt === "cancel while paused") {
        ask(90, "item/fileChange/requestApproval", { reason: "edit a fixture" });
      } else if (prompt === "queue approvals") {
        const first = request(7, "item/commandExecution/requestApproval", { command: "echo first" });
        const second = request("7", "item/fileChange/requestApproval", { reason: "second approval" });
        process.stdout.write(JSON.stringify(first) + "\n" + JSON.stringify(second) + "\n");
      } else if (prompt === "pause write failure") {
        ask(91, "item/fileChange/requestApproval", { reason: "state write will fail" });
      } else if (prompt === "verify pause cancellation") {
        assert.equal(pauseCancelled, true);
        complete("completed");
      } else if (prompt === "Reply with exactly: CODEX_MCP_OK") {
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", text: "CODEX_MCP_OK" } });
        complete("completed");
      }
      break;
    }
    case "turn/steer":
      assert.equal(params.expectedTurnId, turnId);
      assert.equal(params.input[0].text, "more instructions");
      reply({});
      notify("item/completed", { threadId, turnId, item: { type: "agentMessage", text: "blue" } });
      complete("completed");
      break;
    case "turn/interrupt":
      assert.deepEqual(params, { threadId, turnId });
      complete("interrupted");
      reply({});
      break;
    case "fixture/exit":
      process.exit(1);
      break;
    case undefined:
      if (id === "approval-1") {
        assert.deepEqual(result, { decision: "accept" });
        ask(42, "item/tool/requestUserInput", { questions: [{ id: "color", question: "Which color?" }] });
      } else if (id === 42) {
        assert.deepEqual(result, { answers: { color: { answers: ["blue"] } } });
      } else if (id === 7) {
        assert.deepEqual(result, { decision: "accept" });
      } else if (id === "7") {
        assert.deepEqual(result, { decision: "decline" });
        complete("completed");
      } else if (id === 91) {
        assert.deepEqual(result, { decision: "cancel" });
        pauseCancelled = true;
      }
      break;
    default:
      throw new Error(`Unexpected method: ${method}`);
  }
});

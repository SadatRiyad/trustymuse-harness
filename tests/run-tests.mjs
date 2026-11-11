import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1 tests. Plain Node, no test framework. Each test prints its name and result.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const { BudgetTracker } = await import(path.join(distDir, "budget.js"));
const { OpenAiAdapter } = await import(path.join(distDir, "adapters", "openai.js"));
const { AnthropicAdapter } = await import(path.join(distDir, "adapters", "anthropic.js"));
const { GeminiAdapter } = await import(path.join(distDir, "adapters", "gemini.js"));
const { generatePacket, validatePacketResult } = await import(path.join(distDir, "packet.js"));
const { appendAudit, readAuditEvents } = await import(path.join(distDir, "audit.js"));
const { checkPolicy } = await import(path.join(distDir, "policy.js"));
const { routeTask } = await import(path.join(distDir, "router.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-test-"));
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

const config0 = {
  monthlyCapUsd: 0,
  currency: "USD",
  warnAtPercent: 80,
  apiEnabled: false,
  subscriptionEnabled: true,
  subscriptionModels: ["chatgpt", "claude"],
  hold: false,
  requireApprovalFor: ["publish", "send", "merge", "deploy"],
};

// Test 1: budget 0 blocks a paid API call.
const budget0 = new BudgetTracker(0, 80, tmp);
const check0 = budget0.canSpend(0.01);
assert.strictEqual(check0.allowed, false, "Budget 0 must block spend");
assert.strictEqual(budget0.getStatus().blocked, true, "Budget status must be blocked at cap 0");
const openai = new OpenAiAdapter();
const blocked = await openai.call({ prompt: "Hello", taskType: "content", model: "openai-api" }, config0, budget0);
assert.strictEqual(blocked.blocked, true, "OpenAI adapter must return blocked at budget 0");
assert.strictEqual(blocked.ok, false, "OpenAI adapter must not return ok at budget 0");
const anthropic = new AnthropicAdapter();
const blocked2 = await anthropic.call({ prompt: "Hello", taskType: "content", model: "anthropic-api" }, config0, budget0);
assert.strictEqual(blocked2.blocked, true, "Anthropic adapter must return blocked at budget 0");
const gemini = new GeminiAdapter();
const blocked3 = await gemini.call({ prompt: "Hello", taskType: "content", model: "gemini-api" }, config0, budget0);
assert.strictEqual(blocked3.blocked, true, "Gemini adapter must return blocked at budget 0");
ok("budget 0 blocks OpenAI, Anthropic, and Gemini API calls");

// Test 2: budget warning logic works when a cap is set.
const budget10 = new BudgetTracker(10, 80, tmp);
assert.strictEqual(budget10.canSpend(1).allowed, true, "Spend within cap must be allowed");
budget10.recordSpend(8.5);
const status10 = budget10.getStatus();
assert.strictEqual(status10.warning, true, "Usage at 85 percent must trigger the 80 percent warning");
assert.strictEqual(budget10.canSpend(2).allowed, false, "Spend above the cap must be blocked");
ok("budget cap, 80 percent warning, and hard stop work");

// Test 3: packet generation works for chatgpt and claude.
const outDir = path.join(tmp, "packets");
const packetChat = generatePacket({ model: "chatgpt", taskType: "seo", title: "Test SEO task", task: "Write a draft about finding clients." }, outDir);
const packetClaude = generatePacket({ model: "claude", taskType: "code_review", title: "Test review task", task: "Review this code for bugs." }, outDir);
assert.ok(fs.existsSync(packetChat.filePath), "ChatGPT packet file must exist");
assert.ok(fs.existsSync(packetClaude.filePath), "Claude packet file must exist");
assert.ok(packetChat.content.includes("ChatGPT"), "ChatGPT packet must name ChatGPT");
assert.ok(packetClaude.content.includes("Claude"), "Claude packet must name Claude");
assert.ok(packetChat.content.includes("Expected output format"), "Packet must include the expected output format");
assert.ok(packetClaude.content.includes("Verification"), "Packet must include verification guidance");
ok("packet generation works for chatgpt and claude");

// Test 4: packet result validation works.
assert.strictEqual(validatePacketResult("").valid, false, "Empty result must be invalid");
assert.strictEqual(validatePacketResult("short").valid, false, "Very short result must be invalid");
assert.strictEqual(validatePacketResult("This is a real draft result with enough content to check.").valid, true, "A real result must be valid");
ok("packet result validation works");

// Test 5: audit log is written and can be read back.
appendAudit({ at: new Date().toISOString(), runId: "test-run-1", event: "test_event", model: "chatgpt", taskType: "seo", result: "ok" }, tmp);
const events = readAuditEvents(tmp);
assert.ok(events.length >= 1, "Audit log must contain at least one event");
assert.strictEqual(events[events.length - 1].event, "test_event", "Last audit event must match the test event");
ok("audit log is written and readable");

// Test 6: policy blocks publish, send, merge, and deploy, and HOLD blocks writes.
assert.strictEqual(checkPolicy("publish", 1, false).allowed, false, "Publish must never be automatic");
assert.strictEqual(checkPolicy("send", 2, false).allowed, false, "Send must need per item approval");
assert.strictEqual(checkPolicy("merge", 2, false).allowed, false, "Merge must need per item approval");
assert.strictEqual(checkPolicy("deploy", 2, false).allowed, false, "Deploy must need per item approval");
assert.strictEqual(checkPolicy("draft", 1, false).allowed, true, "Draft must be allowed");
assert.strictEqual(checkPolicy("draft", 1, true).allowed, false, "HOLD must block even a draft write path");
ok("policy blocks publish, send, merge, and deploy, and HOLD blocks writes");

// Test 7: router maps V1 tasks to ChatGPT and Claude.
assert.strictEqual(routeTask("seo").primaryModel, "chatgpt", "SEO must route to ChatGPT first in V1");
assert.strictEqual(routeTask("code_review").primaryModel, "claude", "Code review must route to Claude first in V1");
assert.strictEqual(routeTask("research").slot, "research", "Research must use the research slot");
ok("router maps seo and code_review to the V1 models");

console.log(`All ${passed} test groups passed. Temp dir: ${tmp}`);

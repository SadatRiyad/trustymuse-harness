import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.5 subscription model tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live prompt, no GitHub, no deploy.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const srcDir = path.join(__dirname, "..", "src");
const {
  MODEL_REGISTRY,
  getModel,
  getSubscriptionModel,
  isBrowserWired,
  listApiModels,
  listSubscriptionModels,
} = await import(path.join(distDir, "registry.js"));
const {
  assertBrowserAllowed,
  assertPacketAllowed,
  connectModel,
  disconnectModel,
  isModelConnected,
  listConnectedModels,
  loadConnectedIds,
  modelsFilePath,
} = await import(path.join(distDir, "models", "connect.js"));
const { modelsForSlot } = await import(path.join(distDir, "router.js"));
const { buildPacketContent } = await import(path.join(distDir, "packet.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-models-test-"));
const harnessRoot = path.join(tmp, "harness");
fs.mkdirSync(harnessRoot, { recursive: true });

function makeCtx(tenantId) {
  const stateDir = path.join(harnessRoot, "state", "tenants", tenantId);
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    rootDir: harnessRoot,
    tenantId,
    tenant: {
      id: tenantId,
      displayName: `Tenant ${tenantId}`,
      museAccountLabel: `Tenant ${tenantId}`,
      status: "active",
      monthlyCapUsd: 0,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    },
    stateDir,
    profileRoot: path.join(harnessRoot, "profiles", tenantId),
  };
}

const ctxA = makeCtx("tenant-a");
const ctxB = makeCtx("tenant-b");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

// Test 1: the registry lists 9 subscription models with the exact chat URLs.
const subs = listSubscriptionModels();
assert.strictEqual(subs.length, 9, "Nine subscription models must be listed");
const urls = new Map(subs.map((m) => [m.id, m.chatUrl]));
assert.strictEqual(urls.get("chatgpt"), "https://chatgpt.com", "ChatGPT chat URL must be exact");
assert.strictEqual(urls.get("claude"), "https://claude.ai", "Claude chat URL must be exact");
assert.strictEqual(urls.get("gemini"), "https://gemini.google.com", "Gemini chat URL must be exact");
assert.strictEqual(urls.get("grok"), "https://grok.com", "Grok chat URL must be exact");
assert.strictEqual(urls.get("deepseek"), "https://chat.deepseek.com", "DeepSeek chat URL must be exact");
assert.strictEqual(urls.get("perplexity"), "https://perplexity.ai", "Perplexity chat URL must be exact");
assert.strictEqual(urls.get("meta-ai"), "https://meta.ai", "Meta AI chat URL must be exact");
assert.strictEqual(urls.get("copilot"), "https://copilot.microsoft.com", "Copilot chat URL must be exact");
assert.strictEqual(urls.get("mistral"), "https://chat.mistral.ai", "Mistral chat URL must be exact");
for (const model of subs) {
  assert.strictEqual(model.connection, "subscription", `${model.id} must be a subscription model`);
  assert.strictEqual(model.costMode, "free", `${model.id} must be free`);
  assert.strictEqual(model.status, "enabled", `${model.id} must be enabled`);
  assert.ok(model.chatUrl.startsWith("https://"), `${model.id} must have an https chat URL`);
}
ok("registry lists 9 subscription models with correct chat URLs");

// Test 2: the 7 new models are packet-only, chatgpt and claude stay wired,
// and the API entries are unchanged, gemini-api separate from gemini.
for (const id of ["gemini", "grok", "deepseek", "perplexity", "meta-ai", "copilot", "mistral"]) {
  assert.strictEqual(getModel(id).browserSupport, "packet-only", `${id} must be packet-only`);
}
assert.strictEqual(getModel("chatgpt").browserSupport, "wired", "ChatGPT must stay wired");
assert.strictEqual(getModel("claude").browserSupport, "wired", "Claude must stay wired");
const apis = listApiModels();
assert.strictEqual(apis.length, 3, "Three API models must remain");
assert.strictEqual(getModel("gemini-api").connection, "api", "gemini-api must stay an API model");
assert.strictEqual(getModel("gemini-api").status, "disabled", "gemini-api must stay disabled");
assert.strictEqual(getModel("gemini-api").chatUrl, "", "API models must have no chat URL");
assert.notStrictEqual(getModel("gemini").id, getModel("gemini-api").id, "gemini subscription and gemini-api must be separate entries");
assert.strictEqual(MODEL_REGISTRY.length, 12, "Registry must hold 9 subscription plus 3 API models");
ok("7 new models are packet-only, chatgpt and claude stay wired, API models unchanged");

// Test 3: helpers getSubscriptionModel and isBrowserWired.
assert.strictEqual(getSubscriptionModel("gemini").id, "gemini", "getSubscriptionModel must return the Gemini entry");
assert.strictEqual(getSubscriptionModel("openai-api"), undefined, "getSubscriptionModel must return undefined for an API model");
assert.strictEqual(getSubscriptionModel("no-such-model"), undefined, "getSubscriptionModel must return undefined for an unknown model");
assert.strictEqual(isBrowserWired("chatgpt"), true, "isBrowserWired must be true for chatgpt");
assert.strictEqual(isBrowserWired("claude"), true, "isBrowserWired must be true for claude");
assert.strictEqual(isBrowserWired("gemini"), false, "isBrowserWired must be false for gemini");
assert.strictEqual(isBrowserWired("grok"), false, "isBrowserWired must be false for grok");
assert.strictEqual(isBrowserWired("no-such-model"), false, "isBrowserWired must be false for an unknown model");
ok("subscription and browser-wired helpers work");

// Test 4: a fresh tenant seeds chatgpt and claude connected, and the file
// is written to that tenant's own state directory.
const seeded = loadConnectedIds(ctxA);
assert.deepStrictEqual(seeded, ["chatgpt", "claude"], "A fresh tenant must seed chatgpt and claude connected");
assert.ok(fs.existsSync(modelsFilePath(ctxA)), "models.json must be written on first read");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxA), "utf-8")), ["chatgpt", "claude"], "Seeded file must hold only the two default ids");
assert.strictEqual(isModelConnected(ctxA, "chatgpt"), true, "chatgpt must be connected for a fresh tenant");
assert.strictEqual(isModelConnected(ctxA, "gemini"), false, "gemini must start disconnected for a fresh tenant");
ok("fresh tenant seeds chatgpt and claude connected");

// Test 5: connect then packet works for gemini and grok, and the packet
// names the model and its chat URL.
connectModel(ctxA, "gemini");
connectModel(ctxA, "grok");
assert.strictEqual(isModelConnected(ctxA, "gemini"), true, "gemini must be connected after model-connect");
assert.strictEqual(isModelConnected(ctxA, "grok"), true, "grok must be connected after model-connect");
assert.doesNotThrow(() => assertPacketAllowed(ctxA, "gemini"), "Packet gate must allow a connected gemini");
assert.doesNotThrow(() => assertPacketAllowed(ctxA, "grok"), "Packet gate must allow a connected grok");
const geminiPacket = buildPacketContent({ model: "gemini", taskType: "seo", title: "Gemini test", task: "Write a draft." });
assert.ok(geminiPacket.includes("Gemini"), "Packet must name the Gemini model");
assert.ok(geminiPacket.includes("https://gemini.google.com"), "Packet must include the Gemini chat URL");
assert.ok(geminiPacket.includes("not wired for this model"), "Packet must state browser mode is not wired for Gemini");
const grokPacket = buildPacketContent({ model: "grok", taskType: "content", title: "Grok test", task: "Write a draft." });
assert.ok(grokPacket.includes("https://grok.com"), "Packet must include the Grok chat URL");
ok("connect then packet works for gemini and grok, packet names model and chat URL");

// Test 6: the packet gate refuses an unconnected model.
assert.throws(
  () => assertPacketAllowed(ctxA, "deepseek"),
  /connect it first with model-connect/i,
  "Packet for an unconnected model must be refused with the connect-first message",
);
assert.throws(
  () => assertPacketAllowed(ctxB, "gemini"),
  /connect it first/i,
  "Packet for a model connected on another tenant only must be refused here",
);
ok("packet refuses an unconnected model");

// Test 7: the packet gate refuses API models.
assert.throws(
  () => assertPacketAllowed(ctxA, "openai-api"),
  /API model/,
  "Packet for openai-api must be refused as an API model",
);
assert.throws(
  () => assertPacketAllowed(ctxA, "gemini-api"),
  /API model/,
  "Packet for gemini-api must be refused as an API model, even though gemini subscription is connected",
);
ok("packet refuses an API model");

// Test 8: the packet gate refuses an unknown model.
assert.throws(
  () => assertPacketAllowed(ctxA, "no-such-model"),
  /not known/,
  "Packet for an unknown model must fail closed",
);
ok("packet refuses an unknown model");

// Test 9: the browser gate refuses packet-only models and allows the wired ones.
for (const id of ["gemini", "grok", "deepseek", "perplexity", "meta-ai", "copilot", "mistral"]) {
  assert.throws(
    () => assertBrowserAllowed(id),
    /browser driver is not wired for .* yet, use packet mode/i,
    `run-browser must refuse packet-only model ${id}`,
  );
}
assert.doesNotThrow(() => assertBrowserAllowed("chatgpt"), "Browser gate must allow chatgpt");
assert.doesNotThrow(() => assertBrowserAllowed("claude"), "Browser gate must allow claude");
assert.throws(() => assertBrowserAllowed("openai-api"), /API model/, "Browser gate must refuse an API model");
assert.throws(() => assertBrowserAllowed("no-such-model"), /not known/, "Browser gate must refuse an unknown model");
ok("run-browser refuses packet-only models and allows chatgpt and claude");

// Test 10: disconnect then packet refuses again.
connectModel(ctxA, "deepseek");
assert.strictEqual(isModelConnected(ctxA, "deepseek"), true, "deepseek must be connected before the disconnect test");
disconnectModel(ctxA, "deepseek");
assert.strictEqual(isModelConnected(ctxA, "deepseek"), false, "deepseek must be disconnected after model-disconnect");
assert.throws(
  () => assertPacketAllowed(ctxA, "deepseek"),
  /connect it first/i,
  "Packet after disconnect must be refused again",
);
assert.throws(() => disconnectModel(ctxA, "deepseek"), /not connected/, "Disconnecting an unconnected model must fail closed");
ok("disconnect then packet refuses again");

// Test 11: connect is per tenant. Tenant A connecting gemini must not
// change tenant B, and each tenant lists only its own connected models.
assert.strictEqual(isModelConnected(ctxB, "gemini"), false, "Tenant B must not see tenant A's gemini connection");
const connectedA = listConnectedModels(ctxA).map((m) => m.id);
assert.ok(connectedA.includes("gemini"), "Tenant A list must include gemini");
assert.ok(connectedA.includes("grok"), "Tenant A list must include grok");
const connectedB = listConnectedModels(ctxB).map((m) => m.id);
assert.deepStrictEqual(connectedB, ["chatgpt", "claude"], "Tenant B list must hold only the seeded defaults");
assert.ok(!fs.existsSync(path.join(ctxB.stateDir, "models.json")) || JSON.parse(fs.readFileSync(modelsFilePath(ctxB), "utf-8")).every((id) => ["chatgpt", "claude"].includes(id)), "Tenant B file must never contain tenant A's models");
ok("connect is per tenant");

// Test 12: connect rejects an API model and an unknown model, changing nothing.
assert.throws(() => connectModel(ctxA, "openai-api"), /API model.*separate flow/, "Connecting an API model must be refused");
assert.throws(() => connectModel(ctxA, "gemini-api"), /API model/, "Connecting gemini-api must be refused");
assert.throws(() => connectModel(ctxA, "no-such-model"), /not known/, "Connecting an unknown model must be refused");
assert.deepStrictEqual(loadConnectedIds(ctxA), ["chatgpt", "claude", "gemini", "grok"], "Failed connects must not change the connected list");
ok("connect rejects an API model and an unknown model");

// Test 13: disconnect refuses chatgpt while it has an active browser
// account, and allows it when there is none.
assert.throws(
  () => disconnectModel(ctxA, "chatgpt", { hasActiveAccount: true }),
  /still has an active browser account/,
  "Disconnecting chatgpt with an active browser account must be refused",
);
assert.strictEqual(isModelConnected(ctxA, "chatgpt"), true, "Refused disconnect must leave chatgpt connected");
const afterDisconnect = disconnectModel(ctxA, "chatgpt", { hasActiveAccount: false });
assert.ok(!afterDisconnect.includes("chatgpt"), "Disconnect without an active account must remove chatgpt");
assert.throws(() => assertPacketAllowed(ctxA, "chatgpt"), /connect it first/i, "Packet for disconnected chatgpt must be refused");
connectModel(ctxA, "chatgpt");
assert.strictEqual(isModelConnected(ctxA, "chatgpt"), true, "Reconnecting chatgpt must work again");
ok("disconnect refuses chatgpt with an active browser account");

// Test 14: slot suggestions are suggestions only, labelled as such.
assert.deepStrictEqual(modelsForSlot("drafting"), ["chatgpt", "claude", "gemini", "grok", "deepseek"], "Drafting suggestions must match the spec");
assert.deepStrictEqual(modelsForSlot("research"), ["perplexity", "claude", "gemini"], "Research suggestions must match the spec");
assert.deepStrictEqual(modelsForSlot("coding"), ["claude", "chatgpt", "deepseek"], "Coding suggestions must match the spec");
assert.deepStrictEqual(modelsForSlot("reasoning"), ["claude", "grok", "gemini"], "Reasoning suggestions must match the spec");
assert.deepStrictEqual(modelsForSlot("media"), ["gemini", "chatgpt"], "Media suggestions must match the spec");
const routerText = fs.readFileSync(path.join(srcDir, "router.ts"), "utf-8");
assert.ok(routerText.includes("SUGGESTIONS ONLY"), "Router must label slot models as suggestions only");
ok("slot suggestions match the spec and are labelled suggestions only");

// Test 15: no credential field exists anywhere in the new connect state.
// The stored file holds only model ids, and the new source assigns no
// password, token, or key field anywhere.
const storedText = fs.readFileSync(modelsFilePath(ctxA), "utf-8").toLowerCase();
for (const marker of ["password", "apikey", "api_key", "sessiontoken", "cookie", "secret"]) {
  assert.ok(!storedText.includes(marker), `Stored models.json must never contain ${marker}`);
}
const connectSource = fs.readFileSync(path.join(srcDir, "models", "connect.ts"), "utf-8");
for (const pattern of [/password\s*:/i, /apiKey\s*:/i, /sessionToken\s*:/i, /cookie\s*:/i, /process\.env\./]) {
  assert.ok(!pattern.test(connectSource), `connect.ts must not contain ${pattern}`);
}
assert.ok(connectSource.includes("never logs in, never stores a password"), "connect.ts must state that connecting never stores a password");
ok("no credential field exists in the new connect state or code");

console.log(`All ${passed} test groups passed. Temp dir: ${tmp}`);

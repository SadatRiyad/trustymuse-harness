import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.7 connected-means tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live prompt, no GitHub, no deploy.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const rootDir = path.join(__dirname, "..");
const {
  CONNECTED_LEGEND,
  connectModel,
  disconnectModel,
  isModelConnected,
  listConnectedModels,
  loadConnectedIds,
  modelsFilePath,
} = await import(path.join(distDir, "models", "connect.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-model-connect-test-"));
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

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

const ALL_NINE = ["chatgpt", "claude", "gemini", "grok", "deepseek", "perplexity", "meta-ai", "copilot", "mistral"];

// Test 1: a fresh tenant has 0 connected models. No auto-seed: the first
// read writes an empty list to disk, and nothing is connected.
const ctxFresh = makeCtx("fresh-tenant");
assert.deepStrictEqual(loadConnectedIds(ctxFresh), [], "A fresh tenant must start with zero connected models");
assert.ok(fs.existsSync(modelsFilePath(ctxFresh)), "models.json must be written on first read");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxFresh), "utf-8")), [], "Fresh file must hold an empty list");
assert.strictEqual(listConnectedModels(ctxFresh).length, 0, "listConnectedModels must be empty for a fresh tenant");
assert.strictEqual(isModelConnected(ctxFresh, "chatgpt"), false, "chatgpt must not be connected for a fresh tenant");
assert.strictEqual(isModelConnected(ctxFresh, "claude"), false, "claude must not be connected for a fresh tenant");
ok("fresh tenant has 0 connected models");

// Test 2: model-connect adds exactly one model and only that one.
connectModel(ctxFresh, "gemini");
assert.deepStrictEqual(loadConnectedIds(ctxFresh), ["gemini"], "model-connect must add exactly one model");
assert.strictEqual(isModelConnected(ctxFresh, "gemini"), true, "gemini must be connected after model-connect");
assert.strictEqual(isModelConnected(ctxFresh, "chatgpt"), false, "chatgpt must stay disconnected when only gemini was connected");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxFresh), "utf-8")), ["gemini"], "Stored file must hold only gemini");
ok("model-connect adds exactly one model and only that one");

// Test 3: model-disconnect removes it, and the list is empty again.
disconnectModel(ctxFresh, "gemini");
assert.deepStrictEqual(loadConnectedIds(ctxFresh), [], "model-disconnect must leave an empty list");
assert.strictEqual(isModelConnected(ctxFresh, "gemini"), false, "gemini must be disconnected after model-disconnect");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxFresh), "utf-8")), [], "Stored file must be empty again after disconnect");
ok("model-disconnect removes it, list is empty again");

// Test 4: a pre-existing models.json with all 9 entries still loads as 9.
// Explicit connections are preserved exactly, in order, after the fix.
const ctxNine = makeCtx("nine-tenant");
fs.writeFileSync(modelsFilePath(ctxNine), JSON.stringify(ALL_NINE, null, 2) + "\n", "utf-8");
assert.deepStrictEqual(loadConnectedIds(ctxNine), ALL_NINE, "A pre-existing 9-model file must still load as 9");
assert.strictEqual(listConnectedModels(ctxNine).length, 9, "listConnectedModels must return 9 entries");
assert.deepStrictEqual(
  listConnectedModels(ctxNine).map((m) => m.id),
  ALL_NINE,
  "Listed ids must match the stored file in order",
);
ok("pre-existing 9-model file still loads as 9");

// Test 5: a pre-existing file with the old seeded pair is preserved
// exactly on load. Loading never disconnects anything.
const ctxPair = makeCtx("pair-tenant");
fs.writeFileSync(modelsFilePath(ctxPair), JSON.stringify(["chatgpt", "claude"], null, 2) + "\n", "utf-8");
assert.deepStrictEqual(loadConnectedIds(ctxPair), ["chatgpt", "claude"], "A pre-existing pair must load exactly as stored");
assert.deepStrictEqual(loadConnectedIds(ctxPair), ["chatgpt", "claude"], "A second load must not change the pair");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxPair), "utf-8")), ["chatgpt", "claude"], "Stored file must be untouched by loading");
ok("pre-existing pair file is preserved exactly on load");

// Test 6: connecting the same model twice does not duplicate it.
const ctxDup = makeCtx("dup-tenant");
connectModel(ctxDup, "grok");
connectModel(ctxDup, "grok");
assert.deepStrictEqual(loadConnectedIds(ctxDup), ["grok"], "Connecting twice must not duplicate the model");
connectModel(ctxDup, "grok");
assert.deepStrictEqual(loadConnectedIds(ctxDup), ["grok"], "Connecting a third time must still not duplicate it");
ok("connecting the same model twice does not duplicate it");

// Test 7: unknown model connect is refused, changing nothing.
const ctxUnknown = makeCtx("unknown-tenant");
assert.throws(() => connectModel(ctxUnknown, "no-such-model"), /not known/, "Connecting an unknown model must be refused");
assert.deepStrictEqual(loadConnectedIds(ctxUnknown), [], "A refused connect must leave the list empty");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsFilePath(ctxUnknown), "utf-8")), [], "A refused connect must not change the stored file");
ok("unknown model connect is refused");

// Test 8: API model connect is refused, changing nothing.
const ctxApi = makeCtx("api-tenant");
assert.throws(() => connectModel(ctxApi, "openai-api"), /API model/, "Connecting openai-api must be refused");
assert.throws(() => connectModel(ctxApi, "gemini-api"), /API model/, "Connecting gemini-api must be refused");
assert.deepStrictEqual(loadConnectedIds(ctxApi), [], "Refused API connects must leave the list empty");
ok("API model connect is refused");

// Test 9: the real CLI prints the legend line in status and model-list.
// A scratch copy of the built CLI is used, so the real tenant state is
// never touched: setup creates a fresh tenant, status and model-list run
// against it, and both must show the legend and zero connected models.
const cliRoot = path.join(tmp, "cli-harness");
fs.mkdirSync(cliRoot, { recursive: true });
fs.cpSync(distDir, path.join(cliRoot, "dist"), { recursive: true });
fs.copyFileSync(path.join(rootDir, "config.example.yaml"), path.join(cliRoot, "config.example.yaml"));
const cli = path.join(cliRoot, "dist", "index.js");
function runCli(...args) {
  return execFileSync("node", [cli, ...args], { encoding: "utf-8", cwd: cliRoot });
}
const setupOut = runCli("setup", "--id", "fresh-one", "--name", "Fresh One");
assert.ok(setupOut.includes("Tenant created: fresh-one"), "CLI setup must create the fresh tenant");
const statusOut = runCli("status");
assert.ok(statusOut.includes("Connected subscription models for tenant fresh-one: none"), "CLI status must show none connected for a fresh tenant");
assert.ok(statusOut.includes(CONNECTED_LEGEND), "CLI status must print the connected legend line");
assert.ok(statusOut.includes("not a live login"), "Legend must say it is not a live login");
assert.ok(statusOut.includes("browser-status"), "Legend must point at browser-status for chatgpt and claude");
const listOut = runCli("model-list");
assert.ok(listOut.includes(CONNECTED_LEGEND), "CLI model-list must print the connected legend line");
assert.ok(listOut.includes("chatgpt") && listOut.includes("not connected"), "CLI model-list must show chatgpt as not connected for a fresh tenant");
const connectOut = runCli("model-connect", "--model", "chatgpt");
assert.ok(connectOut.includes("Model connected for tenant fresh-one"), "CLI model-connect must connect chatgpt on request");
const listAfterOut = runCli("model-list");
assert.ok(listAfterOut.includes("chatgpt") && listAfterOut.includes("connected"), "CLI model-list must show chatgpt as connected after model-connect");
assert.ok(listAfterOut.includes(CONNECTED_LEGEND), "CLI model-list must still print the legend after a connect");
ok("status and model-list print the legend line in the real CLI");

console.log(`All ${passed} test groups passed. Temp dir: ${tmp}`);

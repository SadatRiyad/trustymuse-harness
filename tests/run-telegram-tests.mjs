import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.9 Telegram Bot tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live Telegram call, no real token.
// The Telegram API is a local mock: a fake getUpdates queue and a
// sendMessage recorder. Nothing in this suite calls api.telegram.org.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const rootDir = path.join(__dirname, "..");
const srcDir = path.join(__dirname, "..", "src", "telegram");
const {
  TelegramBot,
  createTelegramBot,
  allowTelegramUser,
  denyTelegramUser,
  isTelegramUserAllowed,
  loadAllowlist,
  loadTelegramState,
  setTelegramFileToken,
  clearTelegramFileToken,
  getTelegramTokenSource,
  requireTelegramToken,
  parseDoInstruction,
  auditPassedByMarkers,
  tokenizeArgs,
  truncateForTelegram,
} = await import(path.join(distDir, "telegram", "bot.js"));
const { loadConfig } = await import(path.join(distDir, "config.js"));
const { appendAudit, readAuditEvents } = await import(path.join(distDir, "audit.js"));
const { addTenant } = await import(path.join(distDir, "tenants", "tenants.js"));
const { addAccount, loadAccounts, saveAccounts, todayKey } = await import(path.join(distDir, "session", "accounts.js"));
const { MockBrowserDriver } = await import(path.join(distDir, "session", "browser.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-telegram-test-"));
const repoVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).version;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

let fakeNow = Date.now();
const now = () => fakeNow;

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function makeCtx(root, id, displayName) {
  const stateDir = path.join(root, "state", "tenants", id);
  fs.mkdirSync(stateDir, { recursive: true });
  const tenant = addTenant({ id, displayName: displayName || id, museAccountLabel: displayName || id }, { rootDir: root });
  return { rootDir: root, tenantId: id, tenant, stateDir, profileRoot: path.join(root, "profiles", id) };
}

function makeUpdate(updateId, userId, text, chatId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, first_name: "Test" },
      chat: { id: chatId === undefined ? userId : chatId },
      date: Math.floor(fakeNow / 1000),
      text,
    },
  };
}

function readAudit(root, tenantId) {
  const file = path.join(root, "state", "tenants", tenantId, "audit.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

class MockTelegramApi {
  constructor() {
    this.queued = [];
    this.sent = [];
  }
  queue(update) {
    this.queued.push(update);
  }
  async getUpdates(offset) {
    const out = this.queued.filter((u) => offset === null || u.update_id >= offset);
    this.queued = this.queued.filter((u) => !(offset === null || u.update_id >= offset));
    return out;
  }
  async sendMessage(chatId, text) {
    this.sent.push({ chatId, text });
  }
}

function makeBot(root, ctx, config, api, extra) {
  return createTelegramBot({ rootDir: root, ctx, config, api, now, ...(extra || {}) });
}

function writeBrowserConfig(root) {
  fs.writeFileSync(
    path.join(root, "config.yaml"),
    "browser:\n  enabled: true\n  headless: true\n  pacing_ms: 8000\n  daily_limit_per_account: 20\n",
    "utf-8",
  );
}

function makeAccount(root, ctx, provider, id, connected) {
  const account = addAccount(
    { provider, id, label: `${provider} ${id}` },
    { rootDir: root, profileRoot: path.join(root, "profiles"), tenantId: ctx.tenantId },
  );
  if (connected) {
    const accounts = loadAccounts(root, ctx.tenantId);
    const found = accounts.find((a) => a.id === id);
    found.browserConnected = true;
    found.browserConnectedAt = new Date().toISOString();
    found.browserLastVerified = new Date().toISOString();
    saveAccounts(accounts, root, ctx.tenantId);
  }
  return account;
}

function mockDriverFactory(responses) {
  return (account) => new MockBrowserDriver({ responseText: responses[account.provider] || `Mock response for ${account.provider}.` });
}

// The temp root needs a package.json so /status can read the version.
fs.copyFileSync(path.join(rootDir, "package.json"), path.join(tmp, "package.json"));

// 1. Allowlist add, list, and remove.
{
  const root = path.join(tmp, "allowlist");
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(loadAllowlist(root), []);
  allowTelegramUser(root, 111, "Owner");
  allowTelegramUser(root, 222, "Helper");
  assert.equal(isTelegramUserAllowed(root, 111), true);
  assert.equal(isTelegramUserAllowed(root, 333), false);
  const list = loadAllowlist(root);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 111);
  assert.equal(list[0].label, "Owner");
  allowTelegramUser(root, 111, "Owner Renamed");
  assert.equal(loadAllowlist(root).length, 2);
  assert.equal(loadAllowlist(root)[0].label, "Owner Renamed");
  assert.equal(denyTelegramUser(root, 222), true);
  assert.equal(denyTelegramUser(root, 222), false);
  assert.equal(loadAllowlist(root).length, 1);
  ok("allowlist add, list, and remove");
}

// 2. Allowlist rejects bad user ids and bad labels.
{
  const root = path.join(tmp, "allowlist-bad");
  fs.mkdirSync(root, { recursive: true });
  assert.throws(() => allowTelegramUser(root, 0, "Zero"), /positive integer/);
  assert.throws(() => allowTelegramUser(root, -5, "Negative"), /positive integer/);
  assert.throws(() => allowTelegramUser(root, 1.5, "Float"), /positive integer/);
  assert.throws(() => allowTelegramUser(root, Number.NaN, "NaN"), /positive integer/);
  assert.throws(() => allowTelegramUser(root, 123, ""), /non-empty/);
  assert.throws(() => allowTelegramUser(root, 123, "   "), /non-empty/);
  assert.throws(() => allowTelegramUser(root, 123, "x".repeat(101)), /at most 100/);
  assert.throws(() => allowTelegramUser(root, 123, "two\nlines"), /one line/);
  assert.deepEqual(loadAllowlist(root), []);
  ok("allowlist rejects bad user ids and bad labels");
}

// 3. Unauthorized user gets no reply, and the attempt is audit logged.
{
  const root = path.join(tmp, "unauth");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 999, "/status"));
  assert.equal(api.sent.length, 0);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_unauthorized");
  assert.equal(events[0].result, "blocked");
  assert.ok(events[0].detail.includes("telegram_user:999"));
  assert.ok(!events[0].detail.includes("9999"));
  ok("unauthorized user gets no reply and the attempt is audit logged");
}

// 4. Unauthorized repeat within a minute is not logged twice.
{
  const root = path.join(tmp, "unauth-throttle");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 999, "/status"));
  await bot.handleUpdate(makeUpdate(2, 999, "/help"));
  assert.equal(readAudit(root, "demo-tenant").length, 1);
  fakeNow += 61 * 1000;
  await bot.handleUpdate(makeUpdate(3, 999, "/status"));
  assert.equal(readAudit(root, "demo-tenant").length, 2);
  ok("unauthorized repeat within a minute is not logged twice");
}

// 5. /start and /help reply with the command list, through pollOnce.
{
  const root = path.join(tmp, "start-help");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  api.queue(makeUpdate(10, 111, "/start"));
  api.queue(makeUpdate(11, 111, "/help"));
  await bot.pollOnce();
  assert.equal(api.sent.length, 2);
  assert.ok(api.sent[0].text.includes("allowlisted as Owner"));
  assert.ok(api.sent[0].text.includes("/status"));
  assert.ok(api.sent[1].text.includes("/packet"));
  assert.ok(api.sent[1].text.includes("/run_browser"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.filter((e) => e.event === "telegram_start").length, 1);
  assert.equal(events.filter((e) => e.event === "telegram_help").length, 1);
  ok("/start and /help reply with the command list");
}

// 6. /status output contains version and HOLD.
{
  const root = path.join(tmp, "status");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(rootDir, "package.json"), path.join(root, "package.json"));
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/status"));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes(`TrustyMUSE Harness ${repoVersion}`));
  assert.ok(api.sent[0].text.includes("HOLD: OFF"));
  assert.ok(api.sent[0].text.includes("Tenant: Demo Tenant (demo-tenant)"));
  assert.ok(api.sent[0].text.includes("Budget: cap 0 USD"));
  assert.ok(api.sent[0].text.includes("Models connected: 0 of 9"));
  ok("/status output contains version and HOLD");
}

// 7. /models lists models with connected state.
{
  const root = path.join(tmp, "models");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/models"));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("chatgpt (OpenAI, connected"));
  assert.ok(api.sent[0].text.includes("gemini (Google, not connected"));
  assert.ok(api.sent[0].text.includes("Connected means packet mode only"));
  ok("/models lists models with connected state");
}

// 8. /packet creates a packet file and exactly one audit event.
{
  const root = path.join(tmp, "packet");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  const before = readAudit(root, "demo-tenant").length;
  await bot.handleUpdate(makeUpdate(1, 111, '/packet --model chatgpt --type seo --title "Demo title" --task "Write a draft."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Packet created:"));
  assert.ok(api.sent[0].text.includes("packets/demo-tenant/chatgpt-seo-demo-title-"));
  const files = fs.readdirSync(path.join(root, "packets", "demo-tenant"));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith("chatgpt-seo-demo-title-"));
  const after = readAudit(root, "demo-tenant");
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].event, "packet_generated");
  assert.ok(after[after.length - 1].detail.includes("telegram_user:111"));
  ok("/packet creates a packet file and exactly one audit event");
}

// 9. HOLD blocks /packet.
{
  const root = path.join(tmp, "hold");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.yaml"), "policy:\n  hold: true\n", "utf-8");
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  const config = loadConfig(root);
  assert.equal(config.hold, true);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, '/packet --model chatgpt --type seo --title "Blocked" --task "Write."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Packet was not created."));
  assert.ok(api.sent[0].text.includes("HOLD is on"));
  assert.equal(fs.existsSync(path.join(root, "packets", "demo-tenant")), false);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_packet_blocked");
  assert.equal(events[0].result, "blocked");
  ok("HOLD blocks /packet");
}

// 10. Token missing refuses start, and the module holds no hardcoded token.
{
  assert.throws(() => requireTelegramToken({}), /@BotFather/);
  assert.throws(() => requireTelegramToken({ TELEGRAM_BOT_TOKEN: "   " }), /No Telegram bot token found/);
  assert.equal(requireTelegramToken({ TELEGRAM_BOT_TOKEN: "fake-token-for-test" }), "fake-token-for-test");
  const source = fs.readFileSync(path.join(srcDir, "bot.ts"), "utf-8");
  assert.ok(!/bot\d{6,}:[\w-]{20,}/.test(source), "bot.ts holds a token-shaped literal");
  assert.ok(!/TELEGRAM_BOT_TOKEN\s*=\s*["'][^"']+["']/.test(source), "bot.ts assigns a token value");
  assert.ok(!source.includes("api.telegram.org/bot${") || source.includes("this.token"), "token only enters the request URL");
  ok("token missing refuses start and the module holds no hardcoded token");
}

// 11. Rate limit triggers on the 21st command.
{
  const root = path.join(tmp, "rate-limit");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(rootDir, "package.json"), path.join(root, "package.json"));
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  for (let i = 1; i <= 20; i += 1) {
    await bot.handleUpdate(makeUpdate(i, 111, "/status"));
  }
  assert.equal(api.sent.length, 20);
  await bot.handleUpdate(makeUpdate(21, 111, "/status"));
  assert.equal(api.sent.length, 21);
  assert.ok(api.sent[20].text.includes("Slow down"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.filter((e) => e.event === "telegram_rate_limited").length, 1);
  assert.equal(events.filter((e) => e.event === "status_checked").length, 20);
  ok("rate limit triggers on the 21st command");
}

// 12. Audit log holds one event per command.
{
  const root = path.join(tmp, "one-event");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(rootDir, "package.json"), path.join(root, "package.json"));
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/help"));
  await bot.handleUpdate(makeUpdate(2, 111, "/status"));
  await bot.handleUpdate(makeUpdate(3, 111, "/models"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.event), ["telegram_help", "status_checked", "telegram_models"]);
  assert.ok(events.every((e) => (e.detail || "").includes("telegram_user:111")));
  ok("audit log holds one event per command");
}

// 13. /run_browser is refused.
{
  const root = path.join(tmp, "run-browser");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/run_browser --model chatgpt --account main --type seo --task \"Run it.\""));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Use /run --account"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_run_browser_refused");
  assert.equal(events[0].result, "blocked");
  ok("/run_browser is refused, /run is named instead");
}

// 14. /analytics_preview prints the counts-only payload.
{
  const root = path.join(tmp, "analytics-preview");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  // The seeded event uses the real clock, not the test's fake clock: the
  // payload counts only events stamped within the last 24 hours up to now,
  // and the fake clock was advanced past real time by an earlier group.
  appendAudit({ at: new Date().toISOString(), runId: "run-test-1", event: "packet_generated", model: "chatgpt", taskType: "seo", detail: "SECRET-TASK-TITLE-12345", result: "ok" }, root, "demo-tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/analytics_preview"));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Nothing was sent"));
  assert.ok(api.sent[0].text.includes('"install_id"'));
  assert.ok(api.sent[0].text.includes('"packet_jobs": 1'));
  assert.ok(!api.sent[0].text.includes("SECRET-TASK-TITLE-12345"));
  ok("/analytics_preview prints the counts-only payload");
}

// 15. /audit returns the last 10 events without detail text.
{
  const root = path.join(tmp, "audit-cmd");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  for (let i = 1; i <= 12; i += 1) {
    appendAudit({ at: new Date().toISOString(), runId: `run-test-${i}`, event: "packet_generated", model: "chatgpt", taskType: "seo", detail: "SECRET-DETAIL-67890", result: "ok" }, root, "demo-tenant");
  }
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/audit"));
  assert.equal(api.sent.length, 1);
  const lines = api.sent[0].text.split("\n");
  assert.equal(lines.length, 11);
  assert.ok(lines[0].includes("Audit events for tenant demo-tenant: 12"));
  assert.ok(!api.sent[0].text.includes("SECRET-DETAIL-67890"));
  ok("/audit returns the last 10 events without detail text");
}

// 16. Real CLI: telegram-allow, telegram-allowlist, telegram-link, and
// telegram-start refusing without a token, in a scratch copy.
{
  const scratch = path.join(tmp, "cli");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(path.join(scratch, "dist"), { recursive: true });
  fs.copyFileSync(path.join(distDir, "index.js"), path.join(scratch, "dist", "index.js"));
  for (const sub of fs.readdirSync(distDir)) {
    const subPath = path.join(distDir, sub);
    if (!fs.statSync(subPath).isDirectory()) {
      continue;
    }
    fs.mkdirSync(path.join(scratch, "dist", sub), { recursive: true });
    for (const file of fs.readdirSync(subPath)) {
      fs.copyFileSync(path.join(subPath, file), path.join(scratch, "dist", sub, file));
    }
  }
  for (const file of fs.readdirSync(distDir)) {
    if (file.endsWith(".js") && file !== "index.js") {
      fs.copyFileSync(path.join(distDir, file), path.join(scratch, "dist", file));
    }
  }
  fs.copyFileSync(path.join(rootDir, "package.json"), path.join(scratch, "package.json"));
  fs.symlinkSync(path.join(rootDir, "node_modules"), path.join(scratch, "node_modules"));
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  // A fresh install has no tenant registry yet, so set one up first, the
  // way a real user would, before telegram-start can reach the token check.
  execFileSync("node", ["dist/index.js", "setup", "--id", "demo-tenant", "--name", "Demo Tenant"], { cwd: scratch, encoding: "utf-8", env });
  const allowOut = execFileSync("node", ["dist/index.js", "telegram-allow", "--user-id", "123", "--label", "CLI Test"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(allowOut.includes("Telegram user allowlisted: 123 (CLI Test)"));
  const allowlistFile = JSON.parse(fs.readFileSync(path.join(scratch, "state", "telegram.json"), "utf-8"));
  assert.deepEqual(allowlistFile.users.map((u) => u.id), [123]);
  const listOut = execFileSync("node", ["dist/index.js", "telegram-allowlist"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(listOut.includes("123 (CLI Test"));
  const linkOut = execFileSync("node", ["dist/index.js", "telegram-link"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(linkOut.includes("@BotFather"));
  assert.ok(linkOut.includes("TELEGRAM_BOT_TOKEN"));
  const startOut = execFileSync("node", ["dist/index.js", "telegram-start"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(startOut.includes("Telegram bot was not started."));
  assert.ok(startOut.includes("No Telegram bot token found"));
  ok("real CLI telegram-allow, telegram-allowlist, telegram-link, and telegram-start refusal");
}

// V2.0 groups.

// 17. Token from the file fallback, and env precedence over the file.
{
  const root = path.join(tmp, "token-fallback");
  fs.mkdirSync(root, { recursive: true });
  setTelegramFileToken(root, "file-token-for-test-1234567890");
  assert.equal(loadTelegramState(root).botToken, "file-token-for-test-1234567890");
  assert.equal(requireTelegramToken({}, root), "file-token-for-test-1234567890");
  assert.equal(requireTelegramToken({ TELEGRAM_BOT_TOKEN: "env-token-for-test-1234567890" }, root), "env-token-for-test-1234567890");
  assert.deepEqual(getTelegramTokenSource(root, {}), { set: true, source: "file" });
  assert.deepEqual(getTelegramTokenSource(root, { TELEGRAM_BOT_TOKEN: "env-token-for-test-1234567890" }), { set: true, source: "env" });
  const empty = path.join(tmp, "token-none");
  fs.mkdirSync(empty, { recursive: true });
  assert.deepEqual(getTelegramTokenSource(empty, {}), { set: false, source: "none" });
  assert.throws(() => requireTelegramToken({}, empty), /No Telegram bot token found/);
  assert.throws(() => requireTelegramToken({}), /@BotFather/);
  ok("token from file fallback and env precedence");
}

// 18. telegram-token-status never prints a token, and telegram-token-clear removes it.
{
  const scratch = path.join(tmp, "token-cli");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(path.join(scratch, "dist"), { recursive: true });
  fs.copyFileSync(path.join(distDir, "index.js"), path.join(scratch, "dist", "index.js"));
  for (const sub of fs.readdirSync(distDir)) {
    const subPath = path.join(distDir, sub);
    if (!fs.statSync(subPath).isDirectory()) {
      continue;
    }
    fs.mkdirSync(path.join(scratch, "dist", sub), { recursive: true });
    for (const file of fs.readdirSync(subPath)) {
      fs.copyFileSync(path.join(subPath, file), path.join(scratch, "dist", sub, file));
    }
  }
  for (const file of fs.readdirSync(distDir)) {
    if (file.endsWith(".js") && file !== "index.js") {
      fs.copyFileSync(path.join(distDir, file), path.join(scratch, "dist", file));
    }
  }
  fs.copyFileSync(path.join(rootDir, "package.json"), path.join(scratch, "package.json"));
  fs.symlinkSync(path.join(rootDir, "node_modules"), path.join(scratch, "node_modules"));
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  execFileSync("node", ["dist/index.js", "setup", "--id", "demo-tenant", "--name", "Demo Tenant"], { cwd: scratch, encoding: "utf-8", env });
  const before = execFileSync("node", ["dist/index.js", "telegram-token-status"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(before.includes("not set"));
  setTelegramFileToken(scratch, "SECRET-FILE-TOKEN-98765");
  const statusOut = execFileSync("node", ["dist/index.js", "telegram-token-status"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(statusOut.includes("set"));
  assert.ok(statusOut.includes("file"));
  assert.ok(!statusOut.includes("SECRET-FILE-TOKEN-98765"));
  const envStatusOut = execFileSync("node", ["dist/index.js", "telegram-token-status"], { cwd: scratch, encoding: "utf-8", env: { ...env, TELEGRAM_BOT_TOKEN: "SECRET-ENV-TOKEN-13579" } });
  assert.ok(envStatusOut.includes("env"));
  assert.ok(!envStatusOut.includes("SECRET-ENV-TOKEN-13579"));
  const clearOut = execFileSync("node", ["dist/index.js", "telegram-token-clear"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(clearOut.includes("removed"));
  assert.equal(loadTelegramState(scratch).botToken, null);
  const after = execFileSync("node", ["dist/index.js", "telegram-token-status"], { cwd: scratch, encoding: "utf-8", env });
  assert.ok(after.includes("not set"));
  ok("telegram-token-status never prints a token, and telegram-token-clear removes it");
}

// 19. Setting the file token keeps the allowlist, and allowlisting keeps the file token.
{
  const root = path.join(tmp, "token-preserve");
  fs.mkdirSync(root, { recursive: true });
  allowTelegramUser(root, 111, "Owner");
  setTelegramFileToken(root, "file-token-for-test-1234567890");
  assert.equal(loadAllowlist(root).length, 1);
  assert.equal(loadAllowlist(root)[0].id, 111);
  allowTelegramUser(root, 222, "Helper");
  assert.equal(loadTelegramState(root).botToken, "file-token-for-test-1234567890");
  assert.equal(loadAllowlist(root).length, 2);
  assert.equal(clearTelegramFileToken(root), true);
  assert.equal(clearTelegramFileToken(root), false);
  assert.equal(loadAllowlist(root).length, 2);
  assert.throws(() => setTelegramFileToken(root, "short"), /must be one token/);
  assert.throws(() => setTelegramFileToken(root, "has space in it 1234567890"), /must be one token/);
  ok("file token and allowlist preserve each other");
}

// 20. /project_add through the bot, and a path outside the workspace is refused.
{
  const root = path.join(tmp, "project-add");
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  const appDir = path.join(workspace, "my-app");
  fs.mkdirSync(appDir, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { workspaceRoot: workspace });
  await bot.handleUpdate(makeUpdate(1, 111, `/project_add my-app "My App" web-app ${appDir}`));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Project connected: my-app"));
  assert.ok(api.sent[0].text.includes("My App"));
  await bot.handleUpdate(makeUpdate(2, 111, "/project_add outside \"Outside\" web-app /tmp/outside-app"));
  assert.equal(api.sent.length, 2);
  assert.ok(api.sent[1].text.includes("Project was not connected."));
  assert.ok(api.sent[1].text.includes("must be inside the workspace"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "telegram_project_added");
  assert.equal(events[1].event, "telegram_project_blocked");
  assert.equal(events[1].result, "blocked");
  ok("/project_add through the bot, outside path refused");
}

// 21. /project_remove and /project_pause through the bot.
{
  const root = path.join(tmp, "project-remove-pause");
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "app-a"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "app-b"), { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { workspaceRoot: workspace });
  await bot.handleUpdate(makeUpdate(1, 111, `/project_add app-a "App A" web-app ${path.join(workspace, "app-a")}`));
  await bot.handleUpdate(makeUpdate(2, 111, `/project_add app-b "App B" web-app ${path.join(workspace, "app-b")}`));
  await bot.handleUpdate(makeUpdate(3, 111, "/project_pause app-a"));
  assert.ok(api.sent[2].text.includes("Project paused: app-a"));
  await bot.handleUpdate(makeUpdate(4, 111, "/project_remove app-b"));
  assert.ok(api.sent[3].text.includes("Project disconnected: app-b"));
  await bot.handleUpdate(makeUpdate(5, 111, "/project_list"));
  assert.ok(api.sent[4].text.includes("Connected projects: 1"));
  assert.ok(api.sent[4].text.includes("app-a"));
  assert.ok(!api.sent[4].text.includes("app-b"));
  await bot.handleUpdate(makeUpdate(6, 111, "/project_remove missing"));
  assert.ok(api.sent[5].text.includes("Project was not removed."));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((e) => e.event), [
    "telegram_project_added",
    "telegram_project_added",
    "telegram_project_paused",
    "telegram_project_removed",
    "telegram_projects",
    "telegram_project_blocked",
  ]);
  ok("/project_remove and /project_pause through the bot");
}

// 22. /model_connect and /model_disconnect through the bot, disconnect refused with an active account.
{
  const root = path.join(tmp, "model-connect-bot");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/model_connect gemini"));
  assert.ok(api.sent[0].text.includes("Model connected: gemini"));
  await bot.handleUpdate(makeUpdate(2, 111, "/model_connect openai-api"));
  assert.ok(api.sent[1].text.includes("Model was not connected."));
  assert.ok(api.sent[1].text.includes("API model"));
  makeAccount(root, ctx, "chatgpt", "main", false);
  await bot.handleUpdate(makeUpdate(3, 111, "/model_connect chatgpt"));
  assert.ok(api.sent[2].text.includes("Model connected: chatgpt"));
  await bot.handleUpdate(makeUpdate(4, 111, "/model_disconnect chatgpt"));
  assert.ok(api.sent[3].text.includes("Model was not disconnected."));
  assert.ok(api.sent[3].text.includes("active browser account"));
  await bot.handleUpdate(makeUpdate(5, 111, "/model_disconnect gemini"));
  assert.ok(api.sent[4].text.includes("Model disconnected: gemini"));
  await bot.handleUpdate(makeUpdate(6, 111, "/model_disconnect gemini"));
  assert.ok(api.sent[5].text.includes("Model was not disconnected."));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((e) => e.event), [
    "telegram_model_connected",
    "telegram_model_blocked",
    "telegram_model_connected",
    "telegram_model_blocked",
    "telegram_model_disconnected",
    "telegram_model_blocked",
  ]);
  ok("/model_connect and /model_disconnect through the bot, disconnect refused with an active account");
}

// 23. /hold on is immediate, /hold off needs YES, and a non-YES message cancels it.
{
  const root = path.join(tmp, "hold-bot");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  assert.equal(config.hold, false);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/hold on"));
  assert.ok(api.sent[0].text.includes("HOLD is now ON"));
  assert.equal(loadConfig(root).hold, true);
  await bot.handleUpdate(makeUpdate(2, 111, "/hold off"));
  assert.ok(api.sent[1].text.includes("Reply YES"));
  assert.equal(loadConfig(root).hold, true);
  await bot.handleUpdate(makeUpdate(3, 111, "/status"));
  assert.ok(api.sent[2].text.includes("HOLD: ON"));
  assert.equal(loadConfig(root).hold, true);
  await bot.handleUpdate(makeUpdate(4, 111, "/hold off"));
  assert.ok(api.sent[3].text.includes("Reply YES"));
  await bot.handleUpdate(makeUpdate(5, 111, "YES"));
  assert.ok(api.sent[4].text.includes("HOLD is now OFF"));
  assert.equal(loadConfig(root).hold, false);
  const events = readAudit(root, "demo-tenant");
  assert.deepEqual(events.map((e) => e.event), [
    "telegram_hold_on",
    "telegram_hold_off_requested",
    "status_checked",
    "telegram_hold_off_requested",
    "telegram_hold_off_confirmed",
  ]);
  ok("/hold on is immediate, /hold off needs YES, non-YES cancels it");
}

// 24. /run refuses a disconnected account.
{
  const root = path.join(tmp, "run-disconnected");
  fs.mkdirSync(root, { recursive: true });
  writeBrowserConfig(root);
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  makeAccount(root, ctx, "chatgpt", "main", false);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { driverFactory: mockDriverFactory({ chatgpt: "Mock response." }) });
  await bot.handleUpdate(makeUpdate(1, 111, '/run --account main --task "Write a draft."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Browser job was not started."));
  assert.ok(api.sent[0].text.includes("browser-connect"));
  assert.equal(fs.existsSync(path.join(root, "browser-results", "demo-tenant")), false);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_browser_job_blocked");
  assert.equal(events[0].result, "blocked");
  ok("/run refuses a disconnected account");
}

// 25. /run enforces the daily limit.
{
  const root = path.join(tmp, "run-daily-limit");
  fs.mkdirSync(root, { recursive: true });
  writeBrowserConfig(root);
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  makeAccount(root, ctx, "chatgpt", "main", true);
  const accounts = loadAccounts(root, ctx.tenantId);
  const account = accounts.find((a) => a.id === "main");
  account.dailyCount = 20;
  account.dailyDate = todayKey();
  saveAccounts(accounts, root, ctx.tenantId);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { driverFactory: mockDriverFactory({ chatgpt: "Mock response." }) });
  await bot.handleUpdate(makeUpdate(1, 111, '/run --account main --task "Write a draft."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Browser job did not finish."));
  assert.ok(api.sent[0].text.includes("Daily limit reached"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_browser_job_blocked");
  ok("/run enforces the daily limit");
}

// 26. /run succeeds with the mock driver, returns the reply, writes the result file, one audit event.
{
  const root = path.join(tmp, "run-success");
  fs.mkdirSync(root, { recursive: true });
  writeBrowserConfig(root);
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  makeAccount(root, ctx, "chatgpt", "main", true);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { driverFactory: mockDriverFactory({ chatgpt: "Mock plan result: build the landing page with three sections." }) });
  await bot.handleUpdate(makeUpdate(1, 111, '/run --account main --task "Write a plan for a landing page."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Browser job finished in 1 attempt(s)"));
  assert.ok(api.sent[0].text.includes("Mock plan result: build the landing page with three sections."));
  assert.ok(api.sent[0].text.includes("Result saved:"));
  const resultFiles = fs.readdirSync(path.join(root, "browser-results", "demo-tenant"));
  assert.equal(resultFiles.length, 1);
  assert.ok(resultFiles[0].startsWith("chatgpt-main-untitled-task-"));
  assert.ok(fs.readFileSync(path.join(root, "browser-results", "demo-tenant", resultFiles[0]), "utf-8").includes("Mock plan result"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_browser_job_done");
  assert.equal(events[0].result, "ok");
  assert.ok(events[0].detail.includes("account:main"));
  assert.ok(!events[0].detail.includes("landing page"));
  const savedAccounts = loadAccounts(root, ctx.tenantId);
  assert.equal(savedAccounts[0].dailyCount, 1);
  ok("/run succeeds with the mock driver, one audit event");
}

// 27. /do parses the three patterns and the plain fallback.
{
  const pipeline = parseDoInstruction("plan with chatgpt then audit with claude: build a landing page");
  assert.equal(pipeline.kind, "pipeline");
  assert.equal(pipeline.planModel, "chatgpt");
  assert.equal(pipeline.auditModel, "claude");
  assert.equal(pipeline.taskText, "build a landing page");
  assert.equal(pipeline.wantsDeploy, false);
  const deploy = parseDoInstruction("plan with chatgpt, audit with claude: build it and deploy it live");
  assert.equal(deploy.kind, "pipeline");
  assert.equal(deploy.wantsDeploy, true);
  const project = parseDoInstruction("project trustytouch: write the pricing page");
  assert.equal(project.kind, "project");
  assert.equal(project.projectId, "trustytouch");
  assert.equal(project.taskText, "write the pricing page");
  const model = parseDoInstruction("write a launch post with claude");
  assert.equal(model.kind, "model");
  assert.equal(model.model, "claude");
  assert.equal(model.taskText, "write a launch post");
  assert.equal(parseDoInstruction("write a blog post with images").kind, "plain");
  assert.equal(parseDoInstruction("just do the thing").kind, "plain");
  assert.equal(auditPassedByMarkers("All good, no problems here."), true);
  assert.equal(auditPassedByMarkers("Failed: a step is missing."), false);
  assert.equal(auditPassedByMarkers("Do not deploy, the build is blocked."), false);
  ok("/do parses the three patterns and the plain fallback");
}

// 28. /do pipeline with deploy words and no browser accounts creates both packets and never deploys.
{
  const root = path.join(tmp, "do-pipeline-packets");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt", "claude"]);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, "/do plan with chatgpt then audit with claude: build a landing page and deploy it live"));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Plan packet:"));
  assert.ok(api.sent[0].text.includes("Audit packet:"));
  assert.ok(api.sent[0].text.includes("Nothing was deployed."));
  assert.ok(api.sent[0].text.includes("audit has not run yet"));
  assert.ok(!api.sent[0].text.includes("deploying now"));
  const packets = fs.readdirSync(path.join(root, "packets", "demo-tenant"));
  assert.equal(packets.length, 2);
  assert.ok(packets.some((f) => f.startsWith("chatgpt-research-plan-")));
  assert.ok(packets.some((f) => f.startsWith("claude-code_review-audit-")));
  assert.equal(fs.existsSync(path.join(root, "browser-results", "demo-tenant")), false);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_do_done");
  ok("/do pipeline with deploy words and no browser accounts never deploys");
}

// 29. /do pipeline with mock drivers for both accounts runs plan then audit and reports the deploy verdict.
{
  const root = path.join(tmp, "do-pipeline-run");
  fs.mkdirSync(root, { recursive: true });
  writeBrowserConfig(root);
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt", "claude"]);
  makeAccount(root, ctx, "chatgpt", "chatgpt-main", true);
  makeAccount(root, ctx, "claude", "claude-main", true);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, {
    driverFactory: mockDriverFactory({
      chatgpt: "Mock plan: three sections, hero, pricing, footer.",
      claude: "Mock audit: the plan looks good, no issues found.",
    }),
  });
  await bot.handleUpdate(makeUpdate(1, 111, "/do plan with chatgpt then audit with claude: build a landing page and deploy it live"));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("Pipeline finished."));
  assert.ok(api.sent[0].text.includes("Audit passed"));
  assert.ok(api.sent[0].text.includes("Ready to deploy"));
  assert.ok(api.sent[0].text.includes("needs your approval in the Muse app"));
  assert.ok(api.sent[0].text.includes("Mock audit: the plan looks good"));
  assert.ok(api.sent[0].text.includes("Mock plan: three sections"));
  const resultFiles = fs.readdirSync(path.join(root, "browser-results", "demo-tenant"));
  assert.equal(resultFiles.length, 2);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_do_done");
  assert.equal(events[0].result, "ok");
  ok("/do pipeline with mock drivers runs plan then audit and reports the deploy verdict");
}

// 30. /do project pattern creates a project-scoped packet.
{
  const root = path.join(tmp, "do-project");
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  const appDir = path.join(workspace, "my-app");
  fs.mkdirSync(appDir, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { workspaceRoot: workspace });
  await bot.handleUpdate(makeUpdate(1, 111, `/project_add my-app "My App" web-app ${appDir}`));
  await bot.handleUpdate(makeUpdate(2, 111, "/do project my-app: write the pricing page draft"));
  assert.equal(api.sent.length, 2);
  assert.ok(api.sent[1].text.includes("Task created:"));
  assert.ok(api.sent[1].text.includes("Project: my-app."));
  const packets = fs.readdirSync(path.join(root, "packets", "demo-tenant"));
  assert.equal(packets.length, 1);
  const content = fs.readFileSync(path.join(root, "packets", "demo-tenant", packets[0]), "utf-8");
  assert.ok(content.includes("My App"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "telegram_do_done");
  ok("/do project pattern creates a project-scoped packet");
}

// 31. Rate limit still applies to writes.
{
  const root = path.join(tmp, "rate-limit-writes");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  for (let i = 1; i <= 20; i += 1) {
    await bot.handleUpdate(makeUpdate(i, 111, "/project_list"));
  }
  assert.equal(api.sent.length, 20);
  await bot.handleUpdate(makeUpdate(21, 111, "/project_add late \"Late\" web-app /tmp/late"));
  assert.equal(api.sent.length, 21);
  assert.ok(api.sent[20].text.includes("Slow down"));
  assert.equal(fs.existsSync(path.join(root, "state", "tenants", "demo-tenant", "projects.json")), false);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.filter((e) => e.event === "telegram_rate_limited").length, 1);
  ok("rate limit still applies to writes");
}

// 32. One audit event per write command.
{
  const root = path.join(tmp, "one-event-writes");
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  const appDir = path.join(workspace, "my-app");
  fs.mkdirSync(appDir, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { workspaceRoot: workspace });
  await bot.handleUpdate(makeUpdate(1, 111, `/project_add my-app "My App" web-app ${appDir}`));
  await bot.handleUpdate(makeUpdate(2, 111, "/model_connect gemini"));
  await bot.handleUpdate(makeUpdate(3, 111, "/hold on"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.event), ["telegram_project_added", "telegram_model_connected", "telegram_hold_on"]);
  assert.ok(events.every((e) => (e.detail || "").includes("telegram_user:111")));
  ok("one audit event per write command");
}

// 33. /task alias, /account_list, and /tenant_status reply.
{
  const root = path.join(tmp, "task-alias");
  fs.mkdirSync(root, { recursive: true });
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  makeAccount(root, ctx, "chatgpt", "main", false);
  const config = loadConfig(root);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api);
  await bot.handleUpdate(makeUpdate(1, 111, '/task --model chatgpt --type content --title "Alias" --task "Write."'));
  assert.ok(api.sent[0].text.includes("Packet created:"));
  await bot.handleUpdate(makeUpdate(2, 111, "/account_list"));
  assert.ok(api.sent[1].text.includes("Browser accounts: 1"));
  assert.ok(api.sent[1].text.includes("main (chatgpt"));
  await bot.handleUpdate(makeUpdate(3, 111, "/tenant_status"));
  assert.ok(api.sent[2].text.includes("Tenant: Demo Tenant (demo-tenant"));
  assert.ok(api.sent[2].text.includes("Budget: cap 0 USD"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.event), ["packet_generated", "telegram_account_list", "telegram_tenant_status"]);
  ok("/task alias, /account_list, and /tenant_status reply");
}

// 34. /run with HOLD on is refused.
{
  const root = path.join(tmp, "run-hold");
  fs.mkdirSync(root, { recursive: true });
  writeBrowserConfig(root);
  fs.writeFileSync(path.join(root, "config.yaml"), "browser:\n  enabled: true\n  headless: true\n  pacing_ms: 8000\n  daily_limit_per_account: 20\npolicy:\n  hold: true\n", "utf-8");
  const ctx = makeCtx(root, "demo-tenant", "Demo Tenant");
  writeJson(path.join(ctx.stateDir, "models.json"), ["chatgpt"]);
  makeAccount(root, ctx, "chatgpt", "main", true);
  const config = loadConfig(root);
  assert.equal(config.hold, true);
  assert.equal(config.browser.enabled, true);
  const api = new MockTelegramApi();
  allowTelegramUser(root, 111, "Owner");
  const bot = makeBot(root, ctx, config, api, { driverFactory: mockDriverFactory({ chatgpt: "Mock response." }) });
  await bot.handleUpdate(makeUpdate(1, 111, '/run --account main --task "Write a draft."'));
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("HOLD is on"));
  assert.equal(fs.existsSync(path.join(root, "browser-results", "demo-tenant")), false);
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_browser_job_blocked");
  ok("/run with HOLD on is refused");
}

// Tokenizer and truncation helpers.
{
  assert.deepEqual(tokenizeArgs('--model chatgpt --title "My title here" --task \'Write it.\''), ["--model", "chatgpt", "--title", "My title here", "--task", "Write it."]);
  assert.deepEqual(tokenizeArgs(""), []);
  assert.equal(truncateForTelegram("x".repeat(5000)).length, 4000 + "\n[Reply cut short: it was over the Telegram message limit.]".length);
  assert.equal(truncateForTelegram("short"), "short");
  ok("tokenizer and truncation helpers");
}

console.log(`All ${passed} telegram test groups passed. Temp dir: ${tmp}`);

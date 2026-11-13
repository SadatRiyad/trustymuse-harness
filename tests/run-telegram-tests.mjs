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
  requireTelegramToken,
  tokenizeArgs,
  truncateForTelegram,
} = await import(path.join(distDir, "telegram", "bot.js"));
const { loadConfig } = await import(path.join(distDir, "config.js"));
const { appendAudit, readAuditEvents } = await import(path.join(distDir, "audit.js"));
const { addTenant } = await import(path.join(distDir, "tenants", "tenants.js"));

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

function makeBot(root, ctx, config, api) {
  return createTelegramBot({ rootDir: root, ctx, config, api, now });
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
  assert.ok(api.sent[0].text.includes("Browser jobs run from the CLI only"));
  const events = readAudit(root, "demo-tenant");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "telegram_run_browser_refused");
  assert.equal(events[0].result, "blocked");
  ok("/run_browser is refused");
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

// Tokenizer and truncation helpers.
{
  assert.deepEqual(tokenizeArgs('--model chatgpt --title "My title here" --task \'Write it.\''), ["--model", "chatgpt", "--title", "My title here", "--task", "Write it."]);
  assert.deepEqual(tokenizeArgs(""), []);
  assert.equal(truncateForTelegram("x".repeat(5000)).length, 4000 + "\n[Reply cut short: it was over the Telegram message limit.]".length);
  assert.equal(truncateForTelegram("short"), "short");
  ok("tokenizer and truncation helpers");
}

console.log(`All ${passed} telegram test groups passed. Temp dir: ${tmp}`);

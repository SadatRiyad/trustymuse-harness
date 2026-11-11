import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.1 browser session tests. Plain Node, no test framework.
// Run with: npm run test:browser
// These tests use the mock driver only. No real browser is launched,
// no real account is used, and no password or token is stored anywhere.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const { DEFAULT_CONFIG } = await import(path.join(distDir, "config.js"));
const accounts = await import(path.join(distDir, "session", "accounts.js"));
const { MockBrowserDriver, detectChallenge } = await import(path.join(distDir, "session", "browser.js"));
const { BrowserQueue } = await import(path.join(distDir, "session", "queue.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-browser-test-"));
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

function makeQueue(overrides = {}) {
  const events = [];
  const queue = new BrowserQueue({
    browserEnabled: true,
    pacingMs: 8000,
    dailyLimitPerAccount: 20,
    nowMs: () => Date.now(),
    sleep: async () => {},
    onEvent: (event, detail) => events.push({ event, detail }),
    ...overrides,
  });
  return { queue, events };
}

// Test 1: browser mode is disabled by default.
assert.strictEqual(DEFAULT_CONFIG.browser.enabled, false, "Browser mode must be off by default");
assert.strictEqual(DEFAULT_CONFIG.browser.headless, true, "Browser mode must be headless by default");
assert.strictEqual(DEFAULT_CONFIG.browser.maxAccounts, 3, "Default max accounts must be 3");
assert.strictEqual(DEFAULT_CONFIG.browser.pacingMs, 8000, "Default pacing must be 8000 ms");
assert.strictEqual(DEFAULT_CONFIG.browser.dailyLimitPerAccount, 20, "Default daily limit must be 20");
ok("browser mode is disabled by default");

// Test 2: account registry stores no password or token, and profile is local.
const main = accounts.addAccount(
  { provider: "chatgpt", id: "main", label: "Main ChatGPT" },
  { rootDir: tmp, profileRoot: "./profiles", maxAccounts: 3 },
);
assert.strictEqual(main.provider, "chatgpt", "Account provider must be chatgpt");
assert.strictEqual(main.profileDir, "./profiles/chatgpt-main", "Profile dir must be under profiles");
assert.strictEqual("password" in main, false, "Account must have no password field");
assert.strictEqual("token" in main, false, "Account must have no token field");
assert.strictEqual(JSON.stringify(main).includes("password"), false, "Account JSON must not contain password");
const listed = accounts.loadAccounts(tmp);
assert.strictEqual(listed.length, 1, "One account must be listed");
assert.strictEqual(accounts.getAccount("main", tmp).label, "Main ChatGPT", "Account must be found by id");
ok("account registry stores no password or token");

// Test 3: duplicate id is rejected and max accounts is enforced.
assert.throws(
  () => accounts.addAccount({ provider: "claude", id: "main", label: "Duplicate" }, { rootDir: tmp, maxAccounts: 3 }),
  /already exists/,
  "Duplicate account id must be rejected",
);
accounts.addAccount({ provider: "claude", id: "work-1", label: "Work Claude" }, { rootDir: tmp, maxAccounts: 3 });
accounts.addAccount({ provider: "chatgpt", id: "work-2", label: "Work ChatGPT" }, { rootDir: tmp, maxAccounts: 3 });
assert.throws(
  () => accounts.addAccount({ provider: "claude", id: "extra", label: "Extra" }, { rootDir: tmp, maxAccounts: 3 }),
  /limit reached/,
  "Fourth account must be rejected when max is 3",
);
ok("duplicate id is rejected and max accounts is enforced");

// Test 4: queue respects one job at a time per account.
{
  const { queue } = makeQueue({ pacingMs: 0 });
  const account = accounts.getAccount("main", tmp);
  const driver = new MockBrowserDriver({ delayMs: 50, responseText: "Mock response for the first job, with enough content to check." });
  const first = queue.run(
    { accountId: "main", model: "chatgpt", taskType: "seo", title: "First", task: "First task" },
    account,
    driver,
    "First task prompt",
  );
  // Give the first job a moment to become busy, then try a second job.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await queue.run(
    { accountId: "main", model: "chatgpt", taskType: "seo", title: "Second", task: "Second task" },
    account,
    new MockBrowserDriver(),
    "Second task prompt",
  );
  assert.strictEqual(second.blocked, true, "Second job must be blocked while the first job runs");
  assert.ok(second.reason.includes("already running"), "Block reason must mention the running job");
  const firstResult = await first;
  assert.strictEqual(firstResult.ok, true, "First job must finish");
  ok("queue respects one job at a time per account");
}

// Test 5: pacing blocks a job that arrives too soon, then allows it later.
{
  let nowMs = 1000000;
  const { queue } = makeQueue({ pacingMs: 8000, nowMs: () => nowMs });
  const account = { ...accounts.getAccount("work-1", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const driver = new MockBrowserDriver({ responseText: "Mock response for pacing test, with enough content." });
  const first = await queue.run(
    { accountId: "work-1", model: "claude", taskType: "content", title: "Pacing one", task: "Task one" },
    account,
    driver,
    "Task one prompt",
  );
  assert.strictEqual(first.ok, true, "First pacing job must finish");
  const blocked = queue.canRun(account);
  assert.strictEqual(blocked.allowed, false, "Job inside the pacing delay must be blocked");
  assert.ok(blocked.waitMs > 0, "Pacing block must report a wait time");
  nowMs += 9000;
  assert.strictEqual(queue.canRun(account).allowed, true, "Job after the pacing delay must be allowed");
  ok("pacing blocks a job that arrives too soon");
}

// Test 6: daily limit blocks excess jobs.
{
  const { queue } = makeQueue({ pacingMs: 0, dailyLimitPerAccount: 2 });
  const account = { ...accounts.getAccount("work-2", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const driver = new MockBrowserDriver({ responseText: "Mock response for daily limit test, with enough content." });
  for (let i = 1; i <= 2; i += 1) {
    const result = await queue.run(
      { accountId: "work-2", model: "chatgpt", taskType: "seo", title: `Daily ${i}`, task: `Task ${i}` },
      account,
      driver,
      `Task ${i} prompt`,
    );
    assert.strictEqual(result.ok, true, `Daily job ${i} must finish`);
  }
  const blocked = queue.canRun(account);
  assert.strictEqual(blocked.allowed, false, "Third job must be blocked by the daily limit");
  assert.ok(blocked.reason.includes("Daily limit"), "Block reason must mention the daily limit");
  ok("daily limit blocks excess jobs");
}

// Test 7: challenge pauses the account and is never auto solved.
{
  const { queue, events } = makeQueue({ pacingMs: 0 });
  const account = { ...accounts.getAccount("main", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const driver = new MockBrowserDriver({ responseText: "Please verify you are human. Complete the CAPTCHA challenge to continue." });
  assert.strictEqual(detectChallenge("Please verify you are human"), true, "Challenge text must be detected");
  const result = await queue.run(
    { accountId: "main", model: "chatgpt", taskType: "seo", title: "Challenge", task: "Challenge task" },
    account,
    driver,
    "Challenge task prompt",
  );
  assert.strictEqual(result.paused, true, "Challenge must pause the job");
  assert.strictEqual(account.status, "challenge", "Account status must become challenge");
  assert.ok(events.some((e) => e.event === "account_paused_challenge"), "Challenge pause must be logged as an event");
  assert.strictEqual(queue.canRun(account).allowed, false, "Challenged account must not run again");
  ok("challenge pauses the account");
}

// Test 8: driver failure retries once, then pauses the account.
{
  const { queue, events } = makeQueue({ pacingMs: 0 });
  const account = { ...accounts.getAccount("work-1", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const driver = new MockBrowserDriver({ failTimes: 5 });
  const result = await queue.run(
    { accountId: "work-1", model: "claude", taskType: "code_review", title: "Failing", task: "Failing task" },
    account,
    driver,
    "Failing task prompt",
  );
  assert.strictEqual(result.attempts, 2, "Driver must be tried exactly twice, once plus one retry");
  assert.strictEqual(result.paused, true, "Two failures must pause the account");
  assert.strictEqual(account.status, "paused", "Account status must become paused after two failures");
  assert.ok(events.some((e) => e.event === "browser_job_retry"), "Retry must be logged as an event");
  ok("driver failure retries once, then pauses the account");
}

// Test 9: browser disabled blocks run-browser.
{
  const { queue } = makeQueue({ browserEnabled: false, pacingMs: 0 });
  const account = { ...accounts.getAccount("main", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const check = queue.canRun(account);
  assert.strictEqual(check.allowed, false, "Disabled browser mode must block a job");
  assert.ok(check.reason.includes("Browser mode is off"), "Block reason must mention browser mode is off");
  ok("browser disabled by default blocks run-browser");
}

// Test 10: a single failure then success does not pause the account.
{
  const { queue } = makeQueue({ pacingMs: 0 });
  const account = { ...accounts.getAccount("work-2", tmp), dailyCount: 0, dailyDate: null, status: "active", enabled: true };
  const driver = new MockBrowserDriver({ failTimes: 1, responseText: "Mock response after one retry, with enough content to check." });
  const result = await queue.run(
    { accountId: "work-2", model: "chatgpt", taskType: "seo", title: "Retry ok", task: "Retry task" },
    account,
    driver,
    "Retry task prompt",
  );
  assert.strictEqual(result.ok, true, "Job must finish after one retry");
  assert.strictEqual(result.attempts, 2, "Job must have used two attempts");
  assert.strictEqual(account.status, "active", "Account must stay active after a recovered retry");
  ok("a single failure then success does not pause the account");
}

console.log(`All ${passed} browser test groups passed. Temp dir: ${tmp}`);

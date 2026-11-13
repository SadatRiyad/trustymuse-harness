import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.6 browser connect and disconnect tests. Plain Node, no test framework.
// Temp dirs only, no live network, mock driver only, no live prompt.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const srcDir = path.join(__dirname, "..", "src");
const { addAccount, assertNoSecrets, loadAccounts } = await import(path.join(distDir, "session", "accounts.js"));
const { readAuditEvents } = await import(path.join(distDir, "audit.js"));
const { MockBrowserDriver } = await import(path.join(distDir, "session", "browser.js"));
const {
  assertBrowserConnected,
  cloudJobRefusal,
  connectBrowser,
  connectCloudBrowser,
  disconnectBrowser,
  formatConnectionLine,
  getConnectionStatus,
  listConnectionStatuses,
  recordCloudJob,
  CLOUD_JOB_REFUSAL,
} = await import(path.join(distDir, "session", "connection.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-connection-test-"));
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

// A driver that fails openProfile the way the real driver does when the
// profile is not logged in, or when a challenge covers the page.
function failingDriver(message) {
  return {
    name: "failing-driver",
    wired: true,
    openProfile: async () => {
      throw new Error(message);
    },
    sendPrompt: async () => {},
    waitForResponse: async () => "",
    close: async () => {},
  };
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

// Seed one account per tenant. New accounts start disconnected: nothing
// is claimed connected without a driver verification.
addAccount(
  { provider: "chatgpt", id: "main", label: "Main ChatGPT" },
  { rootDir: harnessRoot, profileRoot: ctxA.profileRoot, tenantId: "tenant-a" },
);
addAccount(
  { provider: "claude", id: "main", label: "Main Claude" },
  { rootDir: harnessRoot, profileRoot: ctxB.profileRoot, tenantId: "tenant-b" },
);
assert.strictEqual(getConnectionStatus(ctxA, "main").connected, false, "A new account starts disconnected");

// Test 1: connect succeeds when the mock driver reports logged in.
const connected = await connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: false });
assert.strictEqual(connected.browserConnected, true, "Connect must mark the account connected");
assert.ok(connected.browserConnectedAt, "Connect must record when it connected");
assert.ok(connected.browserLastVerified, "Connect must record when it verified");
assert.strictEqual(connected.browserDisconnectReason, null, "Connect must clear any old disconnect reason");
assert.strictEqual(connected.status, "active", "Connect must leave the account active");
ok("connect succeeds when the mock driver reports logged in and marks connected with a timestamp");

// Test 2: connect fails closed on a login page and leaves the account disconnected.
await disconnectBrowser(ctxA, "main", "Test setup disconnect.");
assert.strictEqual(getConnectionStatus(ctxA, "main").connected, false, "Setup disconnect must leave the account disconnected");
await assert.rejects(
  connectBrowser(
    ctxA,
    "main",
    failingDriver("Profile main is not logged in for chatgpt. Log in once by hand in that profile, then try again."),
    { hold: false },
  ),
  /not logged in/,
  "Connect must throw the login failure",
);
const afterLoginPage = getConnectionStatus(ctxA, "main");
assert.strictEqual(afterLoginPage.connected, false, "A failed connect must leave the account disconnected");
assert.ok(
  (afterLoginPage.disconnectReason || "").includes("not logged in"),
  "A failed connect must record the exact reason",
);
ok("connect fails closed when the driver reports a login page and leaves the account disconnected");

// Test 3: connect fails closed on a challenge and leaves the account disconnected.
await assert.rejects(
  connectBrowser(
    ctxA,
    "main",
    failingDriver("Challenge detected on the page. Account is paused. Check it by hand."),
    { hold: false },
  ),
  /Challenge detected/,
  "Connect must throw the challenge failure",
);
const afterChallenge = getConnectionStatus(ctxA, "main");
assert.strictEqual(afterChallenge.connected, false, "A challenge must leave the account disconnected");
assert.ok(
  (afterChallenge.disconnectReason || "").includes("Challenge detected"),
  "A challenge must be recorded as the disconnect reason",
);
ok("connect fails closed when the driver reports a challenge and leaves the account disconnected");

// Test 4: disconnect marks disconnected, keeps the profile dir, keeps the login.
await connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: false });
const beforeDisconnect = loadAccounts(harnessRoot, "tenant-a").find((a) => a.id === "main");
const profileDir = beforeDisconnect.profileDir;
const disconnected = disconnectBrowser(ctxA, "main", "Taking a break.");
assert.strictEqual(disconnected.browserConnected, false, "Disconnect must mark the account disconnected");
assert.strictEqual(disconnected.browserDisconnectReason, "Taking a break.", "Disconnect must record the reason");
assert.strictEqual(disconnected.profileDir, profileDir, "Disconnect must keep the profile dir recorded");
assert.strictEqual(disconnected.status, "paused", "Disconnect must pause the account so the queue refuses later jobs");
assert.ok(fs.existsSync(path.join(harnessRoot, "state", "tenants", "tenant-a", "accounts.json")), "Disconnect must keep the registry file");
ok("disconnect marks disconnected and keeps the profile dir recorded");

// Test 5: disconnect works with HOLD on.
const disconnectedHold = disconnectBrowser(ctxA, "main", "Disconnect with HOLD on.");
assert.strictEqual(disconnectedHold.browserConnected, false, "Disconnect with HOLD on must still work");
ok("disconnect works with HOLD on");

// Test 6: connect is refused with HOLD on, and nothing changes.
await assert.rejects(
  connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: true }),
  /HOLD is on/,
  "Connect with HOLD on must be refused",
);
assert.strictEqual(getConnectionStatus(ctxA, "main").connected, false, "A refused connect must not change state");
ok("connect is refused with HOLD on");

// Test 7: the run-browser gate refuses a disconnected account and allows a connected one.
assert.throws(
  () => assertBrowserConnected(ctxA, "main"),
  /Run browser-connect --account main first/,
  "The gate must refuse a disconnected account and name browser-connect",
);
await connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: false });
const gated = assertBrowserConnected(ctxA, "main");
assert.strictEqual(gated.id, "main", "The gate must allow a connected account through");
ok("run-browser gate refuses a disconnected account and allows a connected one");

// Test 8: connection state is per tenant.
await connectBrowser(ctxB, "main", new MockBrowserDriver(), { hold: false });
assert.strictEqual(getConnectionStatus(ctxB, "main").connected, true, "Tenant B must be connected after its own connect");
disconnectBrowser(ctxA, "main", "Tenant A disconnects.");
assert.strictEqual(getConnectionStatus(ctxA, "main").connected, false, "Disconnecting tenant A must not change tenant B");
assert.strictEqual(getConnectionStatus(ctxB, "main").connected, true, "Tenant B must stay connected");
ok("connection state is per tenant");

// Test 9: status lists connected and disconnected correctly.
await connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: false });
addAccount(
  { provider: "chatgpt", id: "spare", label: "Spare ChatGPT" },
  { rootDir: harnessRoot, profileRoot: ctxA.profileRoot, tenantId: "tenant-a" },
);
const statuses = listConnectionStatuses(ctxA);
assert.strictEqual(statuses.length, 2, "Two accounts must be listed for tenant A");
const mainLine = formatConnectionLine(statuses.find((s) => s.accountId === "main"));
const spareLine = formatConnectionLine(statuses.find((s) => s.accountId === "spare"));
assert.ok(mainLine.includes("connected"), "The connected account line must say connected");
assert.ok(mainLine.includes("verified"), "The connected account line must show the verification time");
assert.ok(spareLine.includes("disconnected"), "The unconnected account line must say disconnected");
ok("status lists connected and disconnected correctly");

// Test 10: unknown account fails closed everywhere.
assert.throws(() => getConnectionStatus(ctxA, "nope"), /was not found/, "Status must fail closed for an unknown account");
assert.throws(() => disconnectBrowser(ctxA, "nope"), /was not found/, "Disconnect must fail closed for an unknown account");
await assert.rejects(
  connectBrowser(ctxA, "nope", new MockBrowserDriver(), { hold: false }),
  /was not found/,
  "Connect must fail closed for an unknown account",
);
ok("unknown account fails closed");

// Test 11: the persisted record holds no login detail fields.
const raw = fs.readFileSync(path.join(harnessRoot, "state", "tenants", "tenant-a", "accounts.json"), "utf-8");
assert.ok(!/password|token|secret|apikey|api_key|sessiontoken|cookie/i.test(raw), "The account file must never hold login detail fields");
const stored = JSON.parse(raw);
const allowedKeys = new Set([
  "id", "provider", "label", "profileDir", "source", "status", "lastUsed", "dailyCount",
  "dailyDate", "enabled", "createdAt", "browserConnected", "browserConnectedAt",
  "browserLastVerified", "browserDisconnectReason", "verifiedAt", "verifiedVia",
  "verifiedNote",
]);
for (const record of stored) {
  for (const key of Object.keys(record)) {
    assert.ok(allowedKeys.has(key), `Unexpected key ${key} in the stored account record`);
  }
}
const connectionSource = fs.readFileSync(path.join(srcDir, "session", "connection.ts"), "utf-8");
assert.ok(
  !/password|token|secret|apikey|api_key|sessiontoken|cookie/i.test(connectionSource),
  "The connection module must not mention login detail fields",
);
ok("no login detail field exists in the new code or the stored record");

// Test 12: connect reactivates a paused account after the user fixes it by hand.
disconnectBrowser(ctxA, "main", "Paused for a manual check.");
assert.strictEqual(loadAccounts(harnessRoot, "tenant-a").find((a) => a.id === "main").status, "paused", "Disconnect must pause the account");
const reconnected = await connectBrowser(ctxA, "main", new MockBrowserDriver(), { hold: false });
assert.strictEqual(reconnected.status, "active", "A verified reconnect must reactivate the account");
assert.strictEqual(reconnected.browserConnected, true, "A verified reconnect must mark it connected");
ok("connect reactivates a paused account after a verified login");

// Test 13: disconnecting an already disconnected account still records the reason.
disconnectBrowser(ctxA, "spare", "First disconnect.");
const again = disconnectBrowser(ctxA, "spare", "Second disconnect.");
assert.strictEqual(again.browserConnected, false, "A second disconnect must keep the account disconnected");
assert.strictEqual(again.browserDisconnectReason, "Second disconnect.", "A second disconnect must record the latest reason");
ok("disconnecting an already disconnected account still records the reason");

// Test 14: old records without the V1.6 fields are backfilled as disconnected.
const legacyFile = path.join(harnessRoot, "state", "tenants", "tenant-b", "accounts.json");
const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf-8"));
for (const record of legacy) {
  delete record.browserConnected;
  delete record.browserConnectedAt;
  delete record.browserLastVerified;
  delete record.browserDisconnectReason;
}
fs.writeFileSync(legacyFile, JSON.stringify(legacy, null, 2) + "\n", "utf-8");
const backfilled = loadAccounts(harnessRoot, "tenant-b").find((a) => a.id === "main");
assert.strictEqual(backfilled.browserConnected, false, "An old record must be treated as disconnected until verified");
assert.strictEqual(backfilled.browserConnectedAt, null, "An old record must have no connect time");
assert.strictEqual(backfilled.browserLastVerified, null, "An old record must have no verification time");
ok("old records without the V1.6 fields are backfilled as disconnected");

// Test 15: the account profile dir holds exactly one tenant segment.
// Regression: the CLI once passed the tenant-scoped profile root into
// addAccount, which appended the tenant id a second time, so profiles
// landed in profiles/<tenant>/<tenant>/<provider>-<id> instead of the
// documented profiles/<tenant>/<provider>-<id>.
const cliStyle = addAccount(
  { provider: "claude", id: "work", label: "Work Claude" },
  { rootDir: harnessRoot, profileRoot: path.join(harnessRoot, "profiles"), tenantId: "tenant-a" },
);
assert.strictEqual(
  cliStyle.profileDir,
  path.join(harnessRoot, "profiles", "tenant-a", "claude-work"),
  "The profile dir must be profiles/<tenant>/<provider>-<id>",
);
assert.ok(
  !cliStyle.profileDir.includes("tenant-a/tenant-a"),
  "The tenant segment must not appear twice in the profile dir",
);
ok("account profile dir holds exactly one tenant segment");

// Cloud browser accounts, V2.3. A cloud account is a model the user is
// already logged in to in the cloud browser, not in a harness profile.
const ctxC = makeCtx("tenant-c");

// Test 16: old records without a source field are backfilled to profile.
addAccount(
  { provider: "chatgpt", id: "main", label: "Main ChatGPT" },
  { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
);
const legacyCloudFile = path.join(harnessRoot, "state", "tenants", "tenant-c", "accounts.json");
const legacyCloud = JSON.parse(fs.readFileSync(legacyCloudFile, "utf-8"));
for (const record of legacyCloud) {
  delete record.source;
  delete record.verifiedAt;
  delete record.verifiedVia;
  delete record.verifiedNote;
}
fs.writeFileSync(legacyCloudFile, JSON.stringify(legacyCloud, null, 2) + "\n", "utf-8");
const backfilledCloud = loadAccounts(harnessRoot, "tenant-c").find((a) => a.id === "main");
assert.strictEqual(backfilledCloud.source, "profile", "An old record must be treated as a profile account");
assert.strictEqual(backfilledCloud.verifiedAt, null, "An old record must have no cloud verification time");
assert.strictEqual(backfilledCloud.verifiedVia, null, "An old record must have no cloud verification source");
assert.strictEqual(backfilledCloud.verifiedNote, null, "An old record must have no cloud verification note");
ok("old records without a source field are backfilled to profile with empty verification fields");

// Test 17: a cloud account uses any subscription model and has no local profile.
const geminiCloud = addAccount(
  { provider: "gemini", id: "gem", label: "Gemini Cloud", source: "cloud" },
  { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
);
assert.strictEqual(geminiCloud.source, "cloud", "A cloud account must record source cloud");
assert.strictEqual(geminiCloud.profileDir, "", "A cloud account must have no local profile dir");
assert.strictEqual(geminiCloud.provider, "gemini", "A cloud account may use gemini, which has no wired driver");
assert.strictEqual(geminiCloud.browserConnected, false, "A new cloud account starts disconnected");
ok("a cloud account uses any subscription model and has no local profile dir");

// Test 18: a cloud account refuses an unknown provider, and a profile account refuses gemini.
assert.throws(
  () => addAccount(
    { provider: "not-a-model", id: "bad", label: "Bad Cloud", source: "cloud" },
    { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
  ),
  /known subscription model/,
  "A cloud account must refuse an unknown provider",
);
assert.throws(
  () => addAccount(
    { provider: "gemini", id: "gem-profile", label: "Gemini Profile", source: "profile" },
    { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
  ),
  /chatgpt or claude/,
  "A profile account must refuse gemini, which has no wired driver",
);
ok("a cloud account refuses an unknown provider and a profile account refuses gemini");

// Test 19: source defaults to profile when absent, and an unknown source is refused.
const defaultSource = addAccount(
  { provider: "claude", id: "work", label: "Work Claude" },
  { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
);
assert.strictEqual(defaultSource.source, "profile", "An account without a source must default to profile");
assert.throws(
  () => addAccount(
    { provider: "chatgpt", id: "weird", label: "Weird", source: "local" },
    { rootDir: harnessRoot, profileRoot: ctxC.profileRoot, tenantId: "tenant-c" },
  ),
  /profile or cloud/,
  "An unknown source must be refused",
);
ok("source defaults to profile when absent and an unknown source is refused");

// Test 20: a cloud connect refuses without verification evidence.
assert.throws(
  () => connectCloudBrowser(ctxC, "gem", { verifiedVia: "", verifiedNote: "" }, { hold: false }),
  /needs verification evidence/,
  "A cloud connect without flags must be refused",
);
assert.throws(
  () => connectCloudBrowser(ctxC, "gem", { verifiedVia: "browser-task:abc123", verifiedNote: "" }, { hold: false }),
  /needs verification evidence/,
  "A cloud connect with only one flag must be refused",
);
assert.strictEqual(getConnectionStatus(ctxC, "gem").connected, false, "A refused cloud connect must not change state");
ok("a cloud connect refuses without verification evidence");

// Test 21: a cloud connect with flags stores the evidence and marks connected.
disconnectBrowser(ctxC, "gem", "Test setup disconnect.");
const cloudConnected = await connectCloudBrowser(
  ctxC,
  "gem",
  { verifiedVia: "browser-task:abc123", verifiedNote: "gemini.google.com shows the prompt box and the business mail account" },
  { hold: false },
);
assert.strictEqual(cloudConnected.browserConnected, true, "A verified cloud connect must mark the account connected");
assert.ok(cloudConnected.verifiedAt, "A cloud connect must record when it verified");
assert.strictEqual(cloudConnected.verifiedVia, "browser-task:abc123", "A cloud connect must store the browser task id");
assert.strictEqual(
  cloudConnected.verifiedNote,
  "gemini.google.com shows the prompt box and the business mail account",
  "A cloud connect must store the observation",
);
assert.strictEqual(cloudConnected.browserDisconnectReason, null, "A cloud connect must clear any old disconnect reason");
assert.strictEqual(cloudConnected.status, "active", "A verified cloud connect must reactivate a paused account");
ok("a cloud connect with flags stores the evidence and marks connected");

// Test 22: a cloud connect refuses with HOLD on, and refuses for a profile account.
assert.throws(
  () => connectCloudBrowser(ctxC, "gem", { verifiedVia: "browser-task:abc123", verifiedNote: "note" }, { hold: true }),
  /HOLD is on/,
  "A cloud connect with HOLD on must be refused",
);
assert.throws(
  () => connectCloudBrowser(ctxC, "main", { verifiedVia: "browser-task:abc123", verifiedNote: "note" }, { hold: false }),
  /not a cloud account/,
  "A cloud connect must refuse a profile account",
);
ok("a cloud connect refuses with HOLD on and refuses for a profile account");

// Test 23: the driver connect refuses a cloud account and leaves it disconnected.
disconnectBrowser(ctxC, "gem", "Test setup disconnect for the driver guard.");
await assert.rejects(
  connectBrowser(ctxC, "gem", new MockBrowserDriver(), { hold: false }),
  /cloud browser account/,
  "The driver connect must refuse a cloud account",
);
assert.strictEqual(getConnectionStatus(ctxC, "gem").connected, false, "A refused driver connect must leave the cloud account disconnected");
ok("the driver connect refuses a cloud account and leaves it disconnected");

// Test 24: disconnect works for cloud accounts and keeps the verification fields recorded.
await connectCloudBrowser(
  ctxC,
  "gem",
  { verifiedVia: "browser-task:abc123", verifiedNote: "gemini.google.com shows the prompt box and the business mail account" },
  { hold: false },
);
const cloudDisconnected = disconnectBrowser(ctxC, "gem", "Taking a break.");
assert.strictEqual(cloudDisconnected.browserConnected, false, "Disconnect must mark the cloud account disconnected");
assert.strictEqual(cloudDisconnected.browserDisconnectReason, "Taking a break.", "Disconnect must record the reason");
assert.strictEqual(cloudDisconnected.verifiedVia, "browser-task:abc123", "Disconnect must keep the verification evidence recorded");
assert.strictEqual(cloudDisconnected.status, "paused", "Disconnect must pause the cloud account");
ok("disconnect works for cloud accounts and keeps the verification fields recorded");

// Test 25: the status line shows the source and the verification note.
await connectCloudBrowser(
  ctxC,
  "gem",
  { verifiedVia: "browser-task:abc123", verifiedNote: "gemini.google.com shows the prompt box and the business mail account" },
  { hold: false },
);
const cloudStatus = getConnectionStatus(ctxC, "gem");
const cloudLine = formatConnectionLine(cloudStatus);
assert.ok(cloudLine.includes("source cloud"), "The cloud account line must say source cloud");
assert.ok(cloudLine.includes("verified via browser-task:abc123"), "The cloud account line must show the verification source");
assert.ok(cloudLine.includes("gemini.google.com shows the prompt box"), "The cloud account line must show the verification note");
const profileLine = formatConnectionLine(getConnectionStatus(ctxC, "main"));
assert.ok(profileLine.includes("source profile"), "The profile account line must say source profile");
assert.ok(!profileLine.includes("verified via"), "The profile account line must not show a cloud verification note");
ok("the status line shows the source and the verification note");

// Test 26: the cloud refusal names the relay and says no packet was created.
const gemAccount = loadAccounts(harnessRoot, "tenant-c").find((a) => a.id === "gem");
const refusal = cloudJobRefusal(gemAccount, "gemini");
assert.strictEqual(refusal, CLOUD_JOB_REFUSAL, "The refusal must be the exact shared cloud message");
assert.ok(refusal.includes("never runs from the CLI"), "The refusal must say the job never runs from the CLI");
assert.ok(refusal.includes("cloud browser"), "The refusal must name the cloud browser");
assert.ok(refusal.includes("Telegram relay"), "The refusal must name the Telegram relay");
assert.ok(refusal.includes("No packet was created"), "The refusal must say no packet was created");
const profileAccount = loadAccounts(harnessRoot, "tenant-c").find((a) => a.id === "main");
assert.strictEqual(cloudJobRefusal(profileAccount, "chatgpt"), null, "A profile account must get no cloud refusal");
assert.strictEqual(cloudJobRefusal(gemAccount, "chatgpt"), null, "A provider mismatch must get no cloud refusal");
ok("the cloud refusal names the relay and says no packet was created");

// Test 27: a disconnected cloud account gets the verify-first message, not the relay message.
disconnectBrowser(ctxC, "gem", "Test setup disconnect for the refusal.");
const verifyFirst = cloudJobRefusal(loadAccounts(harnessRoot, "tenant-c").find((a) => a.id === "gem"), "gemini");
assert.ok(verifyFirst.includes("Verify the login first"), "A disconnected cloud account must get the verify-first message");
assert.ok(verifyFirst.includes("--verified-via"), "The verify-first message must name the verification flag");
assert.ok(!verifyFirst.includes("never runs from the CLI"), "A disconnected cloud account must not get the relay message yet");
ok("a disconnected cloud account gets the verify-first message");

// Test 28: recording a cloud job refuses bad input and never logs.
await connectCloudBrowser(
  ctxC,
  "gem",
  { verifiedVia: "browser-task:abc123", verifiedNote: "gemini.google.com shows the prompt box and the business mail account" },
  { hold: false },
);
assert.throws(() => recordCloudJob(ctxC, "nope", "gemini", { result: "ok", task: "Test" }), /was not found/, "A cloud job log must refuse an unknown account");
assert.throws(() => recordCloudJob(ctxC, "main", "chatgpt", { result: "ok", task: "Test" }), /not a cloud browser account/, "A cloud job log must refuse a profile account");
assert.throws(() => recordCloudJob(ctxC, "gem", "chatgpt", { result: "ok", task: "Test" }), /matching model/, "A cloud job log must refuse a provider mismatch");
assert.throws(() => recordCloudJob(ctxC, "gem", "gemini", { result: "maybe", task: "Test" }), /ok or failed/, "A cloud job log must refuse a bad result value");
assert.throws(() => recordCloudJob(ctxC, "gem", "gemini", { result: "ok", task: "   " }), /must not be empty/, "A cloud job log must refuse an empty task");
disconnectBrowser(ctxC, "gem", "Test setup disconnect for the log guard.");
assert.throws(() => recordCloudJob(ctxC, "gem", "gemini", { result: "ok", task: "Test" }), /not connected/, "A cloud job log must refuse a disconnected cloud account");
ok("recording a cloud job refuses bad input and never logs");

// Test 29: recording a cloud job appends the audit event and records one use.
await connectCloudBrowser(
  ctxC,
  "gem",
  { verifiedVia: "browser-task:abc123", verifiedNote: "gemini.google.com shows the prompt box and the business mail account" },
  { hold: false },
);
const beforeCount = loadAccounts(harnessRoot, "tenant-c").find((a) => a.id === "gem").dailyCount;
const logged = recordCloudJob(ctxC, "gem", "gemini", { result: "ok", task: "Daily food plan draft", taskType: "research" });
assert.strictEqual(logged.dailyCount, beforeCount + 1, "A logged cloud job must record one use on the account");
const events = readAuditEvents(harnessRoot, "tenant-c");
const cloudEvent = events.filter((e) => e.event === "cloud_browser_job").pop();
assert.ok(cloudEvent, "A cloud job must append a cloud_browser_job audit event");
assert.strictEqual(cloudEvent.model, "gemini", "The audit event must name the model");
assert.strictEqual(cloudEvent.result, "ok", "The audit event must hold the result");
assert.ok((cloudEvent.detail || "").includes("account:gem"), "The audit event must name the account");
assert.ok((cloudEvent.detail || "").includes("task:Daily food plan draft"), "The audit event must hold the short task description");
ok("recording a cloud job appends the audit event and records one use");

// Test 30: the secret-field guard rejects every forbidden key in a record.
for (const key of ["password", "token", "secret", "apiKey", "sessionToken", "cookie"]) {
  const record = { id: "bad", provider: "chatgpt", [key]: "x" };
  assert.throws(() => assertNoSecrets(record), new RegExp(`must never contain ${key}`), `The guard must reject a record containing ${key}`);
}
assert.doesNotThrow(() => assertNoSecrets({ id: "good", provider: "chatgpt", source: "cloud", verifiedVia: "browser-task:abc123", verifiedNote: "checked" }), "The guard must allow a clean cloud record");
ok("the secret-field guard rejects every forbidden key in a record");

console.log(`All ${passed} connection test groups passed. Temp dir: ${tmp}`);

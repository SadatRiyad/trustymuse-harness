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
const { addAccount, loadAccounts } = await import(path.join(distDir, "session", "accounts.js"));
const { MockBrowserDriver } = await import(path.join(distDir, "session", "browser.js"));
const {
  assertBrowserConnected,
  connectBrowser,
  disconnectBrowser,
  formatConnectionLine,
  getConnectionStatus,
  listConnectionStatuses,
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
  "id", "provider", "label", "profileDir", "status", "lastUsed", "dailyCount",
  "dailyDate", "enabled", "createdAt", "browserConnected", "browserConnectedAt",
  "browserLastVerified", "browserDisconnectReason",
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

console.log(`All ${passed} connection test groups passed. Temp dir: ${tmp}`);

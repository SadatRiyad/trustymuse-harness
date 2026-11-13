import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.8 Analytics Phase 1 tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live prompt, no GitHub, no deploy.
// The collector builds a dry-run payload from local counts only. Nothing
// in this suite sends anything, and the scan test proves the analytics
// module holds no remote-call code at all.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const rootDir = path.join(__dirname, "..");
const srcDir = path.join(__dirname, "..", "src", "analytics");
const {
  PAYLOAD_FIELDS,
  PAYLOAD_VERSION,
  buildAnalyticsPayload,
  capBand,
  getOrCreateInstallId,
  readAnalyticsState,
  usedBand,
  validatePayload,
} = await import(path.join(distDir, "analytics", "collector.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-analytics-test-"));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOW = new Date("2026-11-12T12:00:00Z");
const repoVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).version;

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function makeTenant(root, id, displayName, cap) {
  const stateDir = path.join(root, "state", "tenants", id);
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    id,
    displayName,
    museAccountLabel: displayName,
    status: "active",
    monthlyCapUsd: cap,
    createdAt: "2026-11-01T00:00:00Z",
    lastUsed: null,
  };
}

function writeRegistry(root, tenants) {
  writeJson(path.join(root, "state", "tenants.json"), tenants);
}

function writeAudit(root, tenantId, events) {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "state", "tenants", tenantId, "audit.jsonl"), lines, "utf-8");
}

function account(id, provider, label, connected) {
  return {
    id,
    provider,
    label,
    profileDir: `/tmp/profiles/${provider}-${id}`,
    status: "active",
    lastUsed: null,
    dailyCount: 0,
    dailyDate: null,
    enabled: true,
    createdAt: "2026-11-01T00:00:00Z",
    browserConnected: connected,
    browserConnectedAt: connected ? "2026-11-12T00:00:00Z" : null,
    browserLastVerified: connected ? "2026-11-12T00:00:00Z" : null,
    browserDisconnectReason: null,
  };
}

function project(id, name, status, rootPath) {
  return {
    id,
    name,
    kind: "web-app",
    status,
    rootPath: rootPath || `/tmp/workspace/${id}`,
    allowedTaskTypes: ["seo", "blog", "code_review", "research", "content", "social"],
    allowedActions: ["read", "draft"],
    notes: "",
    createdAt: "2026-11-01T00:00:00Z",
    connectedAt: "2026-11-01T00:00:00Z",
    lastUsed: null,
  };
}

// Fixture root: two tenants with a synthetic audit log. Events inside
// the 24 hour window count; the one old event does not. Detail fields
// hold denylist strings on purpose, so the denylist test can prove the
// collector never reads them.
const harnessRoot = path.join(tmp, "harness");
fs.mkdirSync(harnessRoot, { recursive: true });
fs.copyFileSync(path.join(rootDir, "package.json"), path.join(harnessRoot, "package.json"));
const tenantA = makeTenant(harnessRoot, "tenant-a", "Tenant Alpha", 50);
const tenantB = makeTenant(harnessRoot, "tenant-b", "Tenant Beta", 0);
writeRegistry(harnessRoot, [tenantA, tenantB]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-a", "usage.json"), { "2026-11": 25 });
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-b", "usage.json"), { "2026-11": 0 });
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-a", "models.json"), ["chatgpt", "claude"]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-b", "models.json"), ["gemini"]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-a", "accounts.json"), [
  account("main", "chatgpt", "My Secret Label", true),
  account("second", "claude", "Second Label", false),
]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-b", "accounts.json"), [
  account("only", "chatgpt", "Beta Label", false),
]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-a", "projects.json"), [
  project("proj-one", "Private Project Name", "active", "/tmp/workspace/private-project"),
  project("proj-two", "Paused Project", "paused"),
]);
writeJson(path.join(harnessRoot, "state", "tenants", "tenant-b", "projects.json"), [
  project("proj-three", "Beta Project", "active"),
]);
writeAudit(harnessRoot, "tenant-a", [
  { at: "2026-11-12T10:00:00Z", runId: "run-1", event: "packet_generated", model: "chatgpt", taskType: "seo", detail: "packets/tenant-a/chatgpt-seo-task.md", result: "ok", tenant: "tenant-a" },
  { at: "2026-11-12T09:00:00Z", runId: "run-2", event: "packet_generated", model: "chatgpt", taskType: "blog", detail: "packets/tenant-a/chatgpt-blog-task.md", result: "ok", tenant: "tenant-a" },
  { at: "2026-11-11T13:00:00Z", runId: "run-3", event: "packet_generated", model: "claude", taskType: "research", detail: "packets/tenant-a/claude-research-task.md", result: "ok", tenant: "tenant-a" },
  { at: "2026-11-12T11:00:00Z", runId: "run-4", event: "browser_job_done", model: "chatgpt", taskType: "seo", detail: "browser-results/tenant-a/out.md", result: "ok", tenant: "tenant-a" },
  { at: "2026-11-12T08:00:00Z", runId: "run-5", event: "packet_blocked_model", model: "gemini", taskType: "seo", detail: "Secret task title DO NOT LEAK", result: "blocked", tenant: "tenant-a" },
  { at: "2026-11-12T07:00:00Z", runId: "run-6", event: "packet_result_validated", detail: "TOP SECRET RESULT user@example.com", result: "valid", tenant: "tenant-a" },
  { at: "2026-11-12T06:00:00Z", runId: "run-7", event: "packet_result_validated", detail: "results/tenant-a/bad.txt", result: "invalid", tenant: "tenant-a" },
  { at: "2026-11-12T05:00:00Z", runId: "run-8", event: "api_call_blocked", model: "openai", detail: "Monthly budget cap is 0", result: "blocked", tenant: "tenant-a" },
  { at: "2026-11-10T10:00:00Z", runId: "run-9", event: "packet_generated", model: "chatgpt", taskType: "seo", detail: "packets/tenant-a/old-task.md", result: "ok", tenant: "tenant-a" },
  { at: "2026-11-12T04:00:00Z", runId: "run-10", event: "packet_generated", model: "chatgpt", taskType: "seo", detail: "packets/tenant-a/extra.md", result: "ok", tenant: "tenant-a", prompt: "SECRET PROMPT TEXT", email: "leak@example.com" },
]);
writeAudit(harnessRoot, "tenant-b", [
  { at: "2026-11-12T10:30:00Z", runId: "run-11", event: "packet_generated", model: "gemini", taskType: "content", detail: "packets/tenant-b/gemini-content-task.md", result: "ok", tenant: "tenant-b" },
  { at: "2026-11-12T09:30:00Z", runId: "run-12", event: "packet_blocked_project_scope", model: "claude", taskType: "seo", detail: "project:proj-three", result: "blocked", tenant: "tenant-b" },
  { at: "2026-11-12T08:30:00Z", runId: "run-13", event: "browser_connect_blocked", detail: "only", result: "blocked", tenant: "tenant-b" },
]);

const payload = buildAnalyticsPayload(harnessRoot, NOW);

// Test 1: the collector aggregates the right counts from the synthetic
// audit log, counting only events inside the 24 hour window.
assert.strictEqual(payload.payload_version, 1, "Payload version must be 1");
assert.strictEqual(payload.harness_version, repoVersion, "Harness version must come from package.json");
assert.strictEqual(payload.sent_at, "2026-11-12T12:00:00.000Z", "sent_at must be the given time");
assert.strictEqual(payload.tenant_count, 2, "Tenant count must be 2");
assert.deepStrictEqual(payload.connected_models, ["chatgpt", "claude", "gemini"], "Connected models must be the sorted union across tenants");
assert.deepStrictEqual(
  payload.jobs_by_type,
  { seo: 3, blog: 1, code_review: 0, research: 1, content: 1, social: 0 },
  "Jobs by type must count only in-window job events",
);
assert.deepStrictEqual(payload.jobs_by_model, { chatgpt: 4, claude: 1, gemini: 1 }, "Jobs by model must count only in-window job events");
assert.strictEqual(payload.packet_jobs, 5, "Packet jobs must be 5 (4 in tenant A, 1 in tenant B, old event excluded)");
assert.strictEqual(payload.browser_jobs, 1, "Browser jobs must be 1");
assert.strictEqual(payload.jobs_ok, 6, "Jobs ok must be 6");
assert.strictEqual(payload.jobs_failed, 2, "Jobs failed must be 2 blocked job attempts (model and project scope)");
assert.strictEqual(payload.results_validated, 2, "Results validated must count both checks");
assert.deepStrictEqual(
  payload.error_categories,
  { model_blocked: 1, project_scope_blocked: 1, budget_blocked: 1, browser_login_failed: 1, validation_failed: 1 },
  "Error categories must map by event name only",
);
assert.strictEqual(payload.budget_cap_band, "11-100", "Cap band must be the highest cap across tenants (50)");
assert.strictEqual(payload.budget_used_band, "26-50", "Used band must be the highest percent used (50 percent)");
assert.strictEqual(payload.browser_accounts, 3, "Browser accounts must be 3 across tenants");
assert.strictEqual(payload.browser_connected, 1, "Browser connected must be 1");
assert.strictEqual(payload.projects_active, 2, "Active projects must be 2");
assert.strictEqual(payload.last_active_day, "2026-11-12", "Last active day must be the latest job day");
assert.ok(["linux", "darwin", "win32"].includes(payload.platform), "Platform must be one of the three families");
assert.strictEqual(payload.node_major, Number(process.version.replace(/^v/, "").split(".")[0]), "Node major must match the running Node");
ok("collector aggregates correct counts from a synthetic audit log");

// Test 2: denylist fields never appear in the payload, even though the
// audit log, project names, account labels, and tenant names hold them.
// The payload keys must also be exactly the allowlist.
const payloadJson = JSON.stringify(payload);
for (const leaked of [
  "Secret task title DO NOT LEAK",
  "TOP SECRET RESULT",
  "user@example.com",
  "leak@example.com",
  "SECRET PROMPT TEXT",
  "Tenant Alpha",
  "Tenant Beta",
  "My Secret Label",
  "Beta Label",
  "Private Project Name",
  "private-project",
]) {
  assert.ok(!payloadJson.includes(leaked), `Payload must never contain: ${leaked}`);
}
assert.deepStrictEqual(Object.keys(payload).sort(), [...PAYLOAD_FIELDS].sort(), "Payload keys must be exactly the allowlist");
assert.ok(!payloadJson.includes("detail"), "Payload must not carry an audit detail field");
ok("denylist fields never appear in the payload");

// Test 3: the install id is generated once, is a UUID, is stable across
// builds, and is stored locally with analytics off.
const firstId = payload.install_id;
assert.ok(UUID_V4.test(firstId), "Install id must be a UUID v4");
const second = buildAnalyticsPayload(harnessRoot, NOW);
assert.strictEqual(second.install_id, firstId, "Install id must be stable across builds");
const stored = readAnalyticsState(harnessRoot);
assert.ok(stored, "Analytics state file must exist after a build");
assert.strictEqual(stored.install_id, firstId, "Stored install id must match the payload");
assert.strictEqual(stored.analytics_enabled, false, "Analytics must stay off in Phase 1");
assert.strictEqual(stored.payload_version, PAYLOAD_VERSION, "Stored payload version must match the collector");
ok("install id is generated once, stable, and stored locally with analytics off");

// Test 4: budget bands map caps and percents to the design bands.
assert.strictEqual(capBand(0), "0", "Cap 0 must map to band 0");
assert.strictEqual(capBand(5), "1-10", "Cap 5 must map to band 1-10");
assert.strictEqual(capBand(10), "1-10", "Cap 10 must map to band 1-10");
assert.strictEqual(capBand(50), "11-100", "Cap 50 must map to band 11-100");
assert.strictEqual(capBand(500), "101-plus", "Cap 500 must map to band 101-plus");
assert.strictEqual(usedBand(0), "0", "Used 0 percent must map to band 0");
assert.strictEqual(usedBand(25), "1-25", "Used 25 percent must map to band 1-25");
assert.strictEqual(usedBand(50), "26-50", "Used 50 percent must map to band 26-50");
assert.strictEqual(usedBand(80), "51-80", "Used 80 percent must map to band 51-80");
assert.strictEqual(usedBand(90), "81-100", "Used 90 percent must map to band 81-100");
ok("budget bands map caps and percents to the design bands");

// Test 5: an empty install gives zero counts, no tenants, and a null
// last active day. The collector must not crash on missing state.
const emptyRoot = path.join(tmp, "empty-harness");
fs.mkdirSync(emptyRoot, { recursive: true });
fs.copyFileSync(path.join(rootDir, "package.json"), path.join(emptyRoot, "package.json"));
const empty = buildAnalyticsPayload(emptyRoot, NOW);
assert.strictEqual(empty.tenant_count, 0, "Empty install must have 0 tenants");
assert.deepStrictEqual(empty.connected_models, [], "Empty install must have no connected models");
assert.deepStrictEqual(empty.jobs_by_type, { seo: 0, blog: 0, code_review: 0, research: 0, content: 0, social: 0 }, "Empty install must have zero jobs by type");
assert.deepStrictEqual(empty.jobs_by_model, {}, "Empty install must have zero jobs by model");
assert.strictEqual(empty.packet_jobs, 0, "Empty install must have 0 packet jobs");
assert.strictEqual(empty.browser_jobs, 0, "Empty install must have 0 browser jobs");
assert.strictEqual(empty.jobs_ok, 0, "Empty install must have 0 jobs ok");
assert.strictEqual(empty.jobs_failed, 0, "Empty install must have 0 jobs failed");
assert.strictEqual(empty.results_validated, 0, "Empty install must have 0 results validated");
assert.deepStrictEqual(empty.error_categories, {}, "Empty install must have no error categories");
assert.strictEqual(empty.budget_cap_band, "0", "Empty install must have cap band 0");
assert.strictEqual(empty.budget_used_band, "0", "Empty install must have used band 0");
assert.strictEqual(empty.browser_accounts, 0, "Empty install must have 0 browser accounts");
assert.strictEqual(empty.projects_active, 0, "Empty install must have 0 active projects");
assert.strictEqual(empty.last_active_day, null, "Empty install must have a null last active day");
ok("empty install gives zero counts");

// Test 6: the analytics module holds no remote-call code. The scan
// reads the source for fetch, http, socket, and the net module, and
// refuses any of them. The collector only reads local files.
const collectorSource = fs.readFileSync(path.join(srcDir, "collector.ts"), "utf-8");
for (const token of ["fetch", "http", "socket"]) {
  assert.ok(!collectorSource.includes(token), `collector.ts must not contain: ${token}`);
}
assert.ok(!/\bnet\b/.test(collectorSource), "collector.ts must not use the net module");
assert.ok(!/require\(\s*["']net["']\s*\)/.test(collectorSource), "collector.ts must not require net");
assert.ok(!/from\s+["']net["']/.test(collectorSource), "collector.ts must not import net");
assert.ok(!collectorSource.includes("XMLHttpRequest"), "collector.ts must not use XMLHttpRequest");
ok("analytics module holds no remote-call code");

// Test 7: the real CLI preview prints the payload and states nothing
// was sent. A scratch copy of the built CLI is used, so the real
// tenant state is never touched.
const cliRoot = path.join(tmp, "cli-harness");
fs.mkdirSync(cliRoot, { recursive: true });
fs.cpSync(distDir, path.join(cliRoot, "dist"), { recursive: true });
fs.copyFileSync(path.join(rootDir, "config.example.yaml"), path.join(cliRoot, "config.example.yaml"));
fs.copyFileSync(path.join(rootDir, "package.json"), path.join(cliRoot, "package.json"));
const cli = path.join(cliRoot, "dist", "index.js");
function runCli(...args) {
  return execFileSync("node", [cli, ...args], { encoding: "utf-8", cwd: cliRoot });
}
const setupOut = runCli("setup", "--id", "preview-tenant", "--name", "Preview Tenant");
assert.ok(setupOut.includes("Tenant created: preview-tenant"), "CLI setup must create the tenant");
runCli("model-connect", "--model", "chatgpt");
const packetOut = runCli("packet", "--model", "chatgpt", "--type", "seo", "--title", "Secret CLI Task Title", "--task", "Write a draft.");
assert.ok(packetOut.includes("Packet created:"), "CLI packet must create a packet");
const previewOut = runCli("analytics-preview");
assert.ok(previewOut.includes("Nothing was sent"), "Preview must state that nothing was sent");
assert.ok(previewOut.includes('"payload_version": 1'), "Preview must print the payload with version 1");
assert.ok(previewOut.includes('"packet_jobs": 1'), "Preview must show the one packet job just built");
assert.ok(previewOut.includes('"seo": 1'), "Preview must show one seo job");
assert.ok(previewOut.includes('"chatgpt": 1'), "Preview must show one chatgpt job");
assert.ok(!previewOut.includes("Secret CLI Task Title"), "Preview must never print the packet task title");
assert.ok(previewOut.includes("dry run only"), "Preview must say it is a dry run");
const previewState = JSON.parse(fs.readFileSync(path.join(cliRoot, "state", "analytics.json"), "utf-8"));
assert.ok(UUID_V4.test(previewState.install_id), "Preview must store a UUID install id locally");
assert.ok(previewState.last_preview_at, "Preview must stamp the last preview time");
ok("CLI preview prints the payload and states nothing was sent");

// Test 8: the real CLI status shows off, enable is refused with the
// Phase 2 message, and disable confirms nothing is sent.
const statusOut = runCli("analytics-status");
assert.ok(statusOut.includes("Analytics: OFF"), "Status must show analytics off");
assert.ok(statusOut.includes("Install id:"), "Status must show the install id");
assert.ok(statusOut.includes("Last send: never"), "Status must show that nothing was ever sent");
assert.ok(statusOut.includes("Phase 1"), "Status must say this is Phase 1");
const enableOut = runCli("analytics-enable");
assert.ok(enableOut.includes("cannot be enabled yet"), "Enable must refuse");
assert.ok(enableOut.includes("Phase 2"), "Enable refusal must name Phase 2");
assert.ok(enableOut.includes("Nothing was enabled"), "Enable refusal must confirm nothing was enabled");
const disableOut = runCli("analytics-disable");
assert.ok(disableOut.includes("nothing is being sent"), "Disable must confirm nothing is being sent");
assert.ok(disableOut.includes("Nothing was changed"), "Disable must confirm nothing was changed");
const afterDisable = JSON.parse(fs.readFileSync(path.join(cliRoot, "state", "analytics.json"), "utf-8"));
assert.strictEqual(afterDisable.analytics_enabled, false, "Disable must leave analytics off");
ok("CLI status shows off, enable is refused, disable confirms nothing is sent");

// Test 9: tenant isolation. A preview run under tenant B writes its
// audit event only to tenant B's log, and the payload never names a
// tenant. Totals are install-wide by design, but no tenant identity
// ever appears in the payload.
runCli("setup", "--id", "second-tenant", "--name", "Second Tenant");
const previewB = runCli("analytics-preview", "--tenant", "second-tenant");
assert.ok(previewB.includes("Analytics preview for tenant second-tenant"), "Preview must name the resolved tenant in its header");
assert.ok(!previewB.includes("preview-tenant"), "Preview for tenant B must not name tenant A");
assert.ok(!previewB.includes("Preview Tenant"), "Preview must never print a tenant display name");
assert.ok(!previewB.includes("Second Tenant"), "Preview must never print a tenant display name");
const auditA = fs.readFileSync(path.join(cliRoot, "state", "tenants", "preview-tenant", "audit.jsonl"), "utf-8");
const auditB = fs.readFileSync(path.join(cliRoot, "state", "tenants", "second-tenant", "audit.jsonl"), "utf-8");
const countIn = (text, needle) => text.split(needle).length - 1;
assert.strictEqual(countIn(auditA, "analytics_preview"), 1, "Tenant A log must hold exactly one preview event: its own from test 7, not tenant B's");
assert.strictEqual(countIn(auditB, "analytics_preview"), 1, "Tenant B log must hold exactly one preview event: its own");
assert.ok(!auditB.includes("preview-tenant"), "Tenant B log must not name tenant A");
ok("tenant isolation: preview stays in its own tenant log, payload names no tenant");

// Test 10: building the payload twice gives identical counts. The
// preview audit event itself must not inflate any job count.
const again = buildAnalyticsPayload(harnessRoot, NOW);
assert.strictEqual(again.packet_jobs, payload.packet_jobs, "Second build must give the same packet count");
assert.strictEqual(again.jobs_ok, payload.jobs_ok, "Second build must give the same ok count");
assert.deepStrictEqual(again.jobs_by_type, payload.jobs_by_type, "Second build must give the same jobs by type");
assert.deepStrictEqual(again.error_categories, payload.error_categories, "Second build must give the same error categories");
ok("building the payload twice gives identical counts");

// Test 11: the validator refuses a payload with an extra field, and
// refuses an over-size payload. The allowlist is enforced, not just
// documented.
const tampered = { ...payload, prompt_text: "should never be here" };
assert.throws(() => validatePayload(tampered), /allowlist/, "Validator must refuse an extra field");
const huge = { ...payload, jobs_by_model: {} };
for (let i = 0; i < 2000; i += 1) {
  huge.jobs_by_model[`model-${i}`] = 1;
}
assert.throws(() => validatePayload(huge), /10 KB/, "Validator must refuse an over-size payload");
validatePayload(payload);
ok("validator refuses an extra field and an over-size payload");

console.log(`All ${passed} test groups passed. Temp dir: ${tmp}`);

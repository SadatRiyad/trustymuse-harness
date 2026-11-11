import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.4 multi-tenant tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live prompt, no GitHub, no deploy.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const {
  MIGRATION_TENANT_ID,
  addTenant,
  getTenant,
  listTenants,
  migrateTenants,
  pauseTenant,
  removeTenant,
  setupTenant,
  validateTenantId,
} = await import(path.join(distDir, "tenants", "tenants.js"));
const { createTenantContext, resolveTenantId, tenantCapUsd } = await import(
  path.join(distDir, "tenants", "context.js")
);
const { appendAudit, readAuditEvents } = await import(path.join(distDir, "audit.js"));
const { BudgetTracker } = await import(path.join(distDir, "budget.js"));
const { addAccount, loadAccounts } = await import(path.join(distDir, "session", "accounts.js"));
const { addProject, listProjects } = await import(path.join(distDir, "projects", "projects.js"));
const { DEFAULT_CONFIG } = await import(path.join(distDir, "config.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-tenants-test-"));
const harnessRoot = path.join(tmp, "harness");
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(harnessRoot, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

function makeConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser },
    projects: { ...DEFAULT_CONFIG.projects },
    tenants: { ...DEFAULT_CONFIG.tenants, ...(overrides.tenants || {}) },
    ...overrides,
  };
}

function makeFakeProjectDir(name) {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, "utf-8");
  return dir;
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

// 1. Add and list tenants, state dir created on add.
const alice = addTenant({ id: "alice-smith", displayName: "Alice Smith", museAccountLabel: "alice" }, { rootDir: harnessRoot });
assert.equal(alice.id, "alice-smith");
assert.equal(alice.status, "active");
assert.equal(alice.monthlyCapUsd, 0);
assert.ok(fs.existsSync(path.join(harnessRoot, "state", "tenants", "alice-smith")));
assert.equal(listTenants(harnessRoot).length, 1);
ok("add and list tenants, state dir created on add");

// 2. Duplicate id rejected.
assert.throws(() => addTenant({ id: "alice-smith", displayName: "Alice Again" }, { rootDir: harnessRoot }), /already exists/);
ok("duplicate tenant id rejected");

// 3. Invalid ids rejected: too short, uppercase, double hyphen, trailing hyphen, traversal, absolute.
for (const bad of ["ab", "Alice", "a--b", "a-", "../etc", "/abs", "a_b", "a b"]) {
  assert.throws(() => validateTenantId(bad), /Tenant id/, `id ${bad} should be rejected`);
}
ok("invalid tenant ids rejected");

// 4. Reserved ids rejected, including default via tenant-add.
for (const reserved of ["default", "system", "admin", "root", "all", "shared"]) {
  assert.throws(() => addTenant({ id: reserved, displayName: "Reserved" }, { rootDir: harnessRoot }), /reserved/);
}
ok("reserved tenant ids rejected");

// 5. Secret fields rejected.
assert.throws(
  () => addTenant({ id: "mallory-x", displayName: "Mallory", museAccountLabel: "my password is hunter2" }, { rootDir: harnessRoot }),
  /must never contain/,
);
assert.throws(
  () => addTenant({ id: "mallory-y", displayName: "Token Holder", museAccountLabel: "mallory" }, { rootDir: harnessRoot }),
  /must never contain/,
);
ok("secret fields in tenant records rejected");

// 6. Tenant isolation: A cannot see B's projects, accounts, or audit events.
const bob = addTenant({ id: "bob-jones", displayName: "Bob Jones", museAccountLabel: "bob" }, { rootDir: harnessRoot });
const aliceProjectDir = makeFakeProjectDir("alice-site");
addProject({ id: "alice-site", name: "Alice Site", kind: "web-app", rootPath: aliceProjectDir }, { rootDir: harnessRoot, tenantId: "alice-smith", workspaceRoot: workspace });
addAccount({ provider: "chatgpt", id: "main", label: "Alice ChatGPT" }, { rootDir: harnessRoot, tenantId: "alice-smith", profileRoot: path.join(harnessRoot, "profiles") });
appendAudit({ at: new Date().toISOString(), runId: "run-test-alice", event: "packet_generated", result: "ok" }, harnessRoot, "alice-smith");
assert.equal(listProjects(harnessRoot, "alice-smith").length, 1);
assert.equal(loadAccounts(harnessRoot, "alice-smith").length, 1);
assert.equal(readAuditEvents(harnessRoot, "alice-smith").length, 1);
assert.equal(listProjects(harnessRoot, "bob-jones").length, 0);
assert.equal(loadAccounts(harnessRoot, "bob-jones").length, 0);
assert.equal(readAuditEvents(harnessRoot, "bob-jones").length, 0);
// The account profile landed under the tenant's own profile folder.
const aliceAccount = loadAccounts(harnessRoot, "alice-smith")[0];
assert.ok(aliceAccount.profileDir.includes(path.join("profiles", "alice-smith")), aliceAccount.profileDir);
ok("tenant isolation: A cannot see B projects, accounts, or audit events");

// 7. Budget is per tenant: separate caps and separate usage.
const aliceBudget = new BudgetTracker(10, 80, harnessRoot, "alice-smith");
aliceBudget.recordSpend(4);
assert.equal(aliceBudget.getStatus().usedUsd, 4);
assert.equal(aliceBudget.canSpend(5).allowed, true);
const bobBudget = new BudgetTracker(0, 80, harnessRoot, "bob-jones");
assert.equal(bobBudget.getStatus().usedUsd, 0);
assert.equal(bobBudget.canSpend(1).allowed, false);
assert.equal(tenantCapUsd({ ...bob, monthlyCapUsd: 5 }, makeConfig({ monthlyCapUsd: 0 })), 5);
assert.equal(tenantCapUsd({ ...bob, monthlyCapUsd: 0 }, makeConfig({ monthlyCapUsd: 0 })), 0);
ok("budget is per tenant: separate caps and separate usage");

// 8. Unknown and paused tenants fail closed, and no state is created for them.
assert.throws(() => createTenantContext(harnessRoot, makeConfig(), { flag: "no-such-tenant" }), /was not found/);
assert.ok(!fs.existsSync(path.join(harnessRoot, "state", "tenants", "no-such-tenant")));
pauseTenant("bob-jones", harnessRoot);
assert.throws(() => createTenantContext(harnessRoot, makeConfig(), { flag: "bob-jones" }), /is paused/);
assert.equal(getTenant("bob-jones", harnessRoot).status, "paused");
ok("unknown and paused tenants fail closed");

// 9. Missing tenant state directory fails closed instead of recreating.
const carol = addTenant({ id: "carol-doe", displayName: "Carol Doe" }, { rootDir: harnessRoot });
fs.rmSync(path.join(harnessRoot, "state", "tenants", "carol-doe"), { recursive: true, force: true });
assert.throws(() => createTenantContext(harnessRoot, makeConfig(), { flag: "carol-doe" }), /state directory .* is missing/);
ok("missing tenant state directory fails closed instead of recreating");

// 10. Resolution order: flag beats env beats config beats default.
const carolDir = path.join(harnessRoot, "state", "tenants", "carol-doe");
fs.mkdirSync(carolDir, { recursive: true });
const cfg = makeConfig({ tenants: { defaultTenant: "alice-smith", maxTenants: 10 } });
assert.equal(resolveTenantId(harnessRoot, cfg, {}), "alice-smith");
assert.equal(resolveTenantId(harnessRoot, cfg, { env: { TRUSTYMUSE_TENANT: "bob-jones" } }), "bob-jones");
assert.equal(resolveTenantId(harnessRoot, cfg, { flag: "carol-doe", env: { TRUSTYMUSE_TENANT: "bob-jones" } }), "carol-doe");
assert.equal(resolveTenantId(harnessRoot, makeConfig(), {}), "default");
const ctx = createTenantContext(harnessRoot, cfg, { flag: "carol-doe" });
assert.equal(ctx.tenantId, "carol-doe");
assert.equal(ctx.stateDir, path.join(harnessRoot, "state", "tenants", "carol-doe"));
assert.equal(ctx.profileRoot, path.join(harnessRoot, "profiles", "carol-doe"));
ok("tenant resolution order: flag, then env, then config, then default");

// 11. Remove refuses the last active tenant, and works once another is active.
const singleRoot = path.join(tmp, "single");
fs.mkdirSync(singleRoot, { recursive: true });
addTenant({ id: "only-one", displayName: "Only One" }, { rootDir: singleRoot });
assert.throws(() => removeTenant("only-one", singleRoot), /last active tenant/);
addTenant({ id: "second-one", displayName: "Second One" }, { rootDir: singleRoot });
const removed = removeTenant("only-one", singleRoot);
assert.equal(removed.id, "only-one");
assert.ok(!fs.existsSync(path.join(singleRoot, "state", "tenants", "only-one")));
assert.equal(listTenants(singleRoot).length, 1);
ok("remove refuses the last active tenant, works once another is active");

// 12. Max tenants enforced.
const maxRoot = path.join(tmp, "maxt");
fs.mkdirSync(maxRoot, { recursive: true });
addTenant({ id: "tenant-one", displayName: "One" }, { rootDir: maxRoot, maxTenants: 2 });
addTenant({ id: "tenant-two", displayName: "Two" }, { rootDir: maxRoot, maxTenants: 2 });
assert.throws(() => addTenant({ id: "tenant-three", displayName: "Three" }, { rootDir: maxRoot, maxTenants: 2 }), /Tenant limit reached/);
ok("max tenants enforced");

// 13. Setup creates a tenant and six steps, never asks for a password or key.
const setupRoot = path.join(tmp, "setup");
fs.mkdirSync(setupRoot, { recursive: true });
const setup = setupTenant({ id: "dana-lee", displayName: "Dana Lee" }, { rootDir: setupRoot });
assert.equal(setup.tenant.id, "dana-lee");
assert.equal(setup.steps.length, 6);
assert.ok(!setup.steps.join(" ").match(/enter your (password|key)|type your (password|key)/i));
assert.ok(setup.steps.join(" ").includes("never asks for your password"));
assert.ok(setup.steps.join(" ").includes("model-connect --model chatgpt"));
assert.ok(getTenant("dana-lee", setupRoot));
ok("setup creates a tenant and six steps, never asks for a password or key");

// 14. Migration preserves projects and audit events and is idempotent.
const migRoot = path.join(tmp, "migrate");
const migWorkspace = path.join(tmp, "migrate-workspace");
fs.mkdirSync(migRoot, { recursive: true });
fs.mkdirSync(migWorkspace, { recursive: true });
const legacyProjects = ["alpha-site", "beta-api", "gamma-docs", "delta-app"];
for (const name of legacyProjects) {
  const dir = path.join(migWorkspace, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, "utf-8");
  addProject({ id: name, name, kind: "web-app", rootPath: dir }, { rootDir: migRoot, workspaceRoot: migWorkspace });
}
for (let i = 0; i < 5; i += 1) {
  appendAudit({ at: new Date().toISOString(), runId: `run-legacy-${i}`, event: "packet_generated", result: "ok" }, migRoot);
}
addAccount({ provider: "claude", id: "main", label: "Legacy Claude" }, { rootDir: migRoot, profileRoot: path.join(migRoot, "profiles") });
const legacyProfileFile = path.join(migRoot, "profiles", "claude-main", "dummy.txt");
fs.mkdirSync(path.dirname(legacyProfileFile), { recursive: true });
fs.writeFileSync(legacyProfileFile, "profile data", "utf-8");
const legacyAuditCount = readAuditEvents(migRoot).length;
assert.equal(legacyAuditCount, 5);
const first = migrateTenants(migRoot);
assert.equal(first.migrated, true);
assert.equal(first.tenantId, MIGRATION_TENANT_ID);
assert.equal(first.projectsMoved, 4);
assert.equal(first.auditEventsMoved, 5);
assert.equal(first.accountsMoved, 1);
assert.equal(first.profilesMoved, true);
assert.ok(first.backupDir && fs.existsSync(first.backupDir));
assert.ok(fs.existsSync(path.join(first.backupDir, "projects.json")));
assert.ok(fs.existsSync(path.join(first.backupDir, "audit.jsonl")));
assert.ok(fs.existsSync(path.join(first.backupDir, "profiles")));
assert.ok(!fs.existsSync(path.join(migRoot, "state", "projects.json")));
assert.ok(!fs.existsSync(path.join(migRoot, "state", "audit.jsonl")));
assert.equal(listProjects(migRoot, MIGRATION_TENANT_ID).length, 4);
assert.equal(readAuditEvents(migRoot, MIGRATION_TENANT_ID).length, 5);
assert.equal(loadAccounts(migRoot, MIGRATION_TENANT_ID).length, 1);
assert.ok(fs.existsSync(path.join(migRoot, "profiles", MIGRATION_TENANT_ID, "claude-main", "dummy.txt")));
// Byte-identical backup check.
assert.ok(
  fs.readFileSync(path.join(first.backupDir, "projects.json")).equals(
    fs.readFileSync(path.join(migRoot, "state", "tenants", MIGRATION_TENANT_ID, "projects.json")),
  ),
);
const second = migrateTenants(migRoot);
assert.equal(second.migrated, false);
assert.equal(second.projectsMoved, 4);
assert.equal(second.auditEventsMoved, 5);
assert.equal(listProjects(migRoot, MIGRATION_TENANT_ID).length, 4);
assert.equal(readAuditEvents(migRoot, MIGRATION_TENANT_ID).length, 5);
ok("migration preserves 4 projects and audit events and is idempotent");

console.log(`All ${passed} tenant test groups passed. Temp dir: ${tmp}`);

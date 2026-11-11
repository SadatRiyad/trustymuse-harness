import * as fs from "fs";
import * as path from "path";
import { stateDir, tenantsDir } from "../audit";

// Tenant registry for V1.4 multi-tenant support.
// One tenant is one Muse account. One install, many tenants, each tenant
// fully isolated: its own state, budget, accounts, projects, profiles, and
// audit log under state/tenants/<tenantId>/ and profiles/<tenantId>/.
// The registry itself lives at state/tenants.json and holds only the id,
// display name, a human label, status, and timestamps. No tenant data,
// no credential, and no password ever lives here.
// Honest limit: there is no public Muse account API and no central server
// in V1.4. Each Muse account runs its own copy of the harness in its own
// Muse workspace. V1.4 makes one install portable across many tenants on
// one machine. It does NOT let one user see or control another user's
// Muse account, and it does NOT create a hosted team server.

export type TenantStatus = "active" | "paused";

export const DEFAULT_MAX_TENANTS = 10;
export const MIGRATION_TENANT_ID = "sadat-riyad";
export const MIGRATION_TENANT_NAME = "Sadat Riyad";

// Ids the user may never claim. "default" is reserved for the built-in
// fallback tenant and may only be used as the resolution fallback, never
// as a tenant created with tenant-add.
export const RESERVED_TENANT_IDS = ["default", "system", "admin", "root", "all", "shared"];

export interface TenantEntry {
  id: string;
  displayName: string;
  museAccountLabel: string;
  status: TenantStatus;
  monthlyCapUsd: number;
  createdAt: string;
  lastUsed: string | null;
}

export interface TenantInput {
  id: string;
  displayName: string;
  museAccountLabel?: string;
  monthlyCapUsd?: number;
}

export interface TenantOptions {
  rootDir?: string;
  maxTenants?: number;
}

export const SECRET_MARKERS = ["password", "token", "secret", "apikey", "api_key", "sessiontoken", "cookie"];

// 3 to 40 chars, lowercase letters and digits, single hyphens only,
// never starting or ending with a hyphen. This also rejects "..", "/",
// absolute paths, and anything that could escape the tenants directory.
export function validateTenantId(id: string): void {
  if (!id || typeof id !== "string") {
    throw new Error("Tenant id must not be empty.");
  }
  if (id.length < 3 || id.length > 40) {
    throw new Error("Tenant id must be 3 to 40 characters long.");
  }
  if (!/^[a-z0-9]([a-z0-9]|-(?=[a-z0-9])){2,39}$/.test(id)) {
    throw new Error("Tenant id must be lowercase letters, digits, or single hyphens, for example jane-doe. It must not start or end with a hyphen, and must not contain .. or /.");
  }
  if (RESERVED_TENANT_IDS.includes(id)) {
    throw new Error(`Tenant id ${id} is reserved. The id default is only the built-in fallback, never a tenant you create. Choose your own id, for example your name as a slug.`);
  }
}

// Fail closed if anyone tries to smuggle a secret into a tenant record.
// Checks both field names and string values, case-insensitive.
export function assertNoSecretsInTenant(record: unknown): void {
  if (!record || typeof record !== "object") {
    return;
  }
  const entries = Object.entries(record as Record<string, unknown>);
  for (const [key, value] of entries) {
    const keyLower = key.toLowerCase();
    if (SECRET_MARKERS.some((marker) => keyLower.includes(marker))) {
      throw new Error(`Tenant record must never contain a field named ${key}. No password or token is stored.`);
    }
    if (typeof value === "string") {
      const valueLower = value.toLowerCase();
      const hit = SECRET_MARKERS.find((marker) => valueLower.includes(marker));
      if (hit) {
        throw new Error(`Tenant field ${key} must never contain ${hit}. No password or token is stored.`);
      }
    }
  }
}

export function tenantsFilePath(rootDir?: string): string {
  return path.join(stateDir(rootDir), "tenants.json");
}

// The tenant state directory. Validates the id first, so no id can ever
// escape state/tenants/ through .., /, or an absolute path.
export function tenantRoot(rootDir: string | undefined, tenantId: string): string {
  validateTenantId(tenantId);
  const dir = path.join(tenantsDir(rootDir), tenantId);
  const resolved = path.resolve(dir);
  const base = path.resolve(tenantsDir(rootDir));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Tenant id ${tenantId} is not allowed. It must stay inside the tenants directory.`);
  }
  return resolved;
}

export function tenantStateExists(rootDir: string | undefined, tenantId: string): boolean {
  return fs.existsSync(tenantRoot(rootDir, tenantId));
}

export function loadTenants(rootDir?: string): TenantEntry[] {
  const file = tenantsFilePath(rootDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const tenants = parsed as TenantEntry[];
    for (const tenant of tenants) {
      assertNoSecretsInTenant(tenant);
    }
    return tenants;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must never contain")) {
      throw error;
    }
    return [];
  }
}

export function saveTenants(tenants: TenantEntry[], rootDir?: string): void {
  for (const tenant of tenants) {
    assertNoSecretsInTenant(tenant);
  }
  const dir = stateDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tenantsFilePath(rootDir), JSON.stringify(tenants, null, 2) + "\n", "utf-8");
}

export function listTenants(rootDir?: string): TenantEntry[] {
  return loadTenants(rootDir);
}

export function getTenant(id: string, rootDir?: string): TenantEntry | null {
  return loadTenants(rootDir).find((t) => t.id === id) || null;
}

// Create a tenant and its state directory at once. A tenant entry always
// has a state directory from the moment it exists, so a missing directory
// later means corruption, never a fresh tenant.
export function addTenant(input: TenantInput, options: TenantOptions = {}): TenantEntry {
  validateTenantId(input.id);
  const maxTenants = options.maxTenants ?? DEFAULT_MAX_TENANTS;
  const displayName = (input.displayName || "").trim();
  if (!displayName) {
    throw new Error("Tenant display name must not be empty.");
  }
  const label = (input.museAccountLabel || displayName).trim();
  if (!label) {
    throw new Error("Tenant Muse account label must not be empty.");
  }
  const cap = input.monthlyCapUsd ?? 0;
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error("Tenant monthly budget cap must be 0 or more. The default is 0, which blocks every paid API call.");
  }
  assertNoSecretsInTenant(input);
  const existing = loadTenants(options.rootDir);
  if (existing.length >= maxTenants) {
    throw new Error(`Tenant limit reached. At most ${maxTenants} tenants can exist on this install.`);
  }
  if (existing.some((t) => t.id === input.id)) {
    throw new Error(`Tenant id ${input.id} already exists. Use tenant-list to see existing tenants.`);
  }
  const now = new Date().toISOString();
  const tenant: TenantEntry = {
    id: input.id,
    displayName,
    museAccountLabel: label,
    status: "active",
    monthlyCapUsd: cap,
    createdAt: now,
    lastUsed: null,
  };
  assertNoSecretsInTenant(tenant);
  existing.push(tenant);
  saveTenants(existing, options.rootDir);
  fs.mkdirSync(tenantRoot(options.rootDir, tenant.id), { recursive: true });
  return tenant;
}

export function setTenantStatus(id: string, status: TenantStatus, rootDir?: string): TenantEntry {
  const tenants = loadTenants(rootDir);
  const tenant = tenants.find((t) => t.id === id);
  if (!tenant) {
    throw new Error(`Tenant ${id} was not found. Use tenant-list to see existing tenants.`);
  }
  tenant.status = status;
  saveTenants(tenants, rootDir);
  return tenant;
}

export function pauseTenant(id: string, rootDir?: string): TenantEntry {
  return setTenantStatus(id, "paused", rootDir);
}

export function markTenantUsed(id: string, rootDir?: string): TenantEntry | null {
  const tenants = loadTenants(rootDir);
  const tenant = tenants.find((t) => t.id === id);
  if (!tenant) {
    return null;
  }
  tenant.lastUsed = new Date().toISOString();
  saveTenants(tenants, rootDir);
  return tenant;
}

// Remove a tenant and its state. Refuses when it is the last active
// tenant, and refuses when its state directory is missing, because a
// tenant created by addTenant always has one: a missing directory means
// corruption or a partial delete, and this code will not silently recreate
// or silently discard state it cannot see.
export function removeTenant(id: string, rootDir?: string): TenantEntry {
  validateTenantId(id);
  const tenants = loadTenants(rootDir);
  const index = tenants.findIndex((t) => t.id === id);
  if (index < 0) {
    throw new Error(`Tenant ${id} was not found. Use tenant-list to see existing tenants.`);
  }
  const active = tenants.filter((t) => t.status === "active");
  if (active.length <= 1 && tenants[index].status === "active") {
    throw new Error(`Tenant ${id} is the last active tenant. Refusing to remove it. Add another active tenant first.`);
  }
  const dir = tenantRoot(rootDir, id);
  if (!fs.existsSync(dir)) {
    throw new Error(`Tenant ${id} has no state directory at ${dir}. That suggests corruption or a partial delete. Refusing to remove it. Check the state directory by hand first.`);
  }
  const stateFiles = ["projects.json", "accounts.json", "audit.jsonl", "usage.json"];
  for (const file of stateFiles) {
    const full = path.join(dir, file);
    if (fs.existsSync(full) && (file.endsWith(".json") || file.endsWith(".jsonl"))) {
      try {
        const text = fs.readFileSync(full, "utf-8");
        if (file.endsWith(".json")) {
          JSON.parse(text);
        } else if (text.trim()) {
          for (const line of text.trim().split("\n")) {
            JSON.parse(line);
          }
        }
      } catch {
        throw new Error(`Tenant ${id} state file ${file} is corrupt and cannot be read. Refusing to remove the tenant. Check the state directory by hand first.`);
      }
    }
  }
  const [removed] = tenants.splice(index, 1);
  saveTenants(tenants, rootDir);
  fs.rmSync(dir, { recursive: true, force: true });
  return removed;
}

// First-run setup for a new Muse account. Interactive-free: creates the
// tenant, never asks for a password or a key, and returns the six next
// steps the user follows by hand. The caller writes config.yaml.
export function setupTenant(
  input: TenantInput,
  options: TenantOptions = {},
): { tenant: TenantEntry; steps: string[] } {
  const tenant = addTenant(input, options);
  const steps = [
    `Tenant ${tenant.id} (${tenant.displayName}) is created. Its state lives under state/tenants/${tenant.id}/ and its browser profiles under profiles/${tenant.id}/. Nothing is shared with other tenants.`,
    "Connect your own ChatGPT or Claude account with: node dist/index.js account-add --provider chatgpt --id main --label \"Main ChatGPT\" --tenant " + tenant.id,
    "Log in once by hand in that profile, in your own browser. The harness never asks for your password.",
    "Connect your own project with: node dist/index.js project-add --id my-project --name \"My Project\" --kind web-app --path ~/workspace/my-project --tenant " + tenant.id,
    "Connect the model first, no model starts connected: node dist/index.js model-connect --model chatgpt --tenant " + tenant.id,
    "Run your first job with: node dist/index.js packet --model chatgpt --type seo --title \"First task\" --task \"Write a draft.\" --project my-project --tenant " + tenant.id,
  ];
  return { tenant, steps };
}

export interface MigrationResult {
  migrated: boolean;
  tenantId: string;
  reason: string;
  projectsMoved: number;
  auditEventsMoved: number;
  accountsMoved: number;
  usageMoved: boolean;
  profilesMoved: boolean;
  backupDir: string | null;
}

function copyFileVerified(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const a = fs.readFileSync(src);
  const b = fs.readFileSync(dest);
  if (!a.equals(b)) {
    throw new Error(`Migration copy failed: ${dest} is not byte-identical to ${src}. Nothing was archived.`);
  }
}

function copyDirVerified(src: string, dest: string, skipDir?: string): number {
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  const skipAbs = skipDir ? path.resolve(skipDir) : null;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    // The migration destination can sit inside the source directory
    // (profiles/<tenantId> inside profiles/). Never copy the destination
    // into itself: skip it and everything under it.
    const fromAbs = path.resolve(from);
    if (skipAbs && (fromAbs === skipAbs || fromAbs.startsWith(skipAbs + path.sep))) {
      continue;
    }
    if (entry.isDirectory()) {
      count += copyDirVerified(from, to, skipDir);
    } else if (entry.isFile()) {
      copyFileVerified(from, to);
      count += 1;
    }
  }
  return count;
}

// Move the existing single-user state into the default tenant. The
// originals are copied first, verified byte-identical, and only then
// archived under state/migrated-backup-YYYY-MM-DD/. They are never deleted.
// Running it twice changes nothing the second time.
export function migrateTenants(rootDir?: string): MigrationResult {
  const base = rootDir || path.resolve(__dirname, "..", "..");
  const legacyState = stateDir(base);
  const legacyProjects = path.join(legacyState, "projects.json");
  const legacyAudit = path.join(legacyState, "audit.jsonl");
  const legacyUsage = path.join(legacyState, "usage.json");
  const legacyAccounts = path.join(legacyState, "accounts.json");
  const legacyProfiles = path.join(base, "profiles");
  const tenantId = MIGRATION_TENANT_ID;
  const tenantDir = tenantRoot(base, tenantId);
  const hasLegacy = fs.existsSync(legacyProjects) || fs.existsSync(legacyAudit) || fs.existsSync(legacyAccounts) || fs.existsSync(legacyUsage);

  const existing = getTenant(tenantId, base);
  if (existing && fs.existsSync(path.join(tenantDir, "projects.json")) && !hasLegacy) {
    const projects = JSON.parse(fs.readFileSync(path.join(tenantDir, "projects.json"), "utf-8")) as unknown[];
    const auditPath = path.join(tenantDir, "audit.jsonl");
    const auditCount = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf-8").trim().split("\n").filter(Boolean).length : 0;
    const accountsPath = path.join(tenantDir, "accounts.json");
    const accountsCount = fs.existsSync(accountsPath) ? (JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as unknown[]).length : 0;
    return {
      migrated: false,
      tenantId,
      reason: "Already migrated. The default tenant already holds the state and no legacy state files remain. Nothing changed.",
      projectsMoved: projects.length,
      auditEventsMoved: auditCount,
      accountsMoved: accountsCount,
      usageMoved: fs.existsSync(path.join(tenantDir, "usage.json")),
      profilesMoved: fs.existsSync(path.join(base, "profiles", tenantId)),
      backupDir: null,
    };
  }
  if (!hasLegacy) {
    return {
      migrated: false,
      tenantId,
      reason: "No legacy single-user state found. Nothing to migrate.",
      projectsMoved: 0,
      auditEventsMoved: 0,
      accountsMoved: 0,
      usageMoved: false,
      profilesMoved: false,
      backupDir: null,
    };
  }

  // Count before moving, so the report can compare before and after.
  let projectsMoved = 0;
  let auditEventsMoved = 0;
  let accountsMoved = 0;
  if (fs.existsSync(legacyProjects)) {
    projectsMoved = (JSON.parse(fs.readFileSync(legacyProjects, "utf-8")) as unknown[]).length;
  }
  if (fs.existsSync(legacyAudit)) {
    auditEventsMoved = fs.readFileSync(legacyAudit, "utf-8").trim().split("\n").filter(Boolean).length;
  }
  if (fs.existsSync(legacyAccounts)) {
    accountsMoved = (JSON.parse(fs.readFileSync(legacyAccounts, "utf-8")) as unknown[]).length;
  }

  if (!existing) {
    addTenant(
      { id: tenantId, displayName: MIGRATION_TENANT_NAME, museAccountLabel: MIGRATION_TENANT_NAME },
      { rootDir: base },
    );
  }
  fs.mkdirSync(tenantDir, { recursive: true });

  const moved: Array<{ from: string; to: string }> = [];
  const moveFile = (name: string): boolean => {
    const from = path.join(legacyState, name);
    if (!fs.existsSync(from)) {
      return false;
    }
    const to = path.join(tenantDir, name);
    copyFileVerified(from, to);
    moved.push({ from, to });
    return true;
  };
  moveFile("projects.json");
  moveFile("audit.jsonl");
  const usageMoved = moveFile("usage.json");
  moveFile("accounts.json");

  let profilesMoved = false;
  let profilesCount = 0;
  if (fs.existsSync(legacyProfiles) && fs.readdirSync(legacyProfiles).length > 0) {
    const profilesDest = path.join(base, "profiles", tenantId);
    profilesCount = copyDirVerified(legacyProfiles, profilesDest, profilesDest);
    profilesMoved = profilesCount > 0;
  }

  // Every copy is verified byte-identical. Only now archive the originals.
  const date = new Date().toISOString().slice(0, 10);
  const backupDir = path.join(legacyState, `migrated-backup-${date}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const { from } of moved) {
    fs.renameSync(from, path.join(backupDir, path.basename(from)));
  }
  if (profilesMoved) {
    // Archive the old profile folders, but not the tenant folder that was
    // just created inside profiles/ itself. Renaming the whole profiles
    // directory would carry the new tenant folder into the backup too.
    const backupProfiles = path.join(backupDir, "profiles");
    fs.mkdirSync(backupProfiles, { recursive: true });
    for (const entry of fs.readdirSync(legacyProfiles)) {
      if (entry === tenantId) {
        continue;
      }
      fs.renameSync(path.join(legacyProfiles, entry), path.join(backupProfiles, entry));
    }
  }

  return {
    migrated: true,
    tenantId,
    reason: `Migrated ${projectsMoved} projects, ${auditEventsMoved} audit events, ${accountsMoved} accounts, and ${profilesCount} profile files into tenant ${tenantId}. Originals are archived under ${backupDir}, never deleted.`,
    projectsMoved,
    auditEventsMoved,
    accountsMoved,
    usageMoved,
    profilesMoved,
    backupDir,
  };
}

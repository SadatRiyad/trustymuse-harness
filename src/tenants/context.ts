import * as fs from "fs";
import * as path from "path";
import { HarnessConfig } from "../config";
import { stateDir } from "../audit";
import {
  TenantEntry,
  addTenant,
  getTenant,
  loadTenants,
  markTenantUsed,
  tenantRoot,
  validateTenantId,
} from "./tenants";

// The tenant-scoped context. Every state access in the CLI goes through
// this object, so no function can read another tenant's state by accident:
// state lives under state/tenants/<tenantId>/ and browser profiles under
// profiles/<tenantId>/. There is no cross-tenant read anywhere.
export interface TenantContext {
  rootDir: string;
  tenantId: string;
  tenant: TenantEntry;
  stateDir: string;
  profileRoot: string;
}

export interface ResolveOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
}

// Resolution order, highest first: --tenant flag, TRUSTYMUSE_TENANT
// environment variable, tenants.default in config.yaml, then "default".
export function resolveTenantId(rootDir: string | undefined, config: HarnessConfig, options: ResolveOptions = {}): string {
  const env = options.env || process.env;
  const flag = (options.flag || "").trim();
  if (flag) {
    return flag;
  }
  const fromEnv = (env.TRUSTYMUSE_TENANT || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromConfig = (config.tenants?.defaultTenant || "").trim();
  if (fromConfig) {
    return fromConfig;
  }
  return "default";
}

function assertTenantStateHealthy(rootDir: string | undefined, tenant: TenantEntry): void {
  const dir = tenantRoot(rootDir, tenant.id);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Tenant ${tenant.id} is registered but its state directory ${dir} is missing. That suggests corruption or a partial delete. Refusing to use it. Check the state directory by hand first.`,
    );
  }
}

// Resolve and validate the active tenant, fail closed. Unknown, paused,
// or corrupt tenants stop the command before any state is read or written.
// On a fresh install with no tenant registry at all, the built-in
// "default" tenant is created once, so first-run commands keep working.
export function createTenantContext(
  rootDir: string,
  config: HarnessConfig,
  options: ResolveOptions = {},
): TenantContext {
  const requested = resolveTenantId(rootDir, config, options);
  const explicit = Boolean((options.flag || "").trim() || (options.env || process.env).TRUSTYMUSE_TENANT?.trim() || (config.tenants?.defaultTenant || "").trim());
  // "default" is allowed here as the built-in fallback. It is rejected
  // only by tenant-add, which never lets a user claim it as a tenant id.
  if (requested !== "default") {
    validateTenantId(requested);
  }
  const registryExists = fs.existsSync(path.join(stateDir(rootDir), "tenants.json"));

  if (!registryExists && !explicit && requested === "default") {
    const tenant = addTenant(
      { id: "default", displayName: "Default tenant", museAccountLabel: "Default tenant" },
      { rootDir, maxTenants: config.tenants?.maxTenants ?? 10 },
    );
    return {
      rootDir,
      tenantId: tenant.id,
      tenant,
      stateDir: tenantRoot(rootDir, tenant.id),
      profileRoot: path.join(rootDir, "profiles", tenant.id),
    };
  }
  if (!registryExists) {
    throw new Error(
      `Tenant ${requested} was not found. No tenant registry exists on this install yet. Create a tenant first with: node dist/index.js tenant-add --id <your-id> --name "<Your Name>".`,
    );
  }

  const tenant = getTenant(requested, rootDir);
  if (!tenant) {
    const known = loadTenants(rootDir).map((t) => t.id).join(", ") || "none";
    throw new Error(
      `Tenant ${requested} was not found. Known tenants: ${known}. Use tenant-list to see them, or create one with tenant-add. No state was read or written.`,
    );
  }
  if (tenant.status !== "active") {
    throw new Error(
      `Tenant ${requested} is ${tenant.status}. Only active tenants can run commands. Use tenant-list to see tenants, and ask the tenant owner to unpause it. No state was read or written.`,
    );
  }
  assertTenantStateHealthy(rootDir, tenant);
  markTenantUsed(tenant.id, rootDir);
  return {
    rootDir,
    tenantId: tenant.id,
    tenant,
    stateDir: tenantRoot(rootDir, tenant.id),
    profileRoot: path.join(rootDir, "profiles", tenant.id),
  };
}

// Per-tenant monthly budget cap. The tenant's own cap wins when it is set;
// otherwise the harness-wide cap in config.yaml applies. The default is 0
// either way, which blocks every paid API call.
export function tenantCapUsd(tenant: TenantEntry, config: HarnessConfig): number {
  if (typeof tenant.monthlyCapUsd === "number" && Number.isFinite(tenant.monthlyCapUsd)) {
    return tenant.monthlyCapUsd;
  }
  return config.monthlyCapUsd;
}

import * as fs from "fs";
import * as path from "path";

// Runtime config for V1. Values come from config.yaml when it exists.
// When the file is missing, safe defaults are used. API stays off, budget stays 0.
// This is a small parser for the flat two level YAML used in config.example.yaml.
// It is not a general YAML parser, and that is intentional for V1.

export interface BrowserConfig {
  enabled: boolean;
  headless: boolean;
  profileRoot: string;
  maxAccounts: number;
  pacingMs: number;
  dailyLimitPerAccount: number;
}

export interface ProjectsConfig {
  maxProjects: number;
}

export interface TenantsConfig {
  defaultTenant: string;
  maxTenants: number;
}

export interface HarnessConfig {
  monthlyCapUsd: number;
  currency: string;
  warnAtPercent: number;
  apiEnabled: boolean;
  subscriptionEnabled: boolean;
  subscriptionModels: string[];
  hold: boolean;
  requireApprovalFor: string[];
  browser: BrowserConfig;
  projects: ProjectsConfig;
  tenants: TenantsConfig;
}

export const DEFAULT_PROJECTS_CONFIG: ProjectsConfig = {
  maxProjects: 20,
};

export const DEFAULT_TENANTS_CONFIG: TenantsConfig = {
  defaultTenant: "default",
  maxTenants: 10,
};

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: false,
  headless: true,
  profileRoot: "./profiles",
  maxAccounts: 3,
  pacingMs: 8000,
  dailyLimitPerAccount: 20,
};

export const DEFAULT_CONFIG: HarnessConfig = {
  monthlyCapUsd: 0,
  currency: "USD",
  warnAtPercent: 80,
  apiEnabled: false,
  subscriptionEnabled: true,
  subscriptionModels: ["chatgpt", "claude"],
  hold: false,
  requireApprovalFor: ["publish", "send", "merge", "deploy"],
  browser: { ...DEFAULT_BROWSER_CONFIG },
  projects: { ...DEFAULT_PROJECTS_CONFIG },
  tenants: { ...DEFAULT_TENANTS_CONFIG },
};

function parseSimpleYaml(text: string): HarnessConfig {
  const config: HarnessConfig = { ...DEFAULT_CONFIG, browser: { ...DEFAULT_BROWSER_CONFIG }, projects: { ...DEFAULT_PROJECTS_CONFIG }, tenants: { ...DEFAULT_TENANTS_CONFIG } };
  const lines = text.split(/\r?\n/);
  let section = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t") && line.endsWith(":")) {
      section = line.slice(0, -1).trim();
      continue;
    }
    const parts = line.split(":");
    if (parts.length < 2) {
      continue;
    }
    const key = parts[0].trim();
    const value = parts.slice(1).join(":").trim();
    if (section === "budget" && key === "monthly_cap_usd") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        config.monthlyCapUsd = n;
      }
    }
    if (section === "budget" && key === "currency") {
      config.currency = value || "USD";
    }
    if (section === "budget" && key === "warn_at_percent") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0 && n <= 100) {
        config.warnAtPercent = n;
      }
    }
    if (section === "api" && key === "enabled") {
      config.apiEnabled = value === "true";
    }
    if (section === "subscription" && key === "enabled") {
      config.subscriptionEnabled = value === "true";
    }
    if (section === "subscription" && key === "models") {
      config.subscriptionModels = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    if (section === "policy" && key === "hold") {
      config.hold = value === "true";
    }
    if (section === "policy" && key === "require_approval_for") {
      config.requireApprovalFor = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    if (section === "projects" && key === "max_projects") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 100) {
        config.projects.maxProjects = n;
      }
    }
    if (section === "tenants" && key === "default") {
      if (value) {
        config.tenants.defaultTenant = value;
      }
    }
    if (section === "tenants" && key === "max_tenants") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 50) {
        config.tenants.maxTenants = n;
      }
    }
    if (section === "browser" && key === "enabled") {
      config.browser.enabled = value === "true";
    }
    if (section === "browser" && key === "headless") {
      config.browser.headless = value === "true";
    }
    if (section === "browser" && key === "profile_root") {
      config.browser.profileRoot = value || "./profiles";
    }
    if (section === "browser" && key === "max_accounts") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 10) {
        config.browser.maxAccounts = n;
      }
    }
    if (section === "browser" && key === "pacing_ms") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        config.browser.pacingMs = n;
      }
    }
    if (section === "browser" && key === "daily_limit_per_account") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) {
        config.browser.dailyLimitPerAccount = n;
      }
    }
  }
  return config;
}

export function loadConfig(rootDir?: string): HarnessConfig {
  const base = rootDir || path.resolve(__dirname, "..");
  const configPath = path.join(base, "config.yaml");
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    return parseSimpleYaml(text);
  } catch {
    // Fail closed. If config cannot be read, return the safest defaults.
    return { ...DEFAULT_CONFIG };
  }
}

export function configPathFor(rootDir?: string): string {
  const base = rootDir || path.resolve(__dirname, "..");
  return path.join(base, "config.yaml");
}

// Write the whole config back to config.yaml. Used by tenant-use, setup,
// and migration to record the default tenant. Never writes a credential:
// this file holds settings only, and keys only ever come from environment
// variables. Unknown settings in an existing file are not preserved, so
// this is only called with a config that was loaded through loadConfig.
export function saveConfig(config: HarnessConfig, rootDir?: string): string {
  const base = rootDir || path.resolve(__dirname, "..");
  const lines: string[] = [
    "# TrustyMUSE Harness config. Written by the harness itself.",
    "# Do not put any API key in this file. Keys only come from environment variables.",
    "# Monthly budget cap default is 0. With 0, every paid API call is blocked.",
    "",
    "budget:",
    `  monthly_cap_usd: ${config.monthlyCapUsd}`,
    `  currency: ${config.currency}`,
    `  warn_at_percent: ${config.warnAtPercent}`,
    "",
    "api:",
    `  enabled: ${config.apiEnabled}`,
    "",
    "subscription:",
    `  enabled: ${config.subscriptionEnabled}`,
    `  models: ${config.subscriptionModels.join(", ")}`,
    "",
    "policy:",
    `  hold: ${config.hold}`,
    `  require_approval_for: ${config.requireApprovalFor.join(", ")}`,
    "",
    "browser:",
    `  enabled: ${config.browser.enabled}`,
    `  headless: ${config.browser.headless}`,
    `  profile_root: ${config.browser.profileRoot}`,
    `  max_accounts: ${config.browser.maxAccounts}`,
    `  pacing_ms: ${config.browser.pacingMs}`,
    `  daily_limit_per_account: ${config.browser.dailyLimitPerAccount}`,
    "",
    "projects:",
    `  max_projects: ${config.projects.maxProjects}`,
    "",
    "tenants:",
    `  default: ${config.tenants.defaultTenant}`,
    `  max_tenants: ${config.tenants.maxTenants}`,
    "",
  ];
  const file = path.join(base, "config.yaml");
  fs.writeFileSync(file, lines.join("\n"), "utf-8");
  return file;
}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config";
import { currentMonthKey, loadUsage } from "../budget";
import { readAuditEvents, AuditEvent } from "../audit";
import { TASK_TYPES } from "../router";
import { loadConnectedIds } from "../models/connect";
import { loadAccounts } from "../session/accounts";
import { listProjects } from "../projects/projects";
import { loadTenants, tenantRoot, TenantEntry } from "../tenants/tenants";

// Local analytics collector, V1.8 Phase 1: dry-run preview only.
// This module only reads local state and counts. It builds one JSON
// payload per install, and it never sends anything anywhere. There is
// no sending code in this module at all, and no sending code is built
// in Phase 1. The central service does not exist yet, so enabling is
// refused by the CLI and nothing can leave the machine.
// See docs/V1-8-ANALYTICS-PHASE-1.md and the analytics design at
// ~/workspace/your_files/trustymuse-ai-harness-analytics-design/.

// The allowlist version. Adding a field needs a version bump and a
// fresh consent step, so this number only ever moves up with the docs.
export const PAYLOAD_VERSION = 1;

// The exact payload fields, in order. Nothing else may be sent. The
// validator below refuses any payload whose keys differ from this list.
export const PAYLOAD_FIELDS: string[] = [
  "payload_version",
  "install_id",
  "harness_version",
  "sent_at",
  "tenant_count",
  "connected_models",
  "jobs_by_type",
  "jobs_by_model",
  "packet_jobs",
  "browser_jobs",
  "jobs_ok",
  "jobs_failed",
  "results_validated",
  "error_categories",
  "budget_cap_band",
  "budget_used_band",
  "browser_accounts",
  "browser_connected",
  "projects_active",
  "last_active_day",
  "platform",
  "node_major",
];

export const MAX_PAYLOAD_BYTES = 10240;

export type BudgetCapBand = "0" | "1-10" | "11-100" | "101-plus";
export type BudgetUsedBand = "0" | "1-25" | "26-50" | "51-80" | "81-100";

export interface AnalyticsPayload {
  payload_version: number;
  install_id: string;
  harness_version: string;
  sent_at: string;
  tenant_count: number;
  connected_models: string[];
  jobs_by_type: Record<string, number>;
  jobs_by_model: Record<string, number>;
  packet_jobs: number;
  browser_jobs: number;
  jobs_ok: number;
  jobs_failed: number;
  results_validated: number;
  error_categories: Record<string, number>;
  budget_cap_band: BudgetCapBand;
  budget_used_band: BudgetUsedBand;
  browser_accounts: number;
  browser_connected: number;
  projects_active: number;
  last_active_day: string | null;
  platform: "linux" | "darwin" | "win32";
  node_major: number;
}

// Job events: a packet built, or a browser job finished. Only these two
// event names count as jobs. Blocked attempts are counted separately as
// failed jobs, see FAILED_JOB_EVENTS below.
const JOB_EVENTS = new Set(["packet_generated", "browser_job_done"]);

// Job attempts that can end blocked or failed. A blocked packet or a
// blocked browser attempt is a job that did not run, so it counts under
// jobs_failed. API checks and model admin actions are not jobs, so their
// blocked events are not counted here.
const FAILED_JOB_EVENTS = new Set([
  "packet_generated",
  "browser_job_done",
  "packet_blocked_model",
  "packet_blocked_project_scope",
  "browser_blocked_not_connected",
  "browser_blocked_packet_only",
  "browser_blocked_project_scope",
  "browser_blocked_disabled",
]);

// Error categories, from the design. The mapping uses the event name
// only. The collector never reads the detail field of an audit event,
// because detail can hold a task title, a file path, or a file name.
// Two design categories have no event name yet in V1.8, so they stay
// empty here: hold_blocked (no audit event name marks a HOLD refusal
// apart from other refusals) and browser_challenge (no audit event name
// marks a challenge pause). They will count once those event names
// exist. browser_connect_blocked is mapped to browser_login_failed
// because the common cause is a profile that is not logged in; a
// challenge during connect lands in the same bucket until a distinct
// event name exists.
function categorizeError(event: AuditEvent): string | null {
  // Two categories use results that are not blocked or failed, so they
  // are checked before the blocked-or-failed gate below.
  if (event.event === "packet_result_validated") {
    return event.result === "invalid" ? "validation_failed" : null;
  }
  if (event.event === "browser_job_done") {
    return event.result === "failed" ? "browser_driver_error" : null;
  }
  if (event.result !== "blocked" && event.result !== "failed") {
    return null;
  }
  switch (event.event) {
    case "packet_blocked_model":
    case "browser_blocked_not_connected":
    case "browser_blocked_packet_only":
      return "model_blocked";
    case "packet_blocked_project_scope":
    case "browser_blocked_project_scope":
      return "project_scope_blocked";
    case "api_call_blocked":
      return "budget_blocked";
    case "browser_connect_blocked":
      return "browser_login_failed";
    default:
      return "unknown";
  }
}

export function capBand(capUsd: number): BudgetCapBand {
  if (!(capUsd > 0)) {
    return "0";
  }
  if (capUsd <= 10) {
    return "1-10";
  }
  if (capUsd <= 100) {
    return "11-100";
  }
  return "101-plus";
}

export function usedBand(percentUsed: number): BudgetUsedBand {
  if (!(percentUsed > 0)) {
    return "0";
  }
  if (percentUsed <= 25) {
    return "1-25";
  }
  if (percentUsed <= 50) {
    return "26-50";
  }
  if (percentUsed <= 80) {
    return "51-80";
  }
  return "81-100";
}

export interface AnalyticsState {
  install_id: string;
  created_at: string;
  analytics_enabled: boolean;
  payload_version: number;
  last_preview_at: string | null;
}

export function analyticsFilePath(rootDir: string): string {
  return path.join(rootDir, "state", "analytics.json");
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Read the local analytics state file, or null when it does not exist
// or is not valid. This never creates the file and never generates an id.
export function readAnalyticsState(rootDir: string): AnalyticsState | null {
  const file = analyticsFilePath(rootDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Partial<AnalyticsState>;
    if (typeof record.install_id !== "string" || !UUID_V4.test(record.install_id)) {
      return null;
    }
    return {
      install_id: record.install_id,
      created_at: typeof record.created_at === "string" ? record.created_at : "",
      analytics_enabled: record.analytics_enabled === true,
      payload_version: typeof record.payload_version === "number" ? record.payload_version : PAYLOAD_VERSION,
      last_preview_at: typeof record.last_preview_at === "string" ? record.last_preview_at : null,
    };
  } catch {
    return null;
  }
}

function saveAnalyticsState(rootDir: string, state: AnalyticsState): void {
  const dir = path.join(rootDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(analyticsFilePath(rootDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// The install id: one random UUID, made once and stored locally in
// state/analytics.json (gitignored, never committed). It is not an
// identity: it is not a name, an email, or a Muse account. It is only
// a random label so the future service can tell installs apart.
export function getOrCreateInstallId(rootDir: string): string {
  const existing = readAnalyticsState(rootDir);
  if (existing) {
    return existing.install_id;
  }
  const state: AnalyticsState = {
    install_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    analytics_enabled: false,
    payload_version: PAYLOAD_VERSION,
    last_preview_at: null,
  };
  saveAnalyticsState(rootDir, state);
  return state.install_id;
}

// Record that a preview was run, by stamping the local state file.
// This creates the install id on first preview, so the id is stable
// across previews. It sends nothing.
export function recordPreview(rootDir: string, now?: Date): AnalyticsState {
  const id = getOrCreateInstallId(rootDir);
  const state = readAnalyticsState(rootDir) as AnalyticsState;
  state.install_id = id;
  state.last_preview_at = (now || new Date()).toISOString();
  saveAnalyticsState(rootDir, state);
  return state;
}

function readHarnessVersion(rootDir: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string") {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the fallback below.
  }
  return "unknown";
}

function platformFamily(): "linux" | "darwin" | "win32" {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "win32") {
    return "win32";
  }
  return "linux";
}

function nodeMajor(): number {
  const major = Number(process.version.replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 0 ? major : 0;
}

function dayOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

// Refuse any payload whose keys, types, or size break the allowlist.
// The collector builds the payload from the fixed field list, so this
// is a second check, not the only one. An unknown field stops the
// payload here, before it is ever printed or sent.
export function validatePayload(payload: unknown): asserts payload is AnalyticsPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Analytics payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const wanted = [...PAYLOAD_FIELDS].sort();
  if (keys.length !== wanted.length || keys.some((key, i) => key !== wanted[i])) {
    throw new Error("Analytics payload fields do not match the allowlist. Refusing the payload.");
  }
  const isInt = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const isCountMap = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every(isInt);
  };
  if (record.payload_version !== PAYLOAD_VERSION) {
    throw new Error("Analytics payload version is not the current allowlist version. Refusing the payload.");
  }
  if (typeof record.install_id !== "string" || !UUID_V4.test(record.install_id)) {
    throw new Error("Analytics payload install id is not a valid UUID. Refusing the payload.");
  }
  if (typeof record.harness_version !== "string" || !record.harness_version) {
    throw new Error("Analytics payload harness version is missing. Refusing the payload.");
  }
  if (typeof record.sent_at !== "string" || !record.sent_at) {
    throw new Error("Analytics payload sent_at is missing. Refusing the payload.");
  }
  if (!isInt(record.tenant_count)) {
    throw new Error("Analytics payload tenant_count is not a count. Refusing the payload.");
  }
  if (!Array.isArray(record.connected_models) || !record.connected_models.every((m) => typeof m === "string")) {
    throw new Error("Analytics payload connected_models is not a list of model ids. Refusing the payload.");
  }
  if (!isCountMap(record.jobs_by_type)) {
    throw new Error("Analytics payload jobs_by_type is not a count map. Refusing the payload.");
  }
  const byType = record.jobs_by_type as Record<string, number>;
  for (const type of TASK_TYPES) {
    if (typeof byType[type] !== "number") {
      throw new Error("Analytics payload jobs_by_type is missing a task type. Refusing the payload.");
    }
  }
  if (!isCountMap(record.jobs_by_model)) {
    throw new Error("Analytics payload jobs_by_model is not a count map. Refusing the payload.");
  }
  for (const field of ["packet_jobs", "browser_jobs", "jobs_ok", "jobs_failed", "results_validated", "browser_accounts", "browser_connected", "projects_active"]) {
    if (!isInt(record[field])) {
      throw new Error(`Analytics payload ${field} is not a count. Refusing the payload.`);
    }
  }
  if (!isCountMap(record.error_categories)) {
    throw new Error("Analytics payload error_categories is not a count map. Refusing the payload.");
  }
  const capBands = ["0", "1-10", "11-100", "101-plus"];
  const usedBands = ["0", "1-25", "26-50", "51-80", "81-100"];
  if (!capBands.includes(record.budget_cap_band as string)) {
    throw new Error("Analytics payload budget_cap_band is not a known band. Refusing the payload.");
  }
  if (!usedBands.includes(record.budget_used_band as string)) {
    throw new Error("Analytics payload budget_used_band is not a known band. Refusing the payload.");
  }
  if (!(record.last_active_day === null || typeof record.last_active_day === "string")) {
    throw new Error("Analytics payload last_active_day is not a date or null. Refusing the payload.");
  }
  if (!["linux", "darwin", "win32"].includes(record.platform as string)) {
    throw new Error("Analytics payload platform is not a known family. Refusing the payload.");
  }
  if (!isInt(record.node_major)) {
    throw new Error("Analytics payload node_major is not a count. Refusing the payload.");
  }
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    throw new Error("Analytics payload is over the 10 KB size limit. Refusing the payload.");
  }
}

// Build the payload for one install, from local state only. Counts
// cover the last 24 hours, except last_active_day, which is the latest
// day any packet or browser job ran in the whole local audit history.
// The payload holds counts only. It never holds prompt text, result
// text, file contents, project names or paths, account labels, tenant
// names or labels, emails, credentials, or addresses. The collector
// never reads an audit event's detail field, and it never reads a
// project name, an account label, or a tenant display name. Tenants are
// counted, never named: no tenant id or tenant label appears anywhere
// in the payload.
export function buildAnalyticsPayload(rootDir: string, now?: Date): AnalyticsPayload {
  const at = now || new Date();
  const windowStart = at.getTime() - 24 * 60 * 60 * 1000;
  const config = loadConfig(rootDir);
  const tenants = loadTenants(rootDir);
  const month = currentMonthKey(at);

  const jobsByType: Record<string, number> = {};
  for (const type of TASK_TYPES) {
    jobsByType[type] = 0;
  }
  const jobsByModel: Record<string, number> = {};
  const errorCategories: Record<string, number> = {};
  const connectedSet = new Set<string>();
  let packetJobs = 0;
  let browserJobs = 0;
  let jobsOk = 0;
  let jobsFailed = 0;
  let resultsValidated = 0;
  let browserAccounts = 0;
  let browserConnected = 0;
  let projectsActive = 0;
  let lastActiveDay: string | null = null;
  let maxCap = 0;
  let maxPercent = 0;

  for (const tenant of tenants) {
    const ctx = {
      rootDir,
      tenantId: tenant.id,
      tenant,
      stateDir: tenantRoot(rootDir, tenant.id),
      profileRoot: path.join(rootDir, "profiles", tenant.id),
    };
    for (const id of loadConnectedIds(ctx)) {
      connectedSet.add(id);
    }
    const accounts = loadAccounts(rootDir, tenant.id);
    browserAccounts += accounts.length;
    browserConnected += accounts.filter((a) => a.browserConnected === true).length;
    projectsActive += listProjects(rootDir, tenant.id).filter((p) => p.status === "active").length;

    const cap = typeof tenant.monthlyCapUsd === "number" && Number.isFinite(tenant.monthlyCapUsd)
      ? tenant.monthlyCapUsd
      : config.monthlyCapUsd;
    if (cap > maxCap) {
      maxCap = cap;
    }
    const usage = loadUsage(rootDir, tenant.id);
    const used = typeof usage[month] === "number" ? usage[month] : 0;
    const percent = cap > 0 ? (used / cap) * 100 : used > 0 ? 100 : 0;
    if (percent > maxPercent) {
      maxPercent = percent;
    }

    const events = readAuditEvents(rootDir, tenant.id);
    for (const event of events) {
      const day = event.at ? dayOf(event.at) : null;
      if (day && JOB_EVENTS.has(event.event)) {
        if (!lastActiveDay || day > lastActiveDay) {
          lastActiveDay = day;
        }
      }
      const stamp = event.at ? Date.parse(event.at) : NaN;
      if (Number.isNaN(stamp) || stamp < windowStart || stamp > at.getTime()) {
        continue;
      }
      if (JOB_EVENTS.has(event.event)) {
        if (event.event === "packet_generated") {
          packetJobs += 1;
        } else {
          browserJobs += 1;
        }
        if (event.taskType && (TASK_TYPES as string[]).includes(event.taskType)) {
          jobsByType[event.taskType] += 1;
        }
        if (event.model) {
          jobsByModel[event.model] = (jobsByModel[event.model] || 0) + 1;
        }
        if (event.result === "ok") {
          jobsOk += 1;
        }
      }
      if (FAILED_JOB_EVENTS.has(event.event) && (event.result === "blocked" || event.result === "failed")) {
        jobsFailed += 1;
      }
      if (event.event === "packet_result_validated") {
        resultsValidated += 1;
      }
      const category = categorizeError(event);
      if (category) {
        errorCategories[category] = (errorCategories[category] || 0) + 1;
      }
    }
  }

  const payload: AnalyticsPayload = {
    payload_version: PAYLOAD_VERSION,
    install_id: getOrCreateInstallId(rootDir),
    harness_version: readHarnessVersion(rootDir),
    sent_at: at.toISOString(),
    tenant_count: tenants.length,
    connected_models: [...connectedSet].sort(),
    jobs_by_type: jobsByType,
    jobs_by_model: jobsByModel,
    packet_jobs: packetJobs,
    browser_jobs: browserJobs,
    jobs_ok: jobsOk,
    jobs_failed: jobsFailed,
    results_validated: resultsValidated,
    error_categories: errorCategories,
    budget_cap_band: capBand(maxCap),
    budget_used_band: usedBand(maxPercent),
    browser_accounts: browserAccounts,
    browser_connected: browserConnected,
    projects_active: projectsActive,
    last_active_day: lastActiveDay,
    platform: platformFamily(),
    node_major: nodeMajor(),
  };
  validatePayload(payload);
  return payload;
}

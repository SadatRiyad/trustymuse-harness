import { TenantContext } from "../tenants/context";
import { appendAudit, newRunId } from "../audit";
import { assertBrowserAllowed } from "../models/connect";
import { BrowserDriver } from "./browser";
import {
  AccountSource,
  BrowserAccount,
  getAccount,
  loadAccounts,
  recordAccountUse,
  saveAccounts,
} from "./accounts";

// Browser Connect and Disconnect, V1.6.
// A browser connection is a verified fact, never a claim. An account is
// connected only after a driver openProfile call opened its profile and
// found the login there. Disconnecting flips the flag back, records a
// reason, and pauses the account, but never deletes the browser profile
// and never logs the user out of the site: the login stays in the profile
// for a later reconnect. All state lives per tenant in the account
// registry, so one tenant can never see or change another tenant's
// connection state. No login detail is stored anywhere here.

export interface ConnectionStatus {
  accountId: string;
  provider: string;
  label: string;
  source: AccountSource;
  connected: boolean;
  connectedAt: string | null;
  lastVerified: string | null;
  disconnectReason: string | null;
  verifiedAt: string | null;
  verifiedVia: string | null;
  verifiedNote: string | null;
  status: string;
  enabled: boolean;
  dailyCount: number;
}

export function toConnectionStatus(account: BrowserAccount): ConnectionStatus {
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    source: account.source,
    connected: account.browserConnected === true,
    connectedAt: account.browserConnectedAt,
    lastVerified: account.browserLastVerified,
    disconnectReason: account.browserDisconnectReason,
    verifiedAt: account.verifiedAt,
    verifiedVia: account.verifiedVia,
    verifiedNote: account.verifiedNote,
    status: account.status,
    enabled: account.enabled,
    dailyCount: account.dailyCount,
  };
}

// One line per account, for browser-status and session-status. The line
// always says connected or disconnected, so the state is never ambiguous.
// It also says the source, and for a cloud account the verification note,
// so the two logins are never confused.
export function formatConnectionLine(status: ConnectionStatus): string {
  const state = status.connected
    ? `connected, verified ${status.lastVerified || "never"}`
    : `disconnected${status.disconnectReason ? `, ${status.disconnectReason}` : ""}`;
  const verified =
    status.source === "cloud" && status.verifiedVia
      ? `, verified via ${status.verifiedVia}: ${status.verifiedNote || ""}`
      : "";
  return (
    `  ${status.accountId} (${status.provider}, ${status.label}, source ${status.source}, ${state}, ` +
    `status ${status.status}, today ${status.dailyCount} jobs${verified})`
  );
}

export function getConnectionStatus(ctx: TenantContext, accountId: string): ConnectionStatus {
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No state was changed.`,
    );
  }
  return toConnectionStatus(account);
}

export function listConnectionStatuses(ctx: TenantContext): ConnectionStatus[] {
  return loadAccounts(ctx.rootDir, ctx.tenantId).map((account) => toConnectionStatus(account));
}

function saveOne(ctx: TenantContext, updated: BrowserAccount): void {
  const accounts = loadAccounts(ctx.rootDir, ctx.tenantId);
  const index = accounts.findIndex((a) => a.id === updated.id);
  if (index < 0) {
    throw new Error(
      `Account ${updated.id} was not found for tenant ${ctx.tenantId}. No state was changed.`,
    );
  }
  accounts[index] = updated;
  saveAccounts(accounts, ctx.rootDir, ctx.tenantId);
}

// Run-browser gate, shared by the CLI and the tests. A disconnected
// account fails closed here, before any driver is created and before any
// job is queued. The message tells the user to run browser-connect first
// and names packet mode as the fallback.
export function assertBrowserConnected(ctx: TenantContext, accountId: string): BrowserAccount {
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No browser job was started.`,
    );
  }
  if (account.browserConnected !== true) {
    throw new Error(
      `Browser is not connected for account ${accountId}. Run browser-connect --account ${accountId} first to verify the login, or use packet mode. No browser job was started.`,
    );
  }
  return account;
}

// Cloud browser refusal, V2.3. A cloud browser job never runs from the
// CLI, and it never falls back to packet mode: it runs from Muse,
// through the cloud browser where the user is already logged in. The
// Telegram relay or the Muse app chat runs the job itself, reads the
// reply, and audit-logs it with cloud-job-log. This exact text is what
// run-browser and the Telegram /run command print for a cloud account.
export const CLOUD_JOB_REFUSAL =
  "This is a cloud browser account. A cloud browser job never runs from the CLI. " +
  "It runs from Muse, through the cloud browser where you are already logged in: " +
  "the Telegram relay or the Muse app chat runs the job itself, reads the reply, " +
  "and audit-logs it with cloud-job-log. No packet was created, and nothing was sent.";

// Returns the refusal message for a cloud account, or null when the
// account is a profile account or the model does not match. A
// disconnected cloud account gets the verify-first message instead of
// the relay message, so the user is told what is missing.
export function cloudJobRefusal(account: BrowserAccount, model: string): string | null {
  if (account.source !== "cloud") {
    return null;
  }
  if (account.provider !== model) {
    return null;
  }
  if (account.browserConnected !== true) {
    return (
      `Browser is not connected for account ${account.id}. Verify the login first with ` +
      `browser-connect --account ${account.id} --verified-via <browser task id> ` +
      `--verified-note "<what the browser task observed>". No browser job was started.`
    );
  }
  return CLOUD_JOB_REFUSAL;
}

export interface ConnectOptions {
  hold: boolean;
}

// Cloud verification, V2.3. A cloud account is verified by a browser
// task that checked the login in the cloud browser, never by the driver.
// The caller passes the evidence: the browser task id that did the
// check, and the plain-words observation of what it saw. Both are
// stored on the account and in the audit log, so a later reader can
// see exactly what was verified and by which check. No login detail is
// ever stored: the evidence is an observation, never a credential.
export interface CloudVerification {
  verifiedVia: string;
  verifiedNote: string;
}

export function connectCloudBrowser(
  ctx: TenantContext,
  accountId: string,
  verification: CloudVerification,
  options: ConnectOptions,
): BrowserAccount {
  if (options.hold) {
    throw new Error(
      "HOLD is on. Browser connects are blocked until HOLD is lifted by the user. No state was changed.",
    );
  }
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No state was changed.`,
    );
  }
  if (account.source !== "cloud") {
    throw new Error(
      `Account ${accountId} is a profile account, not a cloud account. Cloud verification only applies to cloud accounts. Verify a profile account with browser-connect and the driver. No state was changed.`,
    );
  }
  const verifiedVia = (verification.verifiedVia || "").trim();
  const verifiedNote = (verification.verifiedNote || "").trim();
  if (!verifiedVia || !verifiedNote) {
    throw new Error(
      "A cloud connect needs verification evidence: --verified-via <browser task id> and --verified-note \"<what the browser task observed>\". The login must be verified by a browser task first. No state was changed.",
    );
  }
  if (verifiedVia.length > 120) {
    throw new Error("The --verified-via value is too long. It must be a browser task id, at most 120 characters. No state was changed.");
  }
  if (verifiedNote.length > 300) {
    throw new Error("The --verified-note value is too long. Keep the observation to 300 characters. No state was changed.");
  }
  const now = new Date().toISOString();
  account.browserConnected = true;
  account.browserConnectedAt = now;
  account.browserLastVerified = now;
  account.verifiedAt = now;
  account.verifiedVia = verifiedVia;
  account.verifiedNote = verifiedNote;
  account.browserDisconnectReason = null;
  account.status = "active";
  account.enabled = true;
  saveOne(ctx, account);
  return account;
}

// Record one cloud browser job in the audit log, V2.3. The job itself
// runs from Muse through the cloud browser, never from the CLI. This
// command only records that it ran, with the account, the model, a
// short task description, and the result. The task text is never the
// full prompt: keep it to a short description. The account use count
// goes up by one, the same as a profile browser job.
export interface CloudJobLog {
  result: string;
  task: string;
  taskType?: string;
  detail?: string;
}

export function recordCloudJob(
  ctx: TenantContext,
  accountId: string,
  model: string,
  log: CloudJobLog,
): BrowserAccount {
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No job was logged.`,
    );
  }
  if (account.source !== "cloud") {
    throw new Error(
      `Account ${accountId} is not a cloud browser account. Cloud jobs are only logged for cloud accounts. No job was logged.`,
    );
  }
  if (account.browserConnected !== true) {
    throw new Error(
      `Browser is not connected for account ${accountId}. Verify the login first with browser-connect and verification evidence. No job was logged.`,
    );
  }
  if (account.provider !== model) {
    throw new Error(
      `Account ${accountId} is a ${account.provider} account, but model is ${model}. Use the matching model. No job was logged.`,
    );
  }
  if (log.result !== "ok" && log.result !== "failed") {
    throw new Error("Result must be ok or failed. No job was logged.");
  }
  const task = (log.task || "").trim();
  if (!task) {
    throw new Error("Task must not be empty. Give a short description of the job. No job was logged.");
  }
  if (task.length > 200) {
    throw new Error("Task is too long. Keep the short description to 200 characters. No job was logged.");
  }
  const detail = (log.detail || "").trim().slice(0, 300);
  appendAudit(
    {
      at: new Date().toISOString(),
      runId: newRunId(),
      event: "cloud_browser_job",
      model,
      taskType: (log.taskType || "general").trim() || "general",
      detail: `account:${account.id} task:${task}${detail ? ` ${detail}` : ""}`,
      result: log.result,
    },
    ctx.rootDir,
    ctx.tenantId,
  );
  recordAccountUse(account);
  saveOne(ctx, account);
  return account;
}

// Connect one browser account for this tenant only. The driver must
// verify the login by opening the profile: if it reports not logged in,
// a login page, or a challenge, the account stays disconnected and the
// exact reason is recorded. Connecting while HOLD is on is refused.
// The driver is always closed again, so a connect never leaves a
// browser running.
export async function connectBrowser(
  ctx: TenantContext,
  accountId: string,
  driver: BrowserDriver,
  options: ConnectOptions,
): Promise<BrowserAccount> {
  if (options.hold) {
    throw new Error(
      "HOLD is on. Browser connects are blocked until HOLD is lifted by the user. No state was changed.",
    );
  }
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No state was changed.`,
    );
  }
  // A cloud account has no local profile, so the driver must never open
  // it. Cloud verification is evidence from a browser task, not a driver
  // check. This guard runs before the driver is even created.
  if (account.source === "cloud") {
    throw new Error(
      `Account ${accountId} is a cloud browser account. The driver never opens a cloud account. Verify it with browser-connect --account ${accountId} --verified-via <browser task id> --verified-note "<what the browser task observed>" instead. No state was changed.`,
    );
  }
  // Only models with a wired driver can be verified this way. Every
  // other model is packet-only, and the message says so.
  assertBrowserAllowed(account.provider);
  const now = new Date().toISOString();
  try {
    await driver.openProfile(account);
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).slice(0, 300);
    account.browserConnected = false;
    account.browserDisconnectReason = `Connect failed: ${reason}`;
    saveOne(ctx, account);
    throw error;
  } finally {
    try {
      await driver.close();
    } catch {
      // Closing must never mask the verification result.
    }
  }
  account.browserConnected = true;
  account.browserConnectedAt = now;
  account.browserLastVerified = now;
  account.browserDisconnectReason = null;
  account.status = "active";
  account.enabled = true;
  saveOne(ctx, account);
  return account;
}

// Disconnect one browser account for this tenant only. Always allowed,
// even with HOLD on, because stopping use must never be blocked. The
// account is marked disconnected with a reason and its queue is paused
// (status paused, so canRun refuses later jobs). The profile directory
// is left untouched and the site login stays in it for a later reconnect.
export function disconnectBrowser(
  ctx: TenantContext,
  accountId: string,
  reason?: string,
): BrowserAccount {
  const account = getAccount(accountId, ctx.rootDir, ctx.tenantId);
  if (!account) {
    throw new Error(
      `Account ${accountId} was not found for tenant ${ctx.tenantId}. Use account-list to see existing accounts. No state was changed.`,
    );
  }
  const cleanReason = (reason || "").trim() || "Disconnected by the user.";
  account.browserConnected = false;
  account.browserDisconnectReason = cleanReason.slice(0, 300);
  account.status = "paused";
  saveOne(ctx, account);
  return account;
}

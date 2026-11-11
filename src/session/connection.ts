import { TenantContext } from "../tenants/context";
import { assertBrowserAllowed } from "../models/connect";
import { BrowserDriver } from "./browser";
import {
  BrowserAccount,
  getAccount,
  loadAccounts,
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
  connected: boolean;
  connectedAt: string | null;
  lastVerified: string | null;
  disconnectReason: string | null;
  status: string;
  enabled: boolean;
  dailyCount: number;
}

export function toConnectionStatus(account: BrowserAccount): ConnectionStatus {
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    connected: account.browserConnected === true,
    connectedAt: account.browserConnectedAt,
    lastVerified: account.browserLastVerified,
    disconnectReason: account.browserDisconnectReason,
    status: account.status,
    enabled: account.enabled,
    dailyCount: account.dailyCount,
  };
}

// One line per account, for browser-status and session-status. The line
// always says connected or disconnected, so the state is never ambiguous.
export function formatConnectionLine(status: ConnectionStatus): string {
  const state = status.connected
    ? `connected, verified ${status.lastVerified || "never"}`
    : `disconnected${status.disconnectReason ? `, ${status.disconnectReason}` : ""}`;
  return (
    `  ${status.accountId} (${status.provider}, ${status.label}, ${state}, ` +
    `status ${status.status}, today ${status.dailyCount} jobs)`
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

export interface ConnectOptions {
  hold: boolean;
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

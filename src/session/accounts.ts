import * as fs from "fs";
import * as path from "path";
import { stateDir } from "../audit";

// Account registry for Browser Session Mode, V1.1.
// One account is one logged in normal ChatGPT or Claude account, used through
// the user's own browser profile. The harness never sees a password and never
// stores a token. There is no password field and no token field on this type
// on purpose. Login is done once by the user, in their own browser, in that
// profile. The harness only opens the already logged in profile.

export type BrowserProvider = "chatgpt" | "claude";
export type AccountStatus = "active" | "paused" | "challenge" | "disabled";

export interface BrowserAccount {
  id: string;
  provider: BrowserProvider;
  label: string;
  profileDir: string;
  status: AccountStatus;
  lastUsed: string | null;
  dailyCount: number;
  dailyDate: string | null;
  enabled: boolean;
  createdAt: string;
  // Browser connection state, V1.6. browserConnected is true only after
  // a driver openProfile call verified the login in this profile. It is
  // never claimed without that check. Disconnecting flips this flag and
  // records a reason, but never deletes the profile and never logs the
  // user out of the site, so the login stays for a later reconnect.
  browserConnected: boolean;
  browserConnectedAt: string | null;
  browserLastVerified: string | null;
  browserDisconnectReason: string | null;
}

export function accountsFilePath(rootDir?: string, tenantId?: string): string {
  return path.join(stateDir(rootDir, tenantId), "accounts.json");
}

// Browser profiles are per tenant in V1.4: profiles/<tenantId>/<provider>-<id>.
// Without a tenant id the legacy flat layout is kept, so older callers work.
export function tenantProfileRoot(profileRoot: string, tenantId?: string): string {
  const root = profileRoot.replace(/\/$/, "");
  return tenantId ? `${root}/${tenantId}` : root;
}

export function todayKey(now?: Date): string {
  const d = now || new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

function isValidProvider(value: string): value is BrowserProvider {
  return value === "chatgpt" || value === "claude";
}

// Fail closed if anyone tries to smuggle a secret into an account record.
// This function is called on every load and every save.
export function assertNoSecrets(record: unknown): void {
  if (!record || typeof record !== "object") {
    return;
  }
  const forbidden = ["password", "token", "secret", "apiKey", "api_key", "sessionToken", "cookie"];
  for (const key of Object.keys(record as Record<string, unknown>)) {
    if (forbidden.includes(key)) {
      throw new Error(`Account record must never contain ${key}. No password or token is stored.`);
    }
  }
}

export function loadAccounts(rootDir?: string, tenantId?: string): BrowserAccount[] {
  const file = accountsFilePath(rootDir, tenantId);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const accounts = parsed as BrowserAccount[];
    for (const account of accounts) {
      assertNoSecrets(account);
      // Backfill the V1.6 connection fields on records written before
      // V1.6. An old record has no verification on file, so it is
      // disconnected until browser-connect verifies it.
      if (typeof account.browserConnected !== "boolean") {
        account.browserConnected = false;
      }
      if (typeof account.browserConnectedAt !== "string") {
        account.browserConnectedAt = null;
      }
      if (typeof account.browserLastVerified !== "string") {
        account.browserLastVerified = null;
      }
      if (typeof account.browserDisconnectReason !== "string") {
        account.browserDisconnectReason = null;
      }
    }
    return accounts;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must never contain")) {
      throw error;
    }
    return [];
  }
}

export function saveAccounts(accounts: BrowserAccount[], rootDir?: string, tenantId?: string): void {
  for (const account of accounts) {
    assertNoSecrets(account);
  }
  const dir = stateDir(rootDir, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(accountsFilePath(rootDir, tenantId), JSON.stringify(accounts, null, 2) + "\n", "utf-8");
}

export function profileDirFor(provider: BrowserProvider, id: string, profileRoot: string): string {
  const root = profileRoot.replace(/\/$/, "");
  return `${root}/${provider}-${id}`;
}

export function addAccount(
  input: { provider: string; id: string; label: string },
  options: { rootDir?: string; profileRoot?: string; maxAccounts?: number; tenantId?: string } = {},
): BrowserAccount {
  const maxAccounts = options.maxAccounts ?? 3;
  const profileRoot = tenantProfileRoot(options.profileRoot ?? "./profiles", options.tenantId);
  if (!isValidProvider(input.provider)) {
    throw new Error("Provider must be chatgpt or claude.");
  }
  if (!isValidId(input.id)) {
    throw new Error("Account id must be lowercase letters, digits, or short hyphens, for example main or work-1.");
  }
  const label = input.label.trim();
  if (!label) {
    throw new Error("Account label must not be empty.");
  }
  const accounts = loadAccounts(options.rootDir, options.tenantId);
  if (accounts.length >= maxAccounts) {
    throw new Error(`Account limit reached. V1.1 allows at most ${maxAccounts} browser accounts.`);
  }
  if (accounts.some((a) => a.id === input.id)) {
    throw new Error(`Account id ${input.id} already exists. Use account-list to see existing accounts.`);
  }
  const account: BrowserAccount = {
    id: input.id,
    provider: input.provider,
    label,
    profileDir: profileDirFor(input.provider, input.id, profileRoot),
    status: "active",
    lastUsed: null,
    dailyCount: 0,
    dailyDate: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    browserConnected: false,
    browserConnectedAt: null,
    browserLastVerified: null,
    browserDisconnectReason: null,
  };
  assertNoSecrets(account);
  accounts.push(account);
  saveAccounts(accounts, options.rootDir, options.tenantId);
  return account;
}

export function getAccount(id: string, rootDir?: string, tenantId?: string): BrowserAccount | null {
  const accounts = loadAccounts(rootDir, tenantId);
  return accounts.find((a) => a.id === id) || null;
}

export function setAccountStatus(id: string, status: AccountStatus, rootDir?: string, tenantId?: string): BrowserAccount {
  const accounts = loadAccounts(rootDir, tenantId);
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    throw new Error(`Account ${id} was not found. Use account-list to see existing accounts.`);
  }
  account.status = status;
  if (status === "disabled") {
    account.enabled = false;
  }
  if (status === "active") {
    account.enabled = true;
  }
  saveAccounts(accounts, rootDir, tenantId);
  return account;
}

export function setAccountEnabled(id: string, enabled: boolean, rootDir?: string, tenantId?: string): BrowserAccount {
  const accounts = loadAccounts(rootDir, tenantId);
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    throw new Error(`Account ${id} was not found. Use account-list to see existing accounts.`);
  }
  account.enabled = enabled;
  if (!enabled) {
    account.status = "disabled";
  } else if (account.status === "disabled") {
    account.status = "active";
  }
  saveAccounts(accounts, rootDir, tenantId);
  return account;
}

// Reset the daily count when the day changes, then record one use.
// The caller saves the account list after this call.
export function recordAccountUse(account: BrowserAccount, now?: Date): void {
  const today = todayKey(now);
  if (account.dailyDate !== today) {
    account.dailyDate = today;
    account.dailyCount = 0;
  }
  account.dailyCount += 1;
  account.lastUsed = (now || new Date()).toISOString();
}

export function dailyCountToday(account: BrowserAccount, now?: Date): number {
  if (account.dailyDate !== todayKey(now)) {
    return 0;
  }
  return account.dailyCount;
}

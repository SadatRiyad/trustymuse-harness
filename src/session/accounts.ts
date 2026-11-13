import * as fs from "fs";
import * as path from "path";
import { stateDir } from "../audit";
import { getSubscriptionModel } from "../registry";

// Account registry for Browser Session Mode, V1.1.
// One account is one logged in normal ChatGPT or Claude account, used through
// the user's own browser profile. The harness never sees a password and never
// stores a token. There is no password field and no token field on this type
// on purpose. Login is done once by the user, in their own browser, in that
// profile. The harness only opens the already logged in profile.
//
// V2.3 adds a second account source, "cloud". A cloud account is a model
// the user is already logged in to in the cloud browser (Muse's browser,
// default profile), not in a harness Playwright profile. The cloud browser
// login does not carry over to a harness profile, and the harness profile
// login does not carry over to the cloud browser: they are two separate
// logins, and the source field says which one the account uses. A cloud
// account has no local profile dir, and its login is verified by a browser
// task that checks the cloud browser, never by the driver. The driver only
// ever opens profile accounts. A cloud job never runs from the CLI: it
// runs from Muse, through the cloud browser, and is audit-logged with
// cloud-job-log. Packet mode is the last resort, for a model with no
// connected account anywhere.

export type BrowserProvider = "chatgpt" | "claude";
export type AccountSource = "profile" | "cloud";
// Every subscription model id may be a cloud account, because the cloud
// browser can reach any chat app the user is logged in to. A profile
// account is still chatgpt or claude only, because the Playwright driver
// is wired only for those two.
export type AccountProvider =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "grok"
  | "deepseek"
  | "perplexity"
  | "meta-ai"
  | "copilot"
  | "mistral";
export type AccountStatus = "active" | "paused" | "challenge" | "disabled";

export interface BrowserAccount {
  id: string;
  provider: AccountProvider;
  label: string;
  profileDir: string;
  // Account source, V2.3. "profile" is the existing Playwright
  // persistent-context account. "cloud" is the cloud browser account.
  // Old records without this field are treated as "profile".
  source: AccountSource;
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
  // Cloud verification, V2.3. Set only by a cloud connect, from the
  // evidence a browser task observed in the cloud browser. verifiedVia
  // is the browser task id that checked the login. verifiedNote is the
  // plain-words observation, for example "chatgpt.com shows the prompt
  // box and the business mail account, Free plan". No login detail is
  // ever stored here: no password, no token, no cookie, no session.
  verifiedAt: string | null;
  verifiedVia: string | null;
  verifiedNote: string | null;
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
      // Backfill the V2.3 source field on records written before V2.3.
      // Every old record was a profile account, so it stays "profile".
      // Cloud verification fields start empty.
      if (account.source !== "profile" && account.source !== "cloud") {
        account.source = "profile";
      }
      if (typeof account.verifiedAt !== "string") {
        account.verifiedAt = null;
      }
      if (typeof account.verifiedVia !== "string") {
        account.verifiedVia = null;
      }
      if (typeof account.verifiedNote !== "string") {
        account.verifiedNote = null;
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
  input: { provider: string; id: string; label: string; source?: string },
  options: { rootDir?: string; profileRoot?: string; maxAccounts?: number; tenantId?: string } = {},
): BrowserAccount {
  const maxAccounts = options.maxAccounts ?? 3;
  const profileRoot = tenantProfileRoot(options.profileRoot ?? "./profiles", options.tenantId);
  // Source defaults to "profile", so nothing existing changes meaning.
  const source = input.source === undefined || input.source === "" ? "profile" : input.source;
  if (source !== "profile" && source !== "cloud") {
    throw new Error("Account source must be profile or cloud.");
  }
  if (source === "profile") {
    // A profile account needs a wired driver, so only chatgpt and
    // claude are allowed here.
    if (!isValidProvider(input.provider)) {
      throw new Error("Provider must be chatgpt or claude for a profile account. A cloud account can use any subscription model.");
    }
  } else {
    // A cloud account runs through the cloud browser, which can reach
    // any chat app the user is logged in to, so any subscription model
    // is allowed. API models are never allowed: they have no chat app.
    if (!getSubscriptionModel(input.provider)) {
      throw new Error("Provider must be a known subscription model for a cloud account: chatgpt, claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral.");
    }
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
    provider: input.provider as AccountProvider,
    label,
    // A cloud account has no local profile: the login lives in the
    // cloud browser, not in a harness profile dir.
    profileDir: source === "cloud" ? "" : profileDirFor(input.provider as BrowserProvider, input.id, profileRoot),
    source,
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
    verifiedAt: null,
    verifiedVia: null,
    verifiedNote: null,
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

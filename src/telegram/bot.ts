// Telegram Bot control, V2.2. The harness is controlled from Telegram
// through a bot the user creates with @BotFather, and Telegram is also
// a Muse channel: plain text that is not a command is a chat message,
// queued in the inbox for a scheduled relay job run by Muse, which
// answers it and writes the reply to the outbox for the bot to deliver.
// The bot answers read-only commands for any allowlisted user, and runs
// the write commands the harness itself offers: project add, remove,
// and pause, model connect and disconnect, draft task and packet
// creation, HOLD on and off, and one browser job at a time on a
// connected account with /run. /do parses a plain-language instruction
// into a packet, a project-scoped task, or a plan-then-audit pipeline.
// The bot never deploys, publishes, merges, or sends anything: /do
// with deploy words stops at the audit and reports the verdict, and
// the deploy itself needs the user's approval in the Muse app. See
// docs/V2-2-TELEGRAM-MUSE-CHANNEL.md.
//
// Safety rules, in order:
// - The bot token comes from TELEGRAM_BOT_TOKEN first, then from the
//   file token in gitignored state/telegram.json, so the TrustyHarness
//   panel can later write it there from a box. It is never logged,
//   never printed, and never included in an audit event. Starting the
//   bot without a token refuses.
// - Only Telegram user ids on the allowlist in gitignored
//   state/telegram.json get any reply. A non-allowlisted id gets no
//   reply at all. The attempt is audit logged, and the bot process
//   prints the id once per minute so the owner can allowlist it.
// - HOLD blocks all Telegram writes, including packet creation and
//   browser jobs. Turning HOLD on is always allowed. Turning it off
//   needs a YES confirmation in the next message.
// - Budget cap 0 still blocks paid API calls. The bot never places an
//   API call and never spends budget.
// - Per-user rate limit: 20 commands per minute, then a polite
//   slow-down reply.
// - Every handled Telegram command writes exactly one audit event per
//   tenant, with the numeric Telegram user id only, never a username or
//   a name unless the owner gave that user a label in the allowlist.
//   Browser job lifecycle events are not written to the audit log from
//   Telegram: the single command event is the record.
// - Telegram message text is capped at 4000 characters, under the
//   platform limit of 4096.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { appendAudit, newRunId, readAuditEvents } from "../audit";
import { BudgetTracker } from "../budget";
import { loadConfig, saveConfig, HarnessConfig } from "../config";
import { checkPolicy } from "../policy";
import { getModel, getSubscriptionModel, listModels } from "../registry";
import { routeTask, TASK_TYPES } from "../router";
import { buildPacketContent, generatePacket, PacketModel, validatePacketResult } from "../packet";
import {
  assertBrowserAllowed,
  assertPacketAllowed,
  CONNECTED_LEGEND,
  connectModel,
  disconnectModel,
  isModelConnected,
  listConnectedModels,
} from "../models/connect";
import { buildProjectContext } from "../projects/context";
import {
  addProject,
  assertProjectWriteAllowed,
  listProjects,
  markProjectUsed,
  pauseProject,
  removeProject,
  scopeJobToProject,
} from "../projects/projects";
import { getAccount, loadAccounts, saveAccounts } from "../session/accounts";
import type { BrowserAccount } from "../session/accounts";
import { MockBrowserDriver, PlaywrightBrowserDriver } from "../session/browser";
import type { BrowserDriver } from "../session/browser";
import { cloudJobRefusal, formatConnectionLine, listConnectionStatuses, assertBrowserConnected } from "../session/connection";
import { BrowserQueue } from "../session/queue";
import { tenantCapUsd, TenantContext } from "../tenants/context";
import {
  buildAnalyticsPayload,
  PAYLOAD_VERSION,
  readAnalyticsState,
  recordPreview,
} from "../analytics/collector";

export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
export const TELEGRAM_MAX_COMMANDS_PER_MINUTE = 20;
export const TELEGRAM_RATE_WINDOW_MS = 60 * 1000;
export const TELEGRAM_MAX_MESSAGE_CHARS = 4000;
export const TELEGRAM_API_BASE = "https://api.telegram.org";
// Long-poll timing, V2.1. The server holds a getUpdates request for at
// most the poll timeout. The client abort must be clearly longer than
// that hold: the live bot showed repeated client TimeoutErrors followed
// by HTTP 409, which means the client aborted while Telegram still
// held the request and the retry overlapped it on Telegram's side.
// Poll timeout 25 seconds, abort 30 seconds after that, so an abort
// only ever fires on a genuine network stall.
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
export const TELEGRAM_POLL_ABORT_EXTRA_MS = 30 * 1000;
export const TELEGRAM_POLL_RETRY_MS = 5000;
// A 409 means another getUpdates request is still open on Telegram's
// side. Back off longer instead of hammering the same short retry.
export const TELEGRAM_POLL_CONFLICT_BACKOFF_MS = 15000;

// Chat mode, V2.2. Plain text is a chat message, not a command. The
// bot queues it in the inbox and sends one fixed acknowledgement at
// once. The relay answers later, so replies take about 2 to 4 minutes.
// The chat rate limit is separate from the command rate limit: at most
// 10 chat messages per user per 10 minutes. The 11th gets one polite
// slow-down reply, and further messages in the window are dropped
// silently until the window passes.
export const TELEGRAM_CHAT_ACK = "Got it. Muse will reply here.";
export const TELEGRAM_CHAT_SLOWDOWN =
  "You are sending messages faster than I can answer them. I will catch up, please wait a little.";
export const TELEGRAM_CHAT_MAX_PER_WINDOW = 10;
export const TELEGRAM_CHAT_WINDOW_MS = 10 * 60 * 1000;
// The thread file keeps the last 20 messages per user. Older entries
// are folded into the summary by the relay and dropped.
export const TELEGRAM_THREAD_MAX_MESSAGES = 20;
// An outbox line that fails to send is retried on the next poll cycle.
// After three failed attempts it is marked failed and never retried.
export const TELEGRAM_OUTBOX_MAX_ATTEMPTS = 3;

// The token comes from TELEGRAM_BOT_TOKEN first, then from the file
// token in gitignored state/telegram.json, so the TrustyHarness panel
// can later write it there from a box. It is never logged, never
// printed, and never included in an audit event. Starting the bot
// without a token in either place refuses.
export function requireTelegramToken(env: NodeJS.ProcessEnv = process.env, rootDir?: string): string {
  const fromEnv = (env[TELEGRAM_TOKEN_ENV] || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (rootDir) {
    const fromFile = loadTelegramState(rootDir).botToken;
    if (fromFile) {
      return fromFile;
    }
  }
  throw new Error(
    "No Telegram bot token found. Create a bot with @BotFather in Telegram, copy the token it gives you, then set TELEGRAM_BOT_TOKEN in the environment, or save the token from the TrustyHarness panel box, before starting the bot. Never put the token in config.yaml or in chat.",
  );
}

// Which place the token came from, without ever returning the token
// itself in a status reply. Used by telegram-token-status.
export function getTelegramTokenSource(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { set: boolean; source: "env" | "file" | "none" } {
  if ((env[TELEGRAM_TOKEN_ENV] || "").trim()) {
    return { set: true, source: "env" };
  }
  if (loadTelegramState(rootDir).botToken) {
    return { set: true, source: "file" };
  }
  return { set: false, source: "none" };
}

// ---------------------------------------------------------------------------
// Telegram API types and client. The client uses the Node built-in fetch
// only. No new dependency. The token is part of the request URL, so it
// is never written to any log: error messages name the method and the
// HTTP status only, never the URL.
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApi {
  getUpdates(offset: number | null, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

export class TelegramHttpApi implements TelegramApi {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async call(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Telegram API call failed for ${method}: HTTP ${response.status}.`);
    }
    const parsed = (await response.json()) as TelegramApiResponse;
    if (!parsed.ok) {
      throw new Error(`Telegram API call failed for ${method}: ${parsed.description || "not ok"}.`);
    }
    return parsed.result;
  }

  async getUpdates(offset: number | null, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = { timeout: timeoutSeconds, allowed_updates: ["message"] };
    if (offset !== null) {
      body.offset = offset;
    }
    // The abort is 30 seconds past the server long-poll hold, so the
    // client never aborts while Telegram still holds the request. An
    // early abort plus a fast retry is what produced HTTP 409 overlaps
    // on the live bot before V2.1.
    const result = await this.call("getUpdates", body, timeoutSeconds * 1000 + TELEGRAM_POLL_ABORT_EXTRA_MS);
    if (!Array.isArray(result)) {
      throw new Error("Telegram API call failed for getUpdates: the result was not a list.");
    }
    return result as TelegramUpdate[];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text }, 15000);
  }
}

// ---------------------------------------------------------------------------
// Allowlist and file token. Install-wide, in gitignored
// state/telegram.json. The file holds the allowlist of numeric user ids
// with owner-given labels, and optionally the bot token under botToken,
// so the TrustyHarness panel can write it from a box. No username, no
// name from Telegram, no other credential of any kind. The file is
// rejected on load when it holds a secret-like field other than the
// bot token itself, the same rule the account, tenant, and project
// registries use. The token value is never returned by any status
// function: callers only learn whether one is set, and where from.
// ---------------------------------------------------------------------------

export interface TelegramAllowEntry {
  id: number;
  label: string;
  addedAt: string;
}

export interface TelegramFileState {
  users: TelegramAllowEntry[];
  botToken: string | null;
}

export function telegramFilePath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram.json");
}

const SECRET_FIELD_NAMES = new Set(["password", "token", "secret", "apikey", "sessiontoken", "cookie"]);

// The file token lives under the key botToken on purpose: the guard
// below matches whole key names, so "bottoken" is not the "token" key,
// and the loader strips botToken out before the guard runs in any case.
const FILE_TOKEN_KEY = "botToken";

function assertValidFileToken(token: unknown): string | null {
  if (token === undefined || token === null) {
    return null;
  }
  if (typeof token !== "string" || token.trim().length < 10 || token.length > 200 || /\s/.test(token)) {
    throw new Error("Telegram file token is corrupt: it must be one token with no spaces. Check state/telegram.json by hand first.");
  }
  return token.trim();
}

function saveTelegramState(rootDir: string, state: TelegramFileState): void {
  assertNoSecretFields({ users: state.users }, "Telegram allowlist");
  const dir = path.join(rootDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = { users: state.users };
  if (state.botToken) {
    data[FILE_TOKEN_KEY] = state.botToken;
  }
  fs.writeFileSync(telegramFilePath(rootDir), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// Save the bot token into state/telegram.json, keeping the allowlist.
// This is the write the TrustyHarness panel box will use once the panel
// change lands. The token is never logged or printed by this function.
export function setTelegramFileToken(rootDir: string, token: string): void {
  const clean = assertValidFileToken(token);
  if (!clean) {
    throw new Error("Telegram bot token must not be empty. No token was saved.");
  }
  const state = loadTelegramState(rootDir);
  state.botToken = clean;
  saveTelegramState(rootDir, state);
}

// Remove the file token, keeping the allowlist. Returns true when a
// token was there to remove.
export function clearTelegramFileToken(rootDir: string): boolean {
  const state = loadTelegramState(rootDir);
  if (!state.botToken) {
    return false;
  }
  state.botToken = null;
  saveTelegramState(rootDir, state);
  return true;
}

export function loadTelegramState(rootDir: string): TelegramFileState {
  const file = telegramFilePath(rootDir);
  if (!fs.existsSync(file)) {
    return { users: [], botToken: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    throw new Error("Telegram state is corrupt: it is not valid JSON. Check the file by hand first.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Telegram state is corrupt: it must hold an object with a users list.");
  }
  const record = parsed as Record<string, unknown>;
  const users = record.users;
  if (!Array.isArray(users)) {
    throw new Error("Telegram state is corrupt: it must hold a users list.");
  }
  const { [FILE_TOKEN_KEY]: tokenValue, ...rest } = record;
  assertNoSecretFields(rest, "Telegram allowlist");
  const botToken = assertValidFileToken(tokenValue);
  const seen = new Set<number>();
  const clean: TelegramAllowEntry[] = [];
  for (const entry of users) {
    const valid = assertValidAllowEntry(entry);
    if (!seen.has(valid.id)) {
      seen.add(valid.id);
      clean.push(valid);
    }
  }
  return { users: clean, botToken };
}

function assertNoSecretFields(value: unknown, where: string): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSecretFields(item, where);
    }
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      throw new Error(`${where} is corrupt: it holds a secret-like field (${key}). Check the file by hand first.`);
    }
    assertNoSecretFields(item, where);
  }
}

function assertValidAllowEntry(entry: unknown): TelegramAllowEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Telegram allowlist is corrupt: every entry must be an object with an id and a label.");
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error("Telegram allowlist is corrupt: every entry id must be a positive integer Telegram user id.");
  }
  if (typeof record.label !== "string" || record.label.trim().length === 0 || record.label.length > 100) {
    throw new Error("Telegram allowlist is corrupt: every entry label must be a short non-empty name.");
  }
  if (typeof record.addedAt !== "string") {
    throw new Error("Telegram allowlist is corrupt: every entry needs an addedAt timestamp.");
  }
  return { id: record.id, label: record.label, addedAt: record.addedAt };
}

export function loadAllowlist(rootDir: string): TelegramAllowEntry[] {
  return loadTelegramState(rootDir).users;
}

function saveAllowlist(rootDir: string, entries: TelegramAllowEntry[]): void {
  const current = loadTelegramState(rootDir);
  saveTelegramState(rootDir, { users: entries, botToken: current.botToken });
}

function assertValidUserId(userId: unknown): number {
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Telegram user id must be a positive integer, for example 123456789. No user was changed.");
  }
  return userId;
}

function assertValidLabel(label: unknown): string {
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 100) {
    throw new Error("Telegram label must be a short non-empty name, at most 100 characters. No user was changed.");
  }
  if (/[\r\n]/.test(label)) {
    throw new Error("Telegram label must be one line. No user was changed.");
  }
  return label.trim();
}

export function allowTelegramUser(rootDir: string, userId: number, label: string): TelegramAllowEntry[] {
  const id = assertValidUserId(userId);
  const cleanLabel = assertValidLabel(label);
  const entries = loadAllowlist(rootDir);
  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    existing.label = cleanLabel;
  } else {
    entries.push({ id, label: cleanLabel, addedAt: new Date().toISOString() });
  }
  saveAllowlist(rootDir, entries);
  return entries;
}

export function denyTelegramUser(rootDir: string, userId: number): boolean {
  const id = assertValidUserId(userId);
  const entries = loadAllowlist(rootDir);
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length === entries.length) {
    return false;
  }
  saveAllowlist(rootDir, remaining);
  return true;
}

export function isTelegramUserAllowed(rootDir: string, userId: number): boolean {
  return loadAllowlist(rootDir).some((entry) => entry.id === userId);
}

export function getTelegramAllowLabel(rootDir: string, userId: number): string | null {
  const entry = loadAllowlist(rootDir).find((item) => item.id === userId);
  return entry ? entry.label : null;
}

// ---------------------------------------------------------------------------
// Heartbeat, pid file, and bot status, V2.1. The bot writes
// state/telegram-heartbeat.json on every poll, so the TrustyHarness
// panel can show RUNNING or STOPPED honestly instead of guessing from
// the token alone. The supervisor writes state/telegram-bot.pid. Both
// files are gitignored through state/. Neither file ever holds the
// token: the heartbeat holds only the token source, env or file.
// ---------------------------------------------------------------------------

export interface TelegramHeartbeat {
  lastPollAt: string | null;
  running: boolean;
  pid: number;
  tenantId: string;
  tokenSource: "env" | "file" | "none";
  allowlistCount: number;
  lastError: string | null;
}

export function telegramHeartbeatPath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-heartbeat.json");
}

export function telegramPidPath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-bot.pid");
}

export function readTelegramHeartbeat(rootDir: string): TelegramHeartbeat | null {
  const file = telegramHeartbeatPath(rootDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    (typeof record.lastPollAt !== "string" && record.lastPollAt !== null) ||
    typeof record.running !== "boolean" ||
    typeof record.pid !== "number" ||
    typeof record.tenantId !== "string" ||
    typeof record.allowlistCount !== "number"
  ) {
    return null;
  }
  return {
    lastPollAt: (record.lastPollAt as string | null) ?? null,
    running: record.running,
    pid: record.pid,
    tenantId: record.tenantId,
    tokenSource: record.tokenSource === "env" || record.tokenSource === "file" ? record.tokenSource : "none",
    allowlistCount: record.allowlistCount,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
  };
}

export function writeTelegramHeartbeat(rootDir: string, heartbeat: TelegramHeartbeat): void {
  const dir = path.join(rootDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(telegramHeartbeatPath(rootDir), JSON.stringify(heartbeat, null, 2) + "\n", "utf-8");
}

export function readTelegramPid(rootDir: string): number | null {
  const file = telegramPidPath(rootDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  const raw = fs.readFileSync(file, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

export function writeTelegramPid(rootDir: string, pid: number): void {
  const dir = path.join(rootDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(telegramPidPath(rootDir), `${pid}\n`, "utf-8");
}

export function removeTelegramPid(rootDir: string): void {
  const file = telegramPidPath(rootDir);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

// True when the pid is alive right now. A zombie still answers
// kill(pid, 0) but is already dead: its parent has not reaped it yet.
// That happens exactly when the caller spawned the bot and is blocked
// waiting for the supervisor, so the zombie stays unreaped for the
// whole stop. The process state in /proc tells the truth: Z (zombie)
// or X (dead) means not alive.
export function isProcessAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    const state = closeParen >= 0 ? stat.slice(closeParen + 2, closeParen + 3) : "";
    if (state === "Z" || state === "X" || state === "x") {
      return false;
    }
  } catch {
    // No /proc entry: the process is gone, or /proc is unavailable.
    // Fall through to the kill check below.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// True when the pid is a telegram bot process: its argv must be
// exactly `node <path>/dist/index.js telegram-start|telegram-run`.
// A substring match is not enough: a parent shell that launched the
// bot holds the same words in its own command line, and pgrep would
// match the shell too.
export function isTelegramBotProcess(pid: number): boolean {
  let cmdline: Buffer;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return false;
  }
  const args = cmdline.toString("utf-8").split("\0").filter((part) => part.length > 0);
  if (args.length < 3) {
    return false;
  }
  const arg0 = args[0];
  if (arg0 !== "node" && !arg0.endsWith("/node")) {
    return false;
  }
  const arg1 = args[1];
  if (arg1 !== "dist/index.js" && !arg1.endsWith("/dist/index.js")) {
    return false;
  }
  return args[2] === "telegram-start" || args[2] === "telegram-run";
}

// Pids of running bot processes for one harness root, found by command
// line and working directory. The working directory is the filter that
// keeps one install from adopting another install's bot: a bot started
// by the supervisor runs with its working directory equal to its
// harness root. The current process and its parent are never returned,
// so a CLI that asks for the status never mistakes itself for the bot.
export function findTelegramBotPids(rootDir: string): number[] {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", "dist/index.js telegram-(start|run)"], { encoding: "utf-8" });
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const line of out.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pid === process.ppid) {
      continue;
    }
    if (!isTelegramBotProcess(pid)) {
      continue;
    }
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (path.resolve(cwd) !== path.resolve(rootDir)) {
        continue;
      }
    } catch {
      continue;
    }
    found.push(pid);
  }
  return found;
}

// Bot status for telegram-status: running or stopped, pid, token source,
// allowlist count, and the heartbeat last poll time. Never the token
// value. Running is decided by a live process, never by the heartbeat
// alone: a crashed bot leaves a stale running heartbeat behind.
export interface TelegramBotStatus {
  running: boolean;
  supervised: boolean;
  pid: number | null;
  heartbeat: TelegramHeartbeat | null;
  tokenSource: "env" | "file" | "none";
  tokenSet: boolean;
  allowlistCount: number;
}

export function getTelegramBotStatus(rootDir: string): TelegramBotStatus {
  const heartbeat = readTelegramHeartbeat(rootDir);
  const token = getTelegramTokenSource(rootDir);
  let allowlistCount = 0;
  try {
    allowlistCount = loadAllowlist(rootDir).length;
  } catch {
    allowlistCount = 0;
  }
  const recordedPid = readTelegramPid(rootDir);
  if (recordedPid !== null && isProcessAlive(recordedPid)) {
    return { running: true, supervised: true, pid: recordedPid, heartbeat, tokenSource: token.source, tokenSet: token.set, allowlistCount };
  }
  // No live pid in the file: a bot started by hand is still a running
  // bot. Find it by command line, so status stays honest until the
  // supervisor adopts it into the pid file.
  const found = findTelegramBotPids(rootDir);
  if (found.length > 0) {
    return { running: true, supervised: false, pid: found[0], heartbeat, tokenSource: token.source, tokenSet: token.set, allowlistCount };
  }
  return { running: false, supervised: false, pid: recordedPid, heartbeat, tokenSource: token.source, tokenSet: token.set, allowlistCount };
}

// ---------------------------------------------------------------------------
// Chat mode, V2.2. Telegram as a Muse channel. Plain text that is not a
// command is a chat message: the bot queues it in the inbox, sends one
// fixed acknowledgement at once, and a scheduled relay job run by Muse
// answers it later. The bot never answers chat itself. The relay writes
// its replies to the outbox, and the bot delivers them on its poll
// cycle. All three files are gitignored, install-wide, and never hold
// a credential. See docs/V2-2-TELEGRAM-MUSE-CHANNEL.md and
// scripts/telegram-relay.md.
// ---------------------------------------------------------------------------

export type TelegramQueueStatus = "new" | "processing" | "done" | "failed";
export type TelegramOutboxStatus = "pending" | "sent" | "failed";

export interface TelegramInboxEntry {
  messageId: number;
  telegramUserId: number;
  text: string;
  receivedAt: string;
  status: TelegramQueueStatus;
  attempts: number;
}

export interface TelegramOutboxEntry {
  replyId: string;
  inReplyTo: number;
  telegramUserId: number;
  text: string;
  createdAt: string;
  status: TelegramOutboxStatus;
  attempts: number;
  sentAt: string | null;
}

export interface TelegramThreadMessage {
  role: "user" | "muse";
  text: string;
  at: string;
}

export interface TelegramThread {
  userId: number;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messages: TelegramThreadMessage[];
}

export interface TelegramRelayStatus {
  lastRunAt: string | null;
  processed: number;
  failed: number;
  inboxPending: number;
  outboxPending: number;
  lastError: string | null;
}

export function telegramInboxPath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-inbox.jsonl");
}

export function telegramOutboxPath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-outbox.jsonl");
}

export function telegramThreadsDir(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-threads");
}

export function telegramThreadPath(rootDir: string, userId: number): string {
  return path.join(telegramThreadsDir(rootDir), `${userId}.json`);
}

export function telegramRelayStatusPath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram-relay-status.json");
}

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A corrupt line is skipped, never fatal: one bad line must not
      // stop the bot from polling or delivering the rest.
      console.log(`Telegram bot: skipped a corrupt line in ${path.basename(file)}.`);
    }
  }
  return out;
}

function writeJsonLines<T>(file: string, entries: T[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  fs.writeFileSync(file, body.length > 0 ? body + "\n" : "", "utf-8");
}

function appendJsonLine<T>(file: string, entry: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

export function readTelegramInbox(rootDir: string): TelegramInboxEntry[] {
  return readJsonLines<TelegramInboxEntry>(telegramInboxPath(rootDir));
}

export function appendTelegramInbox(rootDir: string, entry: TelegramInboxEntry): void {
  appendJsonLine(telegramInboxPath(rootDir), entry);
}

export function readTelegramOutbox(rootDir: string): TelegramOutboxEntry[] {
  return readJsonLines<TelegramOutboxEntry>(telegramOutboxPath(rootDir));
}

export function appendTelegramOutbox(rootDir: string, entry: TelegramOutboxEntry): void {
  appendJsonLine(telegramOutboxPath(rootDir), entry);
}

// Mark one outbox line by its reply id. The write is a full rewrite of
// the file, so a crash between sending and marking is the only window
// for a duplicate, and the next delivery then sends it once more.
export function markTelegramOutbox(
  rootDir: string,
  replyId: string,
  status: TelegramOutboxStatus,
  sentAt: string | null,
  attempts: number,
): boolean {
  const entries = readTelegramOutbox(rootDir);
  let changed = false;
  for (const entry of entries) {
    if (entry.replyId === replyId) {
      entry.status = status;
      entry.sentAt = sentAt;
      entry.attempts = attempts;
      changed = true;
    }
  }
  if (changed) {
    writeJsonLines(telegramOutboxPath(rootDir), entries);
  }
  return changed;
}

// A token-shaped string must never be stored in a thread file. The scan
// covers a Telegram bot token, an OpenAI-style key, and a GitHub
// personal token. A match does not block the chat message itself: the
// inbox still holds it so the relay can warn the user to revoke it,
// but the thread file never holds it.
export function containsSecretLikeText(text: string): boolean {
  return (
    /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(text) ||
    /\bsk-[A-Za-z0-9]{20,}\b/.test(text) ||
    /\bghp_[A-Za-z0-9]{20,}\b/.test(text)
  );
}

export function loadTelegramThread(rootDir: string, userId: number): TelegramThread | null {
  const file = telegramThreadPath(rootDir, userId);
  if (!fs.existsSync(file)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.userId !== "number" || !Array.isArray(record.messages)) {
    return null;
  }
  const messages: TelegramThreadMessage[] = [];
  for (const item of record.messages as unknown[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;
    if ((m.role === "user" || m.role === "muse") && typeof m.text === "string" && typeof m.at === "string") {
      messages.push({ role: m.role, text: m.text, at: m.at });
    }
  }
  return {
    userId: record.userId,
    label: typeof record.label === "string" ? record.label : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    summary: typeof record.summary === "string" ? record.summary : "",
    messages,
  };
}

export function saveTelegramThread(rootDir: string, thread: TelegramThread): void {
  fs.mkdirSync(telegramThreadsDir(rootDir), { recursive: true });
  fs.writeFileSync(telegramThreadPath(rootDir, thread.userId), JSON.stringify(thread, null, 2) + "\n", "utf-8");
}

// Append one message to a user's thread, keeping the last 20. The bot
// appends the user's own messages; the relay appends Muse replies with
// the same shape. The summary is the relay's own words and is never
// rewritten here: when the list passes 20 the oldest entries are
// dropped and the summary is left as the relay wrote it.
export function appendTelegramThreadMessage(
  rootDir: string,
  userId: number,
  role: "user" | "muse",
  text: string,
  nowIso?: string,
): TelegramThread {
  const at = nowIso || new Date().toISOString();
  const existing = loadTelegramThread(rootDir, userId);
  const thread: TelegramThread = existing || {
    userId,
    label: getTelegramAllowLabel(rootDir, userId),
    createdAt: at,
    updatedAt: at,
    summary: "",
    messages: [],
  };
  thread.messages.push({ role, text, at });
  if (thread.messages.length > TELEGRAM_THREAD_MAX_MESSAGES) {
    thread.messages = thread.messages.slice(thread.messages.length - TELEGRAM_THREAD_MAX_MESSAGES);
  }
  thread.updatedAt = at;
  saveTelegramThread(rootDir, thread);
  return thread;
}

// The relay job writes this file after each run, so
// telegram-relay-status can report when the relay last ran. A missing
// or corrupt file means the relay has never run, never an error.
export function readTelegramRelayStatus(rootDir: string): TelegramRelayStatus | null {
  const file = telegramRelayStatusPath(rootDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null,
    processed: typeof record.processed === "number" ? record.processed : 0,
    failed: typeof record.failed === "number" ? record.failed : 0,
    inboxPending: typeof record.inboxPending === "number" ? record.inboxPending : 0,
    outboxPending: typeof record.outboxPending === "number" ? record.outboxPending : 0,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
  };
}

// Messages waiting for the relay to answer them. "processing" lines
// are being worked on, so only "new" lines count as pending.
export function telegramInboxPendingCount(rootDir: string): number {
  return readTelegramInbox(rootDir).filter((entry) => entry.status === "new").length;
}

export function telegramOutboxPendingCount(rootDir: string): number {
  return readTelegramOutbox(rootDir).filter((entry) => entry.status === "pending").length;
}

// ---------------------------------------------------------------------------
// Message helpers. Telegram caps a message at 4096 characters, so every
// reply is capped at 4000 with a note. User input is never echoed back
// into an audit detail except as a single sanitized token, so a crafted
// message cannot inject newlines into the audit log.
// ---------------------------------------------------------------------------

export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) {
    return text;
  }
  return text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS) + "\n[Reply cut short: it was over the Telegram message limit.]";
}

// Split a long reply into numbered parts, each under the Telegram
// limit. Splitting is code-point safe, so an emoji is never cut in
// half. A single part is sent as-is, with no part number.
export function splitTelegramMessage(text: string): string[] {
  const points = Array.from(text);
  if (points.length <= TELEGRAM_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const bodySize = 3900;
  const bodies: string[] = [];
  for (let i = 0; i < points.length; i += bodySize) {
    bodies.push(points.slice(i, i + bodySize).join(""));
  }
  return bodies.map((body, index) => `[${index + 1}/${bodies.length}] ${body}`);
}

export function oneLine(value: string, maxLength: number): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
}

// Split command text into tokens, keeping quoted parts together, so a
// title like "My task title" stays one token. An unterminated quote is
// treated leniently: the rest of the text is one token.
export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let hasToken = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        out.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) {
    out.push(current);
  }
  return out;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) {
      continue;
    }
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = "";
    }
  }
  return flags;
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

const HELP_TEXT = [
  "TrustyMUSE Harness commands:",
  "Just talk to use Muse here. Plain text goes to Muse, and Muse replies here within a few minutes. Commands below run at once, with no wait.",
  "/status - harness version, tenant, HOLD, budget, models, browser accounts",
  "/models - subscription models and which are connected",
  "/projects - connected projects",
  "/project_list - connected projects",
  "/project_add <id> <name> <kind> <path> - connect a project (path must be inside the workspace)",
  "/project_remove <id> - disconnect a project",
  "/project_pause <id> - pause a project",
  "/model_connect <id> - connect a subscription model",
  "/model_disconnect <id> - disconnect a subscription model",
  "/account_list - browser accounts and their state",
  "/browser_status - browser accounts and their connection state",
  "/tenant_status - tenant, budget, projects, accounts, audit count",
  "/analytics_status - analytics off or on, install id, last send",
  "/analytics_preview - the counts-only payload, nothing is sent",
  "/audit - the last 10 audit events",
  "/packet --model <id> --type <type> --title \"<title>\" --task \"<task>\" - create a draft packet only",
  "/task --model <id> --type <type> --title \"<title>\" --task \"<task>\" [--project <id>] - create a task and its packet",
  "/run --account <id> --task \"<task>\" [--model <id>] [--type <type>] [--title \"<title>\"] [--project <id>] - run one browser job on a connected account",
  "/do <instruction> - plain words: project <id>: <task>, <task> with <model>, or plan with chatgpt then audit with claude: <task>. Never deploys.",
  "/hold on - turn HOLD on at once. /hold off - asks for YES first, then turns HOLD off",
  "/run_browser is refused. Use /run for a connected account, or run-browser on the command line.",
  "Connected means packet mode only, not a live login, token, or call.",
].join("\n");

// Words that mean the user wants the result live. /do never acts on
// them: it runs the plan and audit steps and then reports the verdict,
// and the deploy itself needs the user's approval in the Muse app.
const DEPLOY_WORDS = /\b(deploy|live|publish)\b/i;

// Markers in an audit reply that read as a failed audit. This is a
// text-marker check only, not a full verification: the reply says so,
// and the deploy still needs the user's approval in the Muse app.
const AUDIT_FAILURE_MARKERS = [
  "fail",
  "failed",
  "failure",
  "error",
  "not ready",
  "blocked",
  "cannot proceed",
  "do not deploy",
];

export function auditPassedByMarkers(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return !AUDIT_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

// ---------------------------------------------------------------------------
// /do intent parser. Pure, no LLM call, no state. It handles three
// patterns, in this order, because the pipeline pattern also holds a
// colon and the model pattern also holds the word "with":
//   plan with <model> then audit with <model>: <task>
//   project <id>: <task>
//   <task> with <model>
// Anything else is a plain task for the default model.
// ---------------------------------------------------------------------------

export type DoKind = "pipeline" | "project" | "model" | "plain";

export interface DoPlan {
  kind: DoKind;
  taskText: string;
  planModel?: string;
  auditModel?: string;
  projectId?: string;
  model?: string;
  wantsDeploy: boolean;
}

export function parseDoInstruction(instruction: string): DoPlan {
  const text = (instruction || "").trim();
  const wantsDeploy = DEPLOY_WORDS.test(text);
  const pipeline = text.match(/^\s*plan\s+with\s+([a-z][a-z0-9-]*)\s*(?:then|,)\s*(?:audit|review|check)\s+with\s+([a-z][a-z0-9-]*)\s*:\s*(.+)$/is);
  if (pipeline) {
    return {
      kind: "pipeline",
      taskText: pipeline[3].trim(),
      planModel: pipeline[1].toLowerCase(),
      auditModel: pipeline[2].toLowerCase(),
      wantsDeploy,
    };
  }
  const project = text.match(/^\s*project\s+([a-z0-9][a-z0-9-]{0,31})\s*:\s*(.+)$/is);
  if (project) {
    return { kind: "project", taskText: project[2].trim(), projectId: project[1].toLowerCase(), wantsDeploy };
  }
  const withModel = text.match(/^(.+?)\s+with\s+([a-z][a-z0-9-]*)\s*$/is);
  if (withModel && getSubscriptionModel(withModel[2].toLowerCase())) {
    return { kind: "model", taskText: withModel[1].trim(), model: withModel[2].toLowerCase(), wantsDeploy };
  }
  return { kind: "plain", taskText: text, wantsDeploy };
}

// ---------------------------------------------------------------------------
// Bot. One bot serves one tenant, resolved once at start like any CLI
// command. The allowlist is install-wide. Rate limiting and the
// unauthorized-attempt throttle live in memory only and reset on restart.
// ---------------------------------------------------------------------------

export interface TelegramBotOptions {
  rootDir: string;
  ctx: TenantContext;
  config: HarnessConfig;
  api: TelegramApi;
  pollTimeoutSeconds?: number;
  now?: () => number;
  // Test seam only. Builds the browser driver for a /run job. The
  // default is the real Playwright driver, or the mock driver when
  // TRUSTYMUSE_BROWSER_MOCK is 1, the same switch the CLI uses.
  driverFactory?: (account: BrowserAccount) => BrowserDriver;
  // Test seam only. The workspace root for /project_add. The default is
  // the real workspace, ~/workspace, like project-add.
  workspaceRoot?: string;
  // Test seam only. Sleeps between poll retries. Defaults to a real
  // setTimeout sleep. Tests pass a fake that records the delay and
  // resolves at once, so backoff timing is testable without waiting.
  sleep?: (ms: number) => Promise<void>;
}

interface CommandOutcome {
  reply: string;
  event: string;
  result?: "ok" | "blocked" | "valid" | "invalid";
  model?: string;
  taskType?: string;
  detail?: string;
}

// One browser job result, shared by /run and the /do pipeline. The
// reply text is the worker's own words, truncated to the Telegram
// limit by the caller. No prompt text is ever put in an audit event.
interface BrowserJobOutcome {
  ok: boolean;
  text: string;
  attempts: number;
  reason: string;
  paused: boolean;
  filePath: string | null;
}

export class TelegramBot {
  private rootDir: string;
  private ctx: TenantContext;
  private config: HarnessConfig;
  private api: TelegramApi;
  private pollTimeoutSeconds: number;
  private now: () => number;
  private offset: number | null = null;
  private stopped = false;
  // True while a getUpdates request is in flight. A second pollOnce
  // call returns at once instead of starting a second request: the
  // live bot overlapped requests after a client abort and Telegram
  // answered with HTTP 409.
  private pollInFlight = false;
  private sleep: (ms: number) => Promise<void>;
  private commandTimes = new Map<number, number[]>();
  private unauthorizedLoggedAt = new Map<number, number>();
  // Chat rate limit, V2.2, separate from the command limit: at most
  // 10 chat messages per user per 10 minutes. The slow-down reply is
  // sent once per window; further messages in the window are dropped
  // silently. Both maps live in memory only and reset on restart.
  private chatTimes = new Map<number, number[]>();
  private chatSlowdownSentAt = new Map<number, number>();
  private driverFactory: (account: BrowserAccount) => BrowserDriver;
  private workspaceRoot?: string;
  private queue: BrowserQueue;
  // HOLD-off confirmations. One entry per user: the time the user was
  // asked to reply YES. Anything else in the next message cancels it.
  private pendingHoldOff = new Map<number, number>();
  private static readonly HOLD_OFF_CONFIRM_WINDOW_MS = 10 * 60 * 1000;

  constructor(options: TelegramBotOptions) {
    this.rootDir = options.rootDir;
    this.ctx = options.ctx;
    this.config = options.config;
    this.api = options.api;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? TELEGRAM_POLL_TIMEOUT_SECONDS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.driverFactory =
      options.driverFactory ||
      ((account: BrowserAccount) =>
        process.env.TRUSTYMUSE_BROWSER_MOCK === "1"
          ? new MockBrowserDriver()
          : new PlaywrightBrowserDriver({ headless: this.config.browser.headless }));
    this.workspaceRoot = options.workspaceRoot;
    // One queue for the whole bot process, so one job at a time per
    // account and the pacing delay hold across /run and /do commands.
    // No onEvent audit hook: the bot writes exactly one audit event per
    // command, the outcome event, and job lifecycle events stay out of
    // the audit log for Telegram runs.
    this.queue = new BrowserQueue({
      browserEnabled: this.config.browser.enabled,
      pacingMs: this.config.browser.pacingMs,
      dailyLimitPerAccount: this.config.browser.dailyLimitPerAccount,
      nowMs: () => this.now(),
    });
  }

  stop(): void {
    this.stopped = true;
  }

  async pollOnce(): Promise<void> {
    // Never start a second getUpdates while one is still in flight. A
    // concurrent call returns at once, it never starts a request.
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const updates = await this.api.getUpdates(this.offset, this.pollTimeoutSeconds);
      for (const update of updates) {
        this.offset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (error) {
          console.log(`Telegram bot: one update failed and was skipped. ${String(error).replace(/^Error: /, "")}`);
        }
      }
      // Outbox delivery runs on every poll cycle, even when there were
      // no updates, so relay replies reach the user without waiting
      // for the next message. A delivery failure never breaks polling.
      try {
        await this.deliverOutbox();
      } catch (error) {
        console.log(`Telegram bot: outbox delivery failed this cycle. ${String(error).replace(/^Error: /, "")}`);
      }
      this.writeHeartbeat(true, null);
    } catch (error) {
      this.writeHeartbeat(true, String(error).replace(/^Error: /, ""));
      throw error;
    } finally {
      this.pollInFlight = false;
    }
  }

  async run(): Promise<void> {
    const onSignal = (): void => {
      this.stopped = true;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    // The bot is running from the first poll. The heartbeat says so
    // even before the first successful poll returns.
    this.writeHeartbeat(true, null);
    try {
      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          const message = String(error).replace(/^Error: /, "");
          // HTTP 409 means another getUpdates request is still open on
          // Telegram's side. Back off longer instead of hammering the
          // same 5-second retry that caused the overlap.
          const conflict = /HTTP 409/.test(message);
          const delay = conflict ? TELEGRAM_POLL_CONFLICT_BACKOFF_MS : TELEGRAM_POLL_RETRY_MS;
          console.log(
            conflict
              ? `Telegram bot: poll conflict (HTTP 409), another getUpdates is still open. Retrying in 15 seconds. ${message}`
              : `Telegram bot: poll failed, retrying in 5 seconds. ${message}`,
          );
          await this.sleep(delay);
        }
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      this.writeHeartbeat(false, null);
    }
    console.log("Telegram bot stopped.");
  }

  // The heartbeat must never break polling. A failed write is ignored:
  // the panel then shows the last good heartbeat.
  private writeHeartbeat(running: boolean, lastError: string | null): void {
    try {
      const token = getTelegramTokenSource(this.rootDir);
      let allowlistCount = 0;
      try {
        allowlistCount = loadAllowlist(this.rootDir).length;
      } catch {
        allowlistCount = 0;
      }
      writeTelegramHeartbeat(this.rootDir, {
        lastPollAt: new Date(this.now()).toISOString(),
        running,
        pid: process.pid,
        tenantId: this.ctx.tenantId,
        tokenSource: token.source,
        allowlistCount,
        lastError,
      });
    } catch {
      // Ignored on purpose, see above.
    }
  }

  private telegramDetail(userId: number, extra?: string): string {
    const label = getTelegramAllowLabel(this.rootDir, userId);
    const base = `telegram_user:${userId}${label ? ` label:${label}` : ""}`;
    return extra ? `${base} ${extra}` : base;
  }

  private auditEvent(outcome: CommandOutcome, userId: number): void {
    appendAudit(
      {
        at: new Date().toISOString(),
        runId: newRunId(),
        event: outcome.event,
        model: outcome.model,
        taskType: outcome.taskType,
        detail: this.telegramDetail(userId, outcome.detail),
        result: outcome.result || "ok",
      },
      this.rootDir,
      this.ctx.tenantId,
    );
  }

  private checkRateLimit(userId: number): boolean {
    const now = this.now();
    const windowStart = now - TELEGRAM_RATE_WINDOW_MS;
    const times = (this.commandTimes.get(userId) || []).filter((t) => t > windowStart);
    if (times.length >= TELEGRAM_MAX_COMMANDS_PER_MINUTE) {
      this.commandTimes.set(userId, times);
      return false;
    }
    times.push(now);
    this.commandTimes.set(userId, times);
    return true;
  }

  private logUnauthorized(userId: number): void {
    const now = this.now();
    const last = this.unauthorizedLoggedAt.get(userId) || 0;
    if (now - last < TELEGRAM_RATE_WINDOW_MS) {
      return;
    }
    this.unauthorizedLoggedAt.set(userId, now);
    console.log(
      `Telegram bot: user ${userId} is not allowlisted. No reply was sent. Allow with: node dist/index.js telegram-allow --user-id ${userId} --label "<Name>"`,
    );
    appendAudit(
      {
        at: new Date().toISOString(),
        runId: newRunId(),
        event: "telegram_unauthorized",
        detail: `telegram_user:${userId}`,
        result: "blocked",
      },
      this.rootDir,
      this.ctx.tenantId,
    );
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || typeof message.text !== "string" || !message.from || typeof message.from.id !== "number") {
      return;
    }
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text.trim();
    if (!isTelegramUserAllowed(this.rootDir, userId)) {
      this.logUnauthorized(userId);
      return;
    }
    // Commands keep the 20-per-minute command limit. Chat messages
    // have their own limit, checked inside dispatch, so talking does
    // not eat the command budget and commands do not eat the chat one.
    if (text.startsWith("/")) {
      if (!this.checkRateLimit(userId)) {
        await this.api.sendMessage(
          chatId,
          truncateForTelegram("Slow down: you sent too many commands in one minute. Wait a minute and try again."),
        );
        this.auditEvent({ reply: "", event: "telegram_rate_limited", result: "blocked" }, userId);
        return;
      }
    }
    // A pending HOLD-off confirmation is answered by the next message
    // only. YES turns HOLD off. Anything else cancels the confirmation
    // and runs as a normal command instead.
    if (this.pendingHoldOff.has(userId)) {
      const askedAt = this.pendingHoldOff.get(userId) || 0;
      this.pendingHoldOff.delete(userId);
      if (text.trim().toLowerCase() === "yes" && this.now() - askedAt <= TelegramBot.HOLD_OFF_CONFIRM_WINDOW_MS) {
        const outcome = this.confirmHoldOff();
        if (outcome.reply) {
          await this.api.sendMessage(chatId, truncateForTelegram(outcome.reply));
        }
        this.auditEvent(outcome, userId);
        return;
      }
      console.log(`Telegram bot: HOLD-off confirmation cancelled for user ${userId}.`);
    }
    const outcome = await this.dispatch(userId, text, { chatId, updateId: update.update_id });
    if (!outcome) {
      // Silent drop: a chat message over the rate limit after the one
      // slow-down reply in this window. No reply, no audit event.
      return;
    }
    if (outcome.reply) {
      await this.api.sendMessage(chatId, truncateForTelegram(outcome.reply));
    }
    this.auditEvent(outcome, userId);
  }

  // Chat rate limit, V2.2. Returns "ok" when the message may be
  // queued, "slowdown" when this is the first message over the limit
  // in the window and the user gets one polite slow-down reply, and
  // "silent" for every further message in the window.
  private checkChatRateLimit(userId: number): "ok" | "slowdown" | "silent" {
    const now = this.now();
    const windowStart = now - TELEGRAM_CHAT_WINDOW_MS;
    const times = (this.chatTimes.get(userId) || []).filter((t) => t > windowStart);
    if (times.length >= TELEGRAM_CHAT_MAX_PER_WINDOW) {
      const slowdownAt = this.chatSlowdownSentAt.get(userId) || 0;
      if (now - slowdownAt > TELEGRAM_CHAT_WINDOW_MS) {
        this.chatSlowdownSentAt.set(userId, now);
        return "slowdown";
      }
      return "silent";
    }
    times.push(now);
    this.chatTimes.set(userId, times);
    return "ok";
  }

  // Chat mode, V2.2. Plain text from an allowlisted user is queued in
  // the inbox for the relay and answered with one fixed acknowledgement
  // at once. The bot never answers chat itself, and the acknowledgement
  // is never mistaken for a Muse reply: it is a fixed string that says
  // Muse will reply, not that Muse has replied.
  private queueChat(userId: number, text: string, updateId: number): CommandOutcome | null {
    const limit = this.checkChatRateLimit(userId);
    if (limit === "slowdown") {
      return { reply: TELEGRAM_CHAT_SLOWDOWN, event: "telegram_chat_rate_limited", result: "blocked" };
    }
    if (limit === "silent") {
      return null;
    }
    const stored = text.length > TELEGRAM_MAX_MESSAGE_CHARS ? text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS) : text;
    appendTelegramInbox(this.rootDir, {
      messageId: updateId,
      telegramUserId: userId,
      text: stored,
      receivedAt: new Date(this.now()).toISOString(),
      status: "new",
      attempts: 0,
    });
    // The thread keeps the conversation, but never a secret. A
    // token-shaped string is still queued, so the relay can warn the
    // user to revoke it, but it is never written to the thread file.
    if (!containsSecretLikeText(stored)) {
      try {
        appendTelegramThreadMessage(this.rootDir, userId, "user", stored, new Date(this.now()).toISOString());
      } catch {
        // A thread write failure must not lose the chat message: the
        // inbox already holds it, and the relay answers from the inbox.
        console.log(`Telegram bot: thread write failed for user ${userId}, the inbox still holds the message.`);
      }
    }
    return { reply: TELEGRAM_CHAT_ACK, event: "telegram_chat_queued" };
  }

  // Outbox delivery, V2.2. Sends pending outbox lines, oldest first,
  // and marks each one sent only after Telegram confirms the send. A
  // line is sent at most once per cycle: after a successful send its
  // status is "sent", so the next cycle skips it. A failed send leaves
  // the line pending and stops this cycle, so order is kept and the
  // next cycle retries. After three failed attempts the line is marked
  // "failed" and never retried.
  private async deliverOutbox(): Promise<void> {
    const entries = readTelegramOutbox(this.rootDir);
    for (const entry of entries) {
      if (entry.status !== "pending") {
        continue;
      }
      const parts = splitTelegramMessage(entry.text);
      try {
        for (const part of parts) {
          await this.api.sendMessage(entry.telegramUserId, part);
        }
        markTelegramOutbox(this.rootDir, entry.replyId, "sent", new Date(this.now()).toISOString(), entry.attempts);
      } catch (error) {
        const attempts = (entry.attempts || 0) + 1;
        const failed = attempts >= TELEGRAM_OUTBOX_MAX_ATTEMPTS;
        markTelegramOutbox(this.rootDir, entry.replyId, failed ? "failed" : "pending", null, attempts);
        console.log(
          `Telegram bot: outbox delivery failed for reply ${entry.replyId}, attempt ${attempts}. ${String(error).replace(/^Error: /, "")}`,
        );
        break;
      }
    }
  }

  private async dispatch(userId: number, text: string, context?: { chatId: number; updateId: number }): Promise<CommandOutcome | null> {
    if (!text.startsWith("/")) {
      if (!context) {
        return null;
      }
      return this.queueChat(userId, text, context.updateId);
    }
    const tokens = tokenizeArgs(text);
    const first = tokens[0] || "";
    const name = first.slice(1).split("@")[0].toLowerCase();
    const args = tokens.slice(1);
    switch (name) {
      case "start":
        return this.handleStart(userId);
      case "help":
        return { reply: HELP_TEXT, event: "telegram_help" };
      case "status":
        return { reply: this.handleStatus(), event: "status_checked" };
      case "models":
        return { reply: this.handleModels(), event: "telegram_models" };
      case "projects":
      case "project_list":
        return { reply: this.handleProjects(), event: "telegram_projects" };
      case "project_add":
        return this.handleProjectAdd(args);
      case "project_remove":
        return this.handleProjectRemove(args);
      case "project_pause":
        return this.handleProjectPause(args);
      case "model_connect":
        return this.handleModelConnect(args);
      case "model_disconnect":
        return this.handleModelDisconnect(args);
      case "account_list":
        return { reply: this.handleAccountList(), event: "telegram_account_list" };
      case "tenant_status":
        return { reply: this.handleTenantStatus(), event: "telegram_tenant_status" };
      case "browser_status":
        return { reply: this.handleBrowserStatus(), event: "browser_status_checked" };
      case "analytics_status":
        return { reply: this.handleAnalyticsStatus(), event: "analytics_status_checked" };
      case "analytics_preview":
        return this.handleAnalyticsPreview();
      case "audit":
        return { reply: this.handleAudit(), event: "telegram_audit" };
      case "packet":
      case "task":
        return this.handlePacket(args);
      case "run":
        return this.handleRun(args);
      case "do": {
        const spaceAt = text.indexOf(" ");
        const instruction = spaceAt < 0 ? "" : text.slice(spaceAt + 1).trim();
        return this.handleDo(instruction);
      }
      case "hold":
        return this.handleHold(userId, args);
      case "run_browser":
        return {
          reply: "Browser jobs no longer run from the CLI only. Use /run --account <id> --task \"<task>\" for a connected account, or run-browser on the command line. /run_browser itself is refused.",
          event: "telegram_run_browser_refused",
          result: "blocked",
        };
      default:
        return {
          reply: `Unknown command: /${oneLine(name, 40)}. Send /help for the command list.`,
          event: "telegram_unknown_command",
          detail: `command:/${oneLine(name, 40)}`,
        };
    }
  }

  private handleStart(userId: number): CommandOutcome {
    const label = getTelegramAllowLabel(this.rootDir, userId);
    const lines = [
      "TrustyMUSE Harness, connected over Telegram.",
      label ? `You are allowlisted as ${label}.` : "You are allowlisted.",
      "Just talk to use Muse here. Plain text goes to Muse, and Muse replies here within a few minutes. Commands run at once, with no wait. /packet and /task create drafts only, never send. /run runs one browser job on a connected account. /do takes plain words and turns them into a packet or a plan-then-audit pipeline. HOLD blocks every write, and nothing here ever deploys.",
      "",
      HELP_TEXT,
    ];
    return { reply: lines.join("\n"), event: "telegram_start" };
  }

  private handleStatus(): string {
    const version = readHarnessVersion(this.rootDir);
    const budget = new BudgetTracker(tenantCapUsd(this.ctx.tenant, this.config), this.config.warnAtPercent, this.rootDir, this.ctx.tenantId);
    const status = budget.getStatus();
    const connected = listConnectedModels(this.ctx);
    const accounts = loadAccounts(this.rootDir, this.ctx.tenantId);
    const connectedAccounts = accounts.filter((a) => a.browserConnected === true).length;
    const lines = [
      `TrustyMUSE Harness ${version}`,
      `Tenant: ${this.ctx.tenant.displayName} (${this.ctx.tenantId})`,
      `HOLD: ${this.config.hold ? "ON" : "OFF"}`,
      `Budget: cap ${status.capUsd} ${this.config.currency}, used ${status.usedUsd}, remaining ${status.remainingUsd}, month ${status.month}${status.blocked ? ", BLOCKED (cap is 0)" : ""}`,
      `Models connected: ${connected.length} of 9: ${connected.map((m) => m.id).join(", ") || "none"}`,
      `Browser: ${connectedAccounts} of ${accounts.length} account(s) connected.`,
      CONNECTED_LEGEND,
    ];
    return lines.join("\n");
  }

  private handleModels(): string {
    const lines: string[] = ["Subscription models:"];
    for (const model of listModels()) {
      if (model.connection !== "subscription") {
        continue;
      }
      const state = isModelConnected(this.ctx, model.id) ? "connected" : "not connected";
      lines.push(`  ${model.id} (${model.provider}, ${state}, browser ${model.browserSupport})`);
    }
    lines.push("Connected means packet mode only, not a live login, token, or call.");
    return lines.join("\n");
  }

  private handleProjects(): string {
    const projects = listProjects(this.rootDir, this.ctx.tenantId);
    if (projects.length === 0) {
      return "No projects connected yet. Add one with /project_add <id> <name> <kind> <path>, or project-add on the command line.";
    }
    const lines = [`Connected projects: ${projects.length}`];
    for (const project of projects) {
      lines.push(`  ${project.id} (${project.name}, ${project.kind}, ${project.status})`);
    }
    return lines.join("\n");
  }

  // Project writes. HOLD blocks all three, the same as project-add,
  // project-remove, and project-pause on the command line. The path
  // must sit inside the workspace, the same rule as project-add.
  private handleProjectAdd(args: string[]): CommandOutcome {
    const [id, name, kind, rootPath] = args;
    if (!id || !name || !kind || !rootPath) {
      return {
        reply: "Usage: /project_add <id> <name> <kind> <path>. Kind is web-app, api, extension, static-site, docs, or repo-only. The path must be inside the workspace. Quote a name with spaces, for example /project_add my-app \"My App\" web-app ~/workspace/my-app.",
        event: "telegram_project_blocked",
        result: "blocked",
      };
    }
    try {
      assertProjectWriteAllowed(this.config.hold);
      const project = addProject(
        { id, name, kind, rootPath },
        { rootDir: this.rootDir, tenantId: this.ctx.tenantId, workspaceRoot: this.workspaceRoot },
      );
      return {
        reply: `Project connected: ${project.id} (${project.name}, ${project.kind}). Root: ${project.rootPath}. Jobs scoped to it are draft only, never publish, send, merge, or deploy.`,
        event: "telegram_project_added",
        detail: `project:${project.id}`,
      };
    } catch (error) {
      return {
        reply: `Project was not connected. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_project_blocked",
        result: "blocked",
        detail: `project:${oneLine(id, 40)}`,
      };
    }
  }

  private handleProjectRemove(args: string[]): CommandOutcome {
    const id = args[0] || "";
    if (!id) {
      return {
        reply: "Usage: /project_remove <id>. Use /project_list to see connected projects.",
        event: "telegram_project_blocked",
        result: "blocked",
      };
    }
    try {
      assertProjectWriteAllowed(this.config.hold);
      const removed = removeProject(id, this.rootDir, this.ctx.tenantId);
      return {
        reply: `Project disconnected: ${removed.id} (${removed.name}). Tasks already dispatched keep their recorded project id.`,
        event: "telegram_project_removed",
        detail: `project:${removed.id}`,
      };
    } catch (error) {
      return {
        reply: `Project was not removed. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_project_blocked",
        result: "blocked",
        detail: `project:${oneLine(id, 40)}`,
      };
    }
  }

  private handleProjectPause(args: string[]): CommandOutcome {
    const id = args[0] || "";
    if (!id) {
      return {
        reply: "Usage: /project_pause <id>. Use /project_list to see connected projects.",
        event: "telegram_project_blocked",
        result: "blocked",
      };
    }
    try {
      assertProjectWriteAllowed(this.config.hold);
      const project = pauseProject(id, this.rootDir, this.ctx.tenantId);
      return {
        reply: `Project paused: ${project.id} (${project.name}). Paused projects cannot run jobs. Add it back with /project_add, or unpause it on the command line.`,
        event: "telegram_project_paused",
        detail: `project:${project.id}`,
      };
    } catch (error) {
      return {
        reply: `Project was not paused. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_project_blocked",
        result: "blocked",
        detail: `project:${oneLine(id, 40)}`,
      };
    }
  }

  // Model connect and disconnect, the same rules as model-connect and
  // model-disconnect on the command line. Disconnecting chatgpt or
  // claude is refused while this tenant still has an active browser
  // account for it.
  private handleModelConnect(args: string[]): CommandOutcome {
    const modelId = (args[0] || "").toLowerCase();
    if (!modelId) {
      return {
        reply: "Usage: /model_connect <id>. Use /models to see the subscription models.",
        event: "telegram_model_blocked",
        result: "blocked",
      };
    }
    if (this.config.hold) {
      return {
        reply: "Model was not connected. HOLD is on. All writes are blocked until HOLD is lifted by the user.",
        event: "telegram_model_blocked",
        result: "blocked",
        model: modelId,
      };
    }
    try {
      const ids = connectModel(this.ctx, modelId);
      return {
        reply: `Model connected: ${modelId}. Connected models now: ${ids.join(", ") || "none"}. Connected means packet mode only, not a live login, token, or call.`,
        event: "telegram_model_connected",
        model: modelId,
      };
    } catch (error) {
      return {
        reply: `Model was not connected. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_model_blocked",
        result: "blocked",
        model: modelId,
      };
    }
  }

  private handleModelDisconnect(args: string[]): CommandOutcome {
    const modelId = (args[0] || "").toLowerCase();
    if (!modelId) {
      return {
        reply: "Usage: /model_disconnect <id>. Use /models to see the subscription models.",
        event: "telegram_model_blocked",
        result: "blocked",
      };
    }
    if (this.config.hold) {
      return {
        reply: "Model was not disconnected. HOLD is on. All writes are blocked until HOLD is lifted by the user.",
        event: "telegram_model_blocked",
        result: "blocked",
        model: modelId,
      };
    }
    try {
      const accounts = loadAccounts(this.rootDir, this.ctx.tenantId);
      const hasActiveAccount = accounts.some(
        (a) => a.provider === modelId && a.enabled && a.status === "active",
      );
      const remaining = disconnectModel(this.ctx, modelId, { hasActiveAccount });
      return {
        reply: `Model disconnected: ${modelId}. Connected models now: ${remaining.join(", ") || "none"}.`,
        event: "telegram_model_disconnected",
        model: modelId,
      };
    } catch (error) {
      return {
        reply: `Model was not disconnected. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_model_blocked",
        result: "blocked",
        model: modelId,
      };
    }
  }

  private handleAccountList(): string {
    const accounts = loadAccounts(this.rootDir, this.ctx.tenantId);
    if (accounts.length === 0) {
      return "No browser accounts yet. Add one with account-add on the command line, log in once by hand in that profile, then verify it with browser-connect.";
    }
    const lines = [`Browser accounts: ${accounts.length}`];
    for (const account of accounts) {
      lines.push(
        `  ${account.id} (${account.provider}, ${account.label}, ${account.browserConnected ? "connected" : "disconnected"}, status ${account.status}, today ${account.dailyCount} jobs)`,
      );
    }
    return lines.join("\n");
  }

  private handleTenantStatus(): string {
    const budget = new BudgetTracker(tenantCapUsd(this.ctx.tenant, this.config), this.config.warnAtPercent, this.rootDir, this.ctx.tenantId);
    const status = budget.getStatus();
    const projects = listProjects(this.rootDir, this.ctx.tenantId);
    const accounts = loadAccounts(this.rootDir, this.ctx.tenantId);
    const events = readAuditEvents(this.rootDir, this.ctx.tenantId);
    return [
      `Tenant: ${this.ctx.tenant.displayName} (${this.ctx.tenant.id}, label ${this.ctx.tenant.museAccountLabel}, ${this.ctx.tenant.status})`,
      `Budget: cap ${status.capUsd} ${this.config.currency}, used ${status.usedUsd}, remaining ${status.remainingUsd}, month ${status.month}${status.blocked ? ", BLOCKED (cap is 0)" : ""}`,
      `Projects: ${projects.length} connected, accounts: ${accounts.length}, audit events: ${events.length}`,
      `Policy HOLD: ${this.config.hold ? "ON" : "OFF"}`,
      `Created: ${this.ctx.tenant.createdAt}, last used: ${this.ctx.tenant.lastUsed || "never"}`,
    ].join("\n");
  }

  // HOLD control. Turning HOLD on is immediate and always allowed: the
  // kill switch must never be blocked. Turning it off asks for a YES
  // in the next message first, and the pending confirmation is stored
  // in memory only, so a bot restart clears it.
  private handleHold(userId: number, args: string[]): CommandOutcome {
    const action = (args[0] || "").toLowerCase();
    if (action === "on") {
      this.pendingHoldOff.delete(userId);
      if (this.config.hold) {
        return { reply: "HOLD is already ON. All writes from Telegram are blocked.", event: "telegram_hold_on" };
      }
      this.config.hold = true;
      saveConfig(this.config, this.rootDir);
      return {
        reply: "HOLD is now ON. All writes from Telegram are blocked, including packets, projects, models, and browser jobs.",
        event: "telegram_hold_on",
      };
    }
    if (action === "off") {
      if (!this.config.hold) {
        return { reply: "HOLD is already OFF. Writes from Telegram are allowed.", event: "telegram_hold_off" };
      }
      this.pendingHoldOff.set(userId, this.now());
      return {
        reply: "HOLD is ON. Reply YES in your next message to turn HOLD off. Any other message cancels this. Turning HOLD off allows writes from Telegram again.",
        event: "telegram_hold_off_requested",
      };
    }
    return {
      reply: `HOLD is ${this.config.hold ? "ON" : "OFF"}. Use /hold on to turn it on at once, or /hold off and then reply YES to turn it off.`,
      event: "telegram_hold_status",
    };
  }

  private confirmHoldOff(): CommandOutcome {
    if (!this.config.hold) {
      return { reply: "HOLD is already OFF. Writes from Telegram are allowed.", event: "telegram_hold_off_confirmed" };
    }
    this.config.hold = false;
    saveConfig(this.config, this.rootDir);
    return {
      reply: "HOLD is now OFF. Writes from Telegram are allowed again, including packets, projects, models, and browser jobs.",
      event: "telegram_hold_off_confirmed",
    };
  }

  private handleBrowserStatus(): string {
    const statuses = listConnectionStatuses(this.ctx);
    if (statuses.length === 0) {
      return "No browser accounts yet. Add one with account-add on the command line, log in once by hand in that profile, then verify it with browser-connect.";
    }
    const lines = [`Browser connections: ${statuses.filter((s) => s.connected).length} of ${statuses.length} connected.`];
    for (const status of statuses) {
      lines.push(formatConnectionLine(status));
    }
    return lines.join("\n");
  }

  private handleAnalyticsStatus(): string {
    const state = readAnalyticsState(this.rootDir);
    return [
      "Analytics: OFF. Phase 1 is a dry-run preview only. The central service is not built yet, so nothing can be enabled and nothing is sent.",
      `Install id: ${state ? state.install_id : "not generated yet. Run /analytics_preview to generate it."} (a random id, not identity)`,
      `Payload version: ${PAYLOAD_VERSION}`,
      "Collector: ready. It reads local state only and counts, never sends.",
      `Last preview: ${state && state.last_preview_at ? state.last_preview_at : "never"}`,
      "Last send: never. Phase 1 sends nothing.",
    ].join("\n");
  }

  private handleAnalyticsPreview(): CommandOutcome {
    const payload = buildAnalyticsPayload(this.rootDir);
    recordPreview(this.rootDir);
    const text = `Analytics preview. Nothing was sent.\n${JSON.stringify(payload, null, 2)}\nThis payload is a dry run only. It was built from local counts, never left this machine, and holds no prompt text, results, project names, account labels, emails, or credentials.`;
    return { reply: text, event: "analytics_preview" };
  }

  private handleAudit(): string {
    const events = readAuditEvents(this.rootDir, this.ctx.tenantId);
    if (events.length === 0) {
      return "No audit events yet for this tenant.";
    }
    const lines = [`Audit events for tenant ${this.ctx.tenantId}: ${events.length}. Last 10:`];
    for (const event of events.slice(-10)) {
      lines.push(`${event.at} ${event.event} ${event.model || ""} ${event.result || ""}`.trim());
    }
    return lines.join("\n");
  }

  private handlePacket(args: string[]): CommandOutcome {
    const flags = parseFlags(args);
    const model = flags.model || "chatgpt";
    const taskType = flags.type || "seo";
    const title = flags.title || "Untitled task";
    const task = flags.task || "Write a clear draft for this task.";
    const projectId = flags.project || "";
    const route = routeTask(taskType);
    const policy = checkPolicy("draft", route.tier, this.config.hold);
    if (!policy.allowed) {
      return {
        reply: `Packet was not created. ${policy.reason}`,
        event: "telegram_packet_blocked",
        result: "blocked",
        model,
        taskType,
      };
    }
    let modelEntry;
    try {
      modelEntry = assertPacketAllowed(this.ctx, model);
    } catch (error) {
      return {
        reply: `Packet was not created. ${String(error).replace(/^Error: /, "")}`,
        event: "packet_blocked_model",
        result: "blocked",
        model,
        taskType,
        detail: `project:${projectId || "none"}`,
      };
    }
    if (!this.config.subscriptionEnabled) {
      return {
        reply: "Packet was not created. Subscription mode is off in config. Enable it before generating a packet.",
        event: "packet_blocked_model",
        result: "blocked",
        model,
        taskType,
      };
    }
    let projectContext: string | undefined;
    if (projectId) {
      try {
        const scope = scopeJobToProject(projectId, taskType, { rootDir: this.rootDir, hold: this.config.hold, tenantId: this.ctx.tenantId });
        projectContext = buildProjectContext(scope.project, taskType);
      } catch (error) {
        return {
          reply: `Packet was not created. ${String(error).replace(/^Error: /, "")}`,
          event: "packet_blocked_project_scope",
          result: "blocked",
          model,
          taskType,
          detail: `project:${projectId}`,
        };
      }
    }
    const result = generatePacket(
      {
        model: model as PacketModel,
        taskType,
        title,
        task,
        context: projectContext,
      },
      path.join(this.rootDir, "packets", this.ctx.tenantId),
    );
    return {
      reply: [
        `Packet created: ${result.filePath}`,
        `Route: ${route.taskType} -> ${route.slot}, primary ${route.primaryModel}, tier ${route.tier}`,
        `Next step: copy the packet into your own ${modelEntry.displayName} app at ${modelEntry.chatUrl}, run it, paste the result back to TrustyMUSE.`,
      ].join("\n"),
      event: "packet_generated",
      result: "ok",
      model,
      taskType,
      detail: projectId ? `project:${projectId} ${result.filePath}` : result.filePath,
    };
  }

  // One browser job through the shared queue, used by /run and by the
  // /do pipeline. The caller checks the gates first: HOLD, browser
  // mode, the wired-driver gate, and the connected-account gate. The
  // queue enforces one job at a time per account, pacing, the daily
  // limit, and retry once then pause. The account record is saved
  // afterwards, the same as run-browser on the command line: a paused
  // or challenged account loses its connected flag, because the last
  // job just disproved the connection. The prompt text is never put in
  // an audit event, and the result file path is returned, not logged.
  private async executeBrowserJob(
    account: BrowserAccount,
    model: string,
    taskType: string,
    title: string,
    task: string,
    projectId: string,
  ): Promise<BrowserJobOutcome> {
    let projectContext: string | undefined;
    if (projectId) {
      const scope = scopeJobToProject(projectId, taskType, { rootDir: this.rootDir, hold: this.config.hold, tenantId: this.ctx.tenantId });
      projectContext = buildProjectContext(scope.project, taskType);
    }
    const prompt = buildPacketContent({ model: model as PacketModel, taskType, title, task, context: projectContext });
    const driver = this.driverFactory(account);
    const result = await this.queue.run({ accountId: account.id, model, taskType, title, task }, account, driver, prompt);
    const allAccounts = loadAccounts(this.rootDir, this.ctx.tenantId);
    const saved = allAccounts.find((a) => a.id === account.id);
    if (saved) {
      saved.status = account.status;
      saved.enabled = account.enabled;
      saved.dailyCount = account.dailyCount;
      saved.dailyDate = account.dailyDate;
      saved.lastUsed = account.lastUsed;
      if (account.status === "paused" || account.status === "challenge") {
        saved.browserConnected = false;
        saved.browserDisconnectReason =
          account.status === "challenge"
            ? "Account paused after a challenge. Check it by hand, then run browser-connect again."
            : "Account paused after driver errors. Check it by hand, then run browser-connect again.";
      }
      saveAccounts(allAccounts, this.rootDir, this.ctx.tenantId);
    }
    if (!result.ok) {
      return {
        ok: false,
        text: "",
        attempts: result.attempts,
        reason: result.reason,
        paused: result.paused,
        filePath: null,
      };
    }
    const text = result.text || "";
    const resultsDir = path.join(this.rootDir, "browser-results", this.ctx.tenantId);
    fs.mkdirSync(resultsDir, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
    const outFile = path.join(resultsDir, `${model}-${account.id}-${slug}-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outFile, text + "\n", "utf-8");
    if (projectId) {
      markProjectUsed(projectId, this.rootDir, this.ctx.tenantId);
    }
    return { ok: true, text, attempts: result.attempts, reason: "Job finished.", paused: false, filePath: outFile };
  }

  // /run: one browser job on a connected account. Every gate from
  // run-browser applies, in the same order: HOLD, browser mode, wired
  // driver, account found, provider match, connected account. The
  // reply is the worker's own words, truncated to the Telegram limit.
  private async handleRun(args: string[]): Promise<CommandOutcome> {
    const flags = parseFlags(args);
    const accountId = flags.account || "";
    const task = flags.task || "";
    const taskType = flags.type || "seo";
    const title = flags.title || "Untitled task";
    const projectId = flags.project || "";
    if (!accountId || !task) {
      return {
        reply: "Usage: /run --account <id> --task \"<task>\" [--model <id>] [--type <type>] [--title \"<title>\"] [--project <id>]. The account must be connected first: run browser-connect on the command line.",
        event: "telegram_browser_job_blocked",
        result: "blocked",
      };
    }
    if (this.config.hold) {
      return {
        reply: "Browser job was not started. HOLD is on. All browser jobs are blocked until HOLD is lifted by the user.",
        event: "telegram_browser_job_blocked",
        result: "blocked",
        detail: `account:${oneLine(accountId, 40)}`,
      };
    }
    if (!this.config.browser.enabled) {
      return {
        reply: "Browser job was not started. Browser mode is OFF. Set browser.enabled to true in config.yaml after reading docs/V1-1-BROWSER-MODE.md. Packet mode is the fallback.",
        event: "telegram_browser_job_blocked",
        result: "blocked",
        detail: `account:${oneLine(accountId, 40)}`,
      };
    }
    const account = getAccount(accountId, this.rootDir, this.ctx.tenantId);
    if (!account) {
      return {
        reply: `Browser job was not started. Account ${oneLine(accountId, 40)} was not found. Use /account_list to see existing accounts.`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        detail: `account:${oneLine(accountId, 40)}`,
      };
    }
    const model = (flags.model || account.provider).toLowerCase();
    try {
      assertBrowserAllowed(model);
    } catch (error) {
      return {
        reply: `Browser job was not started. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        detail: `account:${accountId}`,
      };
    }
    if (account.provider !== model) {
      return {
        reply: `Browser job was not started. Account ${accountId} is a ${account.provider} account, but model is ${model}. Use the matching model.`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        detail: `account:${accountId}`,
      };
    }
    try {
      assertBrowserConnected(this.ctx, accountId);
    } catch (error) {
      return {
        reply: `Browser job was not started. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        detail: `account:${accountId}`,
      };
    }
    // Cloud guard, V2.3: a connected cloud account never reaches the
    // driver. Cloud jobs run from Muse through the cloud browser, never
    // from /run, and never fall back to a packet.
    const cloudRefusal = cloudJobRefusal(account, model);
    if (cloudRefusal) {
      return {
        reply: `Browser job was not started. ${cloudRefusal}`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        detail: `account:${accountId}`,
      };
    }
    let outcome: BrowserJobOutcome;
    try {
      outcome = await this.executeBrowserJob(account, model, taskType, title, task, projectId);
    } catch (error) {
      return {
        reply: `Browser job was not started. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        taskType,
        detail: `account:${accountId}`,
      };
    }
    if (!outcome.ok) {
      const pausedNote = outcome.paused ? " Account is paused. Check it by hand in your browser. Packet mode is the fallback." : "";
      return {
        reply: `Browser job did not finish. ${outcome.reason}${pausedNote}`,
        event: "telegram_browser_job_blocked",
        result: "blocked",
        model,
        taskType,
        detail: `account:${accountId}`,
      };
    }
    const check = validatePacketResult(outcome.text);
    const lines = [
      `Browser job finished in ${outcome.attempts} attempt(s). Valid: ${check.valid}. ${check.reason}`,
      `Result saved: ${outcome.filePath}`,
      "Review it before you use it. Publish, send, merge, and deploy are never automatic.",
      "",
      outcome.text,
    ];
    return {
      reply: lines.join("\n"),
      event: "telegram_browser_job_done",
      result: "ok",
      model,
      taskType,
      detail: `account:${accountId}`,
    };
  }

  // /do: plain words into harness work. No LLM call, only the parser
  // above. A pipeline runs the plan step and then the audit step on
  // their connected browser accounts when both exist; otherwise it
  // creates both packets and tells the user to run them. The other
  // patterns create one packet. /do never deploys: with deploy, live,
  // or publish words it reports the audit verdict and says the deploy
  // itself needs the user's approval in the Muse app.
  private async handleDo(instruction: string): Promise<CommandOutcome> {
    const plan = parseDoInstruction(instruction);
    if (!plan.taskText) {
      return {
        reply: "Usage: /do <instruction>. Examples: /do project trustytouch: write the pricing page draft. /do write a launch post with claude. /do plan with chatgpt then audit with claude: build a landing page. /do never deploys.",
        event: "telegram_do_blocked",
        result: "blocked",
      };
    }
    if (this.config.hold) {
      return {
        reply: "Nothing was done. HOLD is on. All writes are blocked until HOLD is lifted by the user.",
        event: "telegram_do_blocked",
        result: "blocked",
      };
    }
    if (plan.kind === "pipeline") {
      return this.handleDoPipeline(plan);
    }
    return this.handleDoPacket(plan);
  }

  private handleDoPacket(plan: DoPlan): CommandOutcome {
    const model = plan.model || "chatgpt";
    const taskType = "content";
    const title = plan.taskText.slice(0, 40) || "Untitled task";
    const task = plan.taskText;
    const route = routeTask(taskType);
    const policy = checkPolicy("draft", route.tier, this.config.hold);
    if (!policy.allowed) {
      return {
        reply: `Nothing was done. ${policy.reason}`,
        event: "telegram_do_blocked",
        result: "blocked",
        model,
        taskType,
      };
    }
    let modelEntry;
    try {
      modelEntry = assertPacketAllowed(this.ctx, model);
    } catch (error) {
      return {
        reply: `Nothing was done. ${String(error).replace(/^Error: /, "")}`,
        event: "telegram_do_blocked",
        result: "blocked",
        model,
        taskType,
      };
    }
    let projectContext: string | undefined;
    if (plan.projectId) {
      try {
        const scope = scopeJobToProject(plan.projectId, taskType, { rootDir: this.rootDir, hold: this.config.hold, tenantId: this.ctx.tenantId });
        projectContext = buildProjectContext(scope.project, taskType);
      } catch (error) {
        return {
          reply: `Nothing was done. ${String(error).replace(/^Error: /, "")}`,
          event: "telegram_do_blocked",
          result: "blocked",
          model,
          taskType,
          detail: `project:${plan.projectId}`,
        };
      }
    }
    const result = generatePacket(
      { model: model as PacketModel, taskType, title, task, context: projectContext },
      path.join(this.rootDir, "packets", this.ctx.tenantId),
    );
    const deployNote = plan.wantsDeploy
      ? " Nothing was deployed. The deploy itself needs your approval in the Muse app."
      : "";
    const scopeNote = plan.projectId ? ` Project: ${plan.projectId}.` : "";
    return {
      reply: [
        `Task created: ${result.filePath}`,
        `Model: ${modelEntry.displayName} (${model}), type ${taskType}.${scopeNote}`,
        `Next step: copy the packet into your own ${modelEntry.displayName} app at ${modelEntry.chatUrl}, run it, paste the result back to TrustyMUSE.${deployNote}`,
      ].join("\n"),
      event: "telegram_do_done",
      result: "ok",
      model,
      taskType,
      detail: plan.projectId ? `project:${plan.projectId}` : `model:${model}`,
    };
  }

  private async handleDoPipeline(plan: DoPlan): Promise<CommandOutcome> {
    const planModel = plan.planModel || "chatgpt";
    const auditModel = plan.auditModel || "claude";
    const detail = `plan:${planModel} audit:${auditModel}`;
    for (const model of [planModel, auditModel]) {
      try {
        assertPacketAllowed(this.ctx, model);
        assertBrowserAllowed(model);
      } catch (error) {
        return {
          reply: `Pipeline was not started. ${String(error).replace(/^Error: /, "")}`,
          event: "telegram_do_blocked",
          result: "blocked",
          detail,
        };
      }
    }
    const accounts = loadAccounts(this.rootDir, this.ctx.tenantId);
    // The driver only ever runs profile accounts, V2.3. A connected
    // cloud account is not a missing account: it runs through the
    // relay or the Muse app chat, not through /do, so it is named in
    // the packet fallback reply instead of being silently skipped.
    const planAccount = accounts.find(
      (a) => a.provider === planModel && a.source === "profile" && a.browserConnected === true && a.status === "active" && a.enabled,
    );
    const auditAccount = accounts.find(
      (a) => a.provider === auditModel && a.source === "profile" && a.browserConnected === true && a.status === "active" && a.enabled,
    );
    const planCloud = accounts.find(
      (a) => a.provider === planModel && a.source === "cloud" && a.browserConnected === true && a.status === "active" && a.enabled,
    );
    const auditCloud = accounts.find(
      (a) => a.provider === auditModel && a.source === "cloud" && a.browserConnected === true && a.status === "active" && a.enabled,
    );
    const cloudModels = [planCloud ? planModel : null, auditCloud ? auditModel : null].filter(Boolean);
    const cloudNote = cloudModels.length > 0
      ? ` A connected cloud browser account exists for ${cloudModels.join(" and ")}; cloud jobs run through the Telegram relay or the Muse app chat, not through /do.`
      : "";
    const shortTitle = plan.taskText.slice(0, 40) || "Untitled task";
    if (!planAccount || !auditAccount) {
      const missing = [!planAccount ? planModel : null, !auditAccount ? auditModel : null].filter(Boolean).join(" and ");
      const planPacket = generatePacket(
        { model: planModel as PacketModel, taskType: "research", title: `Plan: ${shortTitle}`, task: `Write a step-by-step plan for: ${plan.taskText}` },
        path.join(this.rootDir, "packets", this.ctx.tenantId),
      );
      const auditPacket = generatePacket(
        { model: auditModel as PacketModel, taskType: "code_review", title: `Audit: ${shortTitle}`, task: `Audit the plan for: ${plan.taskText}. List every problem, missing step, and wrong fact.` },
        path.join(this.rootDir, "packets", this.ctx.tenantId),
      );
      const deployNote = plan.wantsDeploy
        ? " Nothing was deployed. The audit has not run yet, so nothing is verified. The deploy itself needs your approval in the Muse app after the audit passes."
        : "";
      return {
        reply: [
          `No connected browser account for ${missing}, so the pipeline ran as packets, not as browser jobs.${cloudNote}`,
          `Plan packet: ${planPacket.filePath}`,
          `Audit packet: ${auditPacket.filePath}`,
          `Next step: run the plan packet in ${planModel}, paste the result back, then run the audit packet in ${auditModel}.${deployNote}`,
        ].join("\n"),
        event: "telegram_do_done",
        result: "ok",
        detail,
      };
    }
    const planOutcome = await this.executeBrowserJob(
      planAccount,
      planModel,
      "research",
      `Plan: ${shortTitle}`,
      `Write a step-by-step plan for: ${plan.taskText}`,
      "",
    );
    if (!planOutcome.ok) {
      return {
        reply: `Plan step failed: ${planOutcome.reason}. The audit did not run. Nothing was deployed.`,
        event: "telegram_do_blocked",
        result: "blocked",
        detail,
      };
    }
    const auditOutcome = await this.executeBrowserJob(
      auditAccount,
      auditModel,
      "code_review",
      `Audit: ${shortTitle}`,
      `Audit this plan and list every problem, missing step, and wrong fact. Plan:\n${planOutcome.text}`,
      "",
    );
    if (!auditOutcome.ok) {
      return {
        reply: `Plan is ready, audit failed: ${auditOutcome.reason}. Nothing was deployed. Plan result was saved to ${planOutcome.filePath}.`,
        event: "telegram_do_blocked",
        result: "blocked",
        detail,
      };
    }
    const passed = auditPassedByMarkers(auditOutcome.text);
    const deployVerdict = plan.wantsDeploy
      ? passed
        ? " Audit passed by the text-marker check. Ready to deploy, but the deploy itself needs your approval in the Muse app."
        : " Audit failed by the text-marker check. Not deploying."
      : "";
    const markerNote =
      "The audit verdict is a text-marker check on the audit reply, not a full verification. Read the audit below before you approve anything.";
    return {
      reply: [
        `Pipeline finished. Plan by ${planModel}, audit by ${auditModel}.${deployVerdict}`,
        markerNote,
        "",
        "Audit result:",
        auditOutcome.text,
        "",
        "Plan result:",
        planOutcome.text,
      ].join("\n"),
      event: "telegram_do_done",
      result: passed ? "ok" : "invalid",
      detail,
    };
  }
}

export function createTelegramBot(options: TelegramBotOptions): TelegramBot {
  return new TelegramBot(options);
}

// Load the harness config. Exported for the CLI telegram commands that
// run before any tenant is resolved, so they share the same loader.
export function loadTelegramConfig(rootDir: string): HarnessConfig {
  return loadConfig(rootDir);
}

// The task types the bot accepts for /packet. Exported for tests and
// docs, so the accepted list is one shared source with the router.
export function telegramTaskTypes(): string[] {
  return [...TASK_TYPES];
}

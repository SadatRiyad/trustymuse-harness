// Telegram Bot control, V1.9. The harness is controlled from Telegram
// through a bot the user creates with @BotFather. The bot answers
// read-only commands for any allowlisted user, and creates draft packets
// only. It never sends, publishes, merges, or deploys anything, and it
// never runs a browser job: /run_browser is refused, browser jobs run
// from the CLI only. See docs/V1-9-TELEGRAM-BOT.md.
//
// Safety rules, in order:
// - The bot token comes only from the environment variable
//   TELEGRAM_BOT_TOKEN. It is never read from a file, never logged, and
//   never printed. Starting the bot without a token refuses.
// - Only Telegram user ids on the allowlist in gitignored
//   state/telegram.json get any reply. A non-allowlisted id gets no
//   reply at all. The attempt is audit logged, and the bot process
//   prints the id once per minute so the owner can allowlist it.
// - HOLD blocks all Telegram writes, including packet creation.
// - Budget cap 0 still blocks paid API calls. The bot never places an
//   API call and never spends budget.
// - Per-user rate limit: 20 commands per minute, then a polite
//   slow-down reply.
// - Every handled Telegram command writes exactly one audit event per
//   tenant, with the numeric Telegram user id only, never a username or
//   a name unless the owner gave that user a label in the allowlist.
// - Telegram message text is capped at 4000 characters, under the
//   platform limit of 4096.

import * as fs from "node:fs";
import * as path from "node:path";
import { appendAudit, newRunId, readAuditEvents } from "../audit";
import { BudgetTracker } from "../budget";
import { loadConfig, HarnessConfig } from "../config";
import { checkPolicy } from "../policy";
import { getModel, listModels } from "../registry";
import { routeTask, TASK_TYPES } from "../router";
import { buildPacketContent, generatePacket, PacketModel } from "../packet";
import {
  assertPacketAllowed,
  CONNECTED_LEGEND,
  isModelConnected,
  listConnectedModels,
} from "../models/connect";
import { buildProjectContext } from "../projects/context";
import { listProjects, scopeJobToProject } from "../projects/projects";
import { loadAccounts } from "../session/accounts";
import { formatConnectionLine, listConnectionStatuses } from "../session/connection";
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

// The token comes only from the environment. It is never read from a
// file, and this message never contains a token: it only names the
// variable to set and the bot to create it with.
export function requireTelegramToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = (env[TELEGRAM_TOKEN_ENV] || "").trim();
  if (!token) {
    throw new Error(
      "No Telegram bot token found. Create a bot with @BotFather in Telegram, copy the token it gives you, then set TELEGRAM_BOT_TOKEN in the environment before starting the bot. Never put the token in a file, in config.yaml, or in chat.",
    );
  }
  return token;
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
    const result = await this.call("getUpdates", body, (timeoutSeconds + 10) * 1000);
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
// Allowlist. Install-wide, in gitignored state/telegram.json. Only the
// numeric user id and an owner-given label are stored. No username, no
// name from Telegram, no token, no credential of any kind. The file is
// rejected on load when it holds a secret-like field, the same rule the
// account, tenant, and project registries use.
// ---------------------------------------------------------------------------

export interface TelegramAllowEntry {
  id: number;
  label: string;
  addedAt: string;
}

export function telegramFilePath(rootDir: string): string {
  return path.join(rootDir, "state", "telegram.json");
}

const SECRET_FIELD_NAMES = new Set(["password", "token", "secret", "apikey", "sessiontoken", "cookie"]);

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
  const file = telegramFilePath(rootDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    throw new Error("Telegram allowlist is corrupt: it is not valid JSON. Check the file by hand first.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Telegram allowlist is corrupt: it must hold an object with a users list.");
  }
  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users)) {
    throw new Error("Telegram allowlist is corrupt: it must hold a users list.");
  }
  assertNoSecretFields(parsed, "Telegram allowlist");
  const seen = new Set<number>();
  const clean: TelegramAllowEntry[] = [];
  for (const entry of users) {
    const valid = assertValidAllowEntry(entry);
    if (!seen.has(valid.id)) {
      seen.add(valid.id);
      clean.push(valid);
    }
  }
  return clean;
}

function saveAllowlist(rootDir: string, entries: TelegramAllowEntry[]): void {
  assertNoSecretFields({ users: entries }, "Telegram allowlist");
  const dir = path.join(rootDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(telegramFilePath(rootDir), JSON.stringify({ users: entries }, null, 2) + "\n", "utf-8");
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
  "/status - harness version, tenant, HOLD, budget, models, browser accounts",
  "/models - subscription models and which are connected",
  "/projects - connected projects",
  "/browser_status - browser accounts and their connection state",
  "/analytics_status - analytics off or on, install id, last send",
  "/analytics_preview - the counts-only payload, nothing is sent",
  "/audit - the last 10 audit events",
  "/packet --model <id> --type <type> --title \"<title>\" --task \"<task>\" - create a draft packet only",
  "Browser jobs run from the CLI only. /run_browser is refused here.",
  "Connected means packet mode only, not a live login, token, or call.",
].join("\n");

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
}

interface CommandOutcome {
  reply: string;
  event: string;
  result?: "ok" | "blocked" | "valid" | "invalid";
  model?: string;
  taskType?: string;
  detail?: string;
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
  private commandTimes = new Map<number, number[]>();
  private unauthorizedLoggedAt = new Map<number, number>();

  constructor(options: TelegramBotOptions) {
    this.rootDir = options.rootDir;
    this.ctx = options.ctx;
    this.config = options.config;
    this.api = options.api;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.now = options.now ?? (() => Date.now());
  }

  stop(): void {
    this.stopped = true;
  }

  async pollOnce(): Promise<void> {
    const updates = await this.api.getUpdates(this.offset, this.pollTimeoutSeconds);
    for (const update of updates) {
      this.offset = update.update_id + 1;
      try {
        await this.handleUpdate(update);
      } catch (error) {
        console.log(`Telegram bot: one update failed and was skipped. ${String(error).replace(/^Error: /, "")}`);
      }
    }
  }

  async run(): Promise<void> {
    const onSignal = (): void => {
      this.stopped = true;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          console.log(`Telegram bot: poll failed, retrying in 5 seconds. ${String(error).replace(/^Error: /, "")}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    console.log("Telegram bot stopped.");
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
    if (!this.checkRateLimit(userId)) {
      await this.api.sendMessage(
        chatId,
        truncateForTelegram("Slow down: you sent too many commands in one minute. Wait a minute and try again."),
      );
      this.auditEvent({ reply: "", event: "telegram_rate_limited", result: "blocked" }, userId);
      return;
    }
    const outcome = await this.dispatch(userId, text);
    if (outcome.reply) {
      await this.api.sendMessage(chatId, truncateForTelegram(outcome.reply));
    }
    this.auditEvent(outcome, userId);
  }

  private async dispatch(userId: number, text: string): Promise<CommandOutcome> {
    if (!text.startsWith("/")) {
      return {
        reply: "I only answer commands. Send /help for the command list.",
        event: "telegram_unknown_command",
      };
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
        return { reply: this.handleProjects(), event: "telegram_projects" };
      case "browser_status":
        return { reply: this.handleBrowserStatus(), event: "browser_status_checked" };
      case "analytics_status":
        return { reply: this.handleAnalyticsStatus(), event: "analytics_status_checked" };
      case "analytics_preview":
        return this.handleAnalyticsPreview();
      case "audit":
        return { reply: this.handleAudit(), event: "telegram_audit" };
      case "packet":
        return this.handlePacket(args);
      case "run_browser":
        return {
          reply: "Browser jobs run from the CLI only. Use: node dist/index.js run-browser --model <id> --account <id> --type <type> --task \"<task>\". Telegram never runs a browser job in V1.9.",
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
      "Read-only commands work now. /packet creates a draft packet only, never sends or runs a browser job. HOLD blocks packet creation.",
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
      return "No projects connected yet. Add one with project-add on the command line.";
    }
    const lines = [`Connected projects: ${projects.length}`];
    for (const project of projects) {
      lines.push(`  ${project.id} (${project.name}, ${project.kind}, ${project.status})`);
    }
    return lines.join("\n");
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

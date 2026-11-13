#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { loadConfig, saveConfig } from "./config";
import { BudgetTracker } from "./budget";
import { appendAudit, newRunId, readAuditEvents } from "./audit";
import { checkPolicy } from "./policy";
import { getModel, listModels, listSubscriptionModels } from "./registry";
import { listRoutes, routeTask } from "./router";
import {
  assertBrowserAllowed,
  assertPacketAllowed,
  CONNECTED_LEGEND,
  connectModel,
  disconnectModel,
  isModelConnected,
  listConnectedModels,
} from "./models/connect";
import { buildPacketContent, generatePacket, PacketModel, validatePacketResult } from "./packet";
import { OpenAiAdapter } from "./adapters/openai";
import { AnthropicAdapter } from "./adapters/anthropic";
import { GeminiAdapter } from "./adapters/gemini";
import { addAccount, getAccount, loadAccounts, saveAccounts } from "./session/accounts";
import { MockBrowserDriver, PlaywrightBrowserDriver } from "./session/browser";
import { BrowserQueue } from "./session/queue";
import {
  assertBrowserConnected,
  connectBrowser,
  disconnectBrowser,
  formatConnectionLine,
  listConnectionStatuses,
} from "./session/connection";
import {
  addProject,
  assertProjectWriteAllowed,
  getProject,
  listProjects,
  markProjectUsed,
  pauseProject,
  removeProject,
  scopeJobToProject,
} from "./projects/projects";
import { discoverProjects } from "./projects/discover";
import { buildProjectContext } from "./projects/context";
import {
  MIGRATION_TENANT_ID,
  addTenant,
  getTenant,
  listTenants,
  migrateTenants,
  pauseTenant,
  removeTenant,
  setTenantStatus,
  setupTenant,
} from "./tenants/tenants";
import { createTenantContext, tenantCapUsd, TenantContext } from "./tenants/context";
import {
  buildAnalyticsPayload,
  PAYLOAD_VERSION,
  readAnalyticsState,
  recordPreview,
} from "./analytics/collector";
import {
  allowTelegramUser,
  clearTelegramFileToken,
  createTelegramBot,
  denyTelegramUser,
  getTelegramTokenSource,
  loadAllowlist,
  requireTelegramToken,
  TelegramHttpApi,
} from "./telegram/bot";

// TrustyMUSE Harness V2.0 CLI. Local only, multi-tenant.
// V2.0 adds full Telegram control (see docs/V2-0-TELEGRAM-FULL-CONTROL.md).
// The bot answers read-only commands for allowlisted users, runs the
// write commands the harness offers, runs one browser job at a time on
// a connected account with /run, and parses plain-language /do
// instructions into packets or a plan-then-audit pipeline. It never
// deploys, publishes, merges, or sends anything. The token comes from
// TELEGRAM_BOT_TOKEN first, then from the file token in gitignored
// state/telegram.json, so the TrustyHarness panel can later write it
// there from a box.
// V1.9 adds Telegram Bot control (see docs/V1-9-TELEGRAM-BOT.md).
// V1.8 adds Analytics Phase 1: a local collector with a dry-run preview
// only (see docs/V1-8-ANALYTICS-PHASE-1.md). analytics-preview prints the
// exact payload that would be sent and sends nothing. There is no
// sending code yet, and the central service does not exist, so
// analytics-enable is refused until Phase 2.
// V1.7 removes the auto-seed: a fresh tenant starts with zero connected
// models, and a model connects only through an explicit model-connect
// (see docs/V1-7-CONNECTED-MEANS.md). V1.6 adds browser Connect and
// Disconnect per account (see docs/V1-6-BROWSER-CONNECT.md). Every major chat AI has a subscription
// Connect button in V1.5: chatgpt,
// claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral.
// Packet mode works for every connected subscription model at once. The
// browser driver stays wired only for chatgpt and claude; every other
// model is packet-only until its driver is wired with live verified
// selectors, exactly like V1.2. See docs/V1-5-MODELS.md.
// One install, many tenants. One tenant is one Muse account, fully
// isolated: its own state, budget, accounts, projects, profiles, and
// audit log under state/tenants/<tenantId>/ and profiles/<tenantId>/.
// Only the code is shared. There is no central server and no public Muse
// account API in V1.4. See docs/V1-4-MULTI-TENANT.md.
// Commands:
//   node dist/index.js status [--tenant <id>]
//   node dist/index.js packet --model chatgpt --type seo --title "My task" --task "Write a draft." [--project my-project] [--tenant <id>]
//   node dist/index.js check-api --provider openai [--tenant <id>]
//   node dist/index.js audit [--tenant <id>]
//   node dist/index.js account-add --provider chatgpt --id main --label "Main ChatGPT" [--tenant <id>]
//   node dist/index.js account-list [--tenant <id>]
//   node dist/index.js browser-connect --account main [--tenant <id>]
//   node dist/index.js browser-disconnect --account main [--reason "..."] [--tenant <id>]
//   node dist/index.js browser-status [--tenant <id>]
//   node dist/index.js session-status [--tenant <id>]
//   node dist/index.js run-browser --model chatgpt --account main --type seo --task "Write a draft." [--project my-project] [--tenant <id>]
//   node dist/index.js project-add --id my-project --name "My Project" --kind web-app --path ~/workspace/my-project [--tenant <id>]
//   node dist/index.js project-list [--tenant <id>]
//   node dist/index.js project-show --id my-project [--tenant <id>]
//   node dist/index.js project-remove --id my-project [--tenant <id>]
//   node dist/index.js project-pause --id my-project [--tenant <id>]
//   node dist/index.js project-discover
//   node dist/index.js project-status [--tenant <id>]
//   node dist/index.js tenant-add --id <id> --name "<Name>" [--label "<label>"] [--cap 0]
//   node dist/index.js tenant-list
//   node dist/index.js tenant-status [--tenant <id>]
//   node dist/index.js tenant-use --id <id>
//   node dist/index.js tenant-pause --id <id>
//   node dist/index.js tenant-remove --id <id>
//   node dist/index.js tenant-migrate
//   node dist/index.js setup --id <id> --name "<Name>"
//   node dist/index.js telegram-allow --user-id <id> --label "<Name>"
//   node dist/index.js telegram-token-status
//   node dist/index.js telegram-token-clear
//   node dist/index.js telegram-deny --user-id <id>
//   node dist/index.js telegram-allowlist
//   node dist/index.js telegram-link
//   node dist/index.js telegram-start [--tenant <id>]
// Browser mode is off by default. See docs/V1-1-BROWSER-MODE.md before you turn it on.
// Projects are scopes only. Connecting a project never deploys or publishes it.

function getArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  return fallback;
}

function printHelp(): void {
  console.log("TrustyMUSE Harness V2.0");
  console.log("Usage:");
  console.log("  node dist/index.js status [--tenant <id>]");
  console.log("  node dist/index.js packet --model chatgpt --type seo --title \"Title\" --task \"Task text\" [--project my-project] [--tenant <id>]");
  console.log("  node dist/index.js check-api --provider openai [--tenant <id>]");
  console.log("  node dist/index.js audit [--tenant <id>]");
  console.log("  node dist/index.js account-add --provider chatgpt --id main --label \"Main ChatGPT\" [--tenant <id>]");
  console.log("  node dist/index.js account-list [--tenant <id>]");
  console.log("  node dist/index.js browser-connect --account main [--tenant <id>]");
  console.log("  node dist/index.js browser-disconnect --account main [--reason \"...\"] [--tenant <id>]");
  console.log("  node dist/index.js browser-status [--tenant <id>]");
  console.log("  node dist/index.js session-status [--tenant <id>]");
  console.log("  node dist/index.js run-browser --model chatgpt --account main --type seo --task \"Task text\" [--project my-project] [--tenant <id>]");
  console.log("  node dist/index.js project-add --id my-project --name \"My Project\" --kind web-app --path ~/workspace/my-project [--live-url https://example.com] [--repo owner/repo] [--stack \"Node.js\"] [--tasks seo,blog] [--notes \"...\"] [--tenant <id>]");
  console.log("  node dist/index.js project-list [--tenant <id>]");
  console.log("  node dist/index.js project-show --id my-project [--tenant <id>]");
  console.log("  node dist/index.js project-remove --id my-project [--tenant <id>]");
  console.log("  node dist/index.js project-pause --id my-project [--tenant <id>]");
  console.log("  node dist/index.js project-discover");
  console.log("  node dist/index.js project-status [--tenant <id>]");
  console.log("  node dist/index.js tenant-add --id <id> --name \"<Name>\" [--label \"<label>\"] [--cap 0]");
  console.log("  node dist/index.js tenant-list");
  console.log("  node dist/index.js tenant-status [--tenant <id>]");
  console.log("  node dist/index.js tenant-use --id <id>");
  console.log("  node dist/index.js tenant-pause --id <id>");
  console.log("  node dist/index.js tenant-remove --id <id>");
  console.log("  node dist/index.js tenant-migrate");
  console.log("  node dist/index.js setup --id <id> --name \"<Name>\"");
  console.log("  node dist/index.js model-list [--tenant <id>]");
  console.log("  node dist/index.js model-connect --model gemini [--tenant <id>]");
  console.log("  node dist/index.js model-disconnect --model gemini [--tenant <id>]");
  console.log("  node dist/index.js analytics-preview [--tenant <id>]");
  console.log("  node dist/index.js analytics-status [--tenant <id>]");
  console.log("  node dist/index.js analytics-enable [--tenant <id>]");
  console.log("  node dist/index.js analytics-disable [--tenant <id>]");
  console.log("  node dist/index.js telegram-allow --user-id <id> --label \"<Name>\"");
  console.log("  node dist/index.js telegram-deny --user-id <id>");
  console.log("  node dist/index.js telegram-allowlist");
  console.log("  node dist/index.js telegram-link");
  console.log("  node dist/index.js telegram-token-status");
  console.log("  node dist/index.js telegram-token-clear");
  console.log("  node dist/index.js telegram-start [--tenant <id>]");
  console.log("");
  console.log("Modes: subscription is on by default. API is off by default and blocked when budget cap is 0.");
  console.log("Models: 9 subscription models (chatgpt, claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral). Packet mode works for every connected one. Browser driver is wired only for chatgpt and claude; the rest are packet-only.");
  console.log("Analytics: Phase 1 is a dry-run preview only. analytics-preview prints the exact payload that would be sent and sends nothing. The central service is not built yet, so analytics-enable is refused until Phase 2.");
  console.log("Telegram: full control from Telegram with telegram-start. The token comes from TELEGRAM_BOT_TOKEN first, then from the file token in state/telegram.json, which the TrustyHarness panel box will write. Only allowlisted user ids get a reply. /run runs one browser job on a connected account, /do takes plain words. Nothing here ever deploys. See docs/V2-0-TELEGRAM-FULL-CONTROL.md.");
  console.log("Browser mode is off by default. Read docs/V1-1-BROWSER-MODE.md before you turn it on.");
  console.log("Projects: connect any running or new project with project-add. Jobs scoped with --project are draft only.");
  console.log("Tenants: one tenant is one Muse account. Tenant is resolved from --tenant, then TRUSTYMUSE_TENANT, then tenants.default in config.yaml, then \"default\".");
}

// Resolve the active tenant for a state-touching command. Fail closed:
// an unknown, paused, or corrupt tenant stops the command before any
// state is read or written, and the message says so.
function resolveContext(args: string[], config: ReturnType<typeof loadConfig>, rootDir: string): TenantContext | null {
  try {
    return createTenantContext(rootDir, config, { flag: getArg(args, "--tenant", "") });
  } catch (error) {
    console.log(`Tenant check failed. ${String(error).replace(/^Error: /, "")}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  const runId = newRunId();
  const config = loadConfig();
  const rootDir = path.resolve(__dirname, "..");

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // Tenant management commands. They work on the registry, not on a
  // tenant's state, so they do not resolve an active tenant first.
  if (command === "tenant-add") {
    const id = getArg(args, "--id", "");
    const name = getArg(args, "--name", "");
    const label = getArg(args, "--label", "");
    const capRaw = getArg(args, "--cap", "");
    if (!id || !name) {
      console.log("Usage: node dist/index.js tenant-add --id <id> --name \"<Name>\" [--label \"<label>\"] [--cap 0]");
      console.log("Tenant id is a lowercase slug, 3 to 40 characters, for example jane-doe. No password or key is asked for.");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Tenant writes are blocked until HOLD is lifted by the user.");
      return;
    }
    try {
      const cap = capRaw === "" ? 0 : Number(capRaw);
      const tenant = addTenant(
        { id, displayName: name, museAccountLabel: label || undefined, monthlyCapUsd: cap },
        { rootDir, maxTenants: config.tenants.maxTenants },
      );
      console.log(`Tenant created: ${tenant.id} (${tenant.displayName}, label ${tenant.museAccountLabel}, cap ${tenant.monthlyCapUsd} USD, ${tenant.status})`);
      console.log(`State: state/tenants/${tenant.id}/, profiles: profiles/${tenant.id}/`);
      console.log(`Next step: node dist/index.js tenant-use --id ${tenant.id} to make it the default tenant, or pass --tenant ${tenant.id} on each command.`);
    } catch (error) {
      console.log(`Tenant was not created. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "tenant-list") {
    const tenants = listTenants(rootDir);
    if (tenants.length === 0) {
      console.log("No tenants yet. Create one with tenant-add, or run setup for a first-run wizard.");
      return;
    }
    console.log(`Tenants: ${tenants.length} (max ${config.tenants.maxTenants}), default ${config.tenants.defaultTenant}`);
    for (const tenant of tenants) {
      console.log(`  ${tenant.id} (${tenant.displayName}, label ${tenant.museAccountLabel}, ${tenant.status}, cap ${tenant.monthlyCapUsd} USD, created ${tenant.createdAt}, last used ${tenant.lastUsed || "never"})`);
    }
    return;
  }

  if (command === "tenant-use") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js tenant-use --id <id>");
      return;
    }
    const tenant = getTenant(id, rootDir);
    if (!tenant) {
      console.log(`Tenant ${id} was not found. Use tenant-list to see existing tenants.`);
      return;
    }
    if (tenant.status !== "active") {
      console.log(`Tenant ${id} is ${tenant.status}. Only active tenants can be the default.`);
      return;
    }
    config.tenants.defaultTenant = tenant.id;
    saveConfig(config, rootDir);
    console.log(`Default tenant is now ${tenant.id} (${tenant.displayName}). Saved to config.yaml.`);
    return;
  }

  if (command === "tenant-pause") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js tenant-pause --id <id>");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Tenant writes are blocked until HOLD is lifted by the user.");
      return;
    }
    try {
      const paused = pauseTenant(id, rootDir);
      console.log(`Tenant paused: ${paused.id} (${paused.displayName}). Paused tenants cannot run commands until they are active again.`);
    } catch (error) {
      console.log(`Tenant was not paused. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "tenant-remove") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js tenant-remove --id <id>");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Tenant writes are blocked until HOLD is lifted by the user.");
      return;
    }
    try {
      const removed = removeTenant(id, rootDir);
      console.log(`Tenant removed: ${removed.id} (${removed.displayName}). Its state directory was removed. Other tenants were not touched.`);
    } catch (error) {
      console.log(`Tenant was not removed. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "tenant-migrate") {
    if (config.hold) {
      console.log("HOLD is on. Migration is blocked until HOLD is lifted by the user.");
      return;
    }
    const before = readAuditEvents(rootDir).length;
    const result = migrateTenants(rootDir);
    console.log(result.reason);
    console.log(`Projects moved: ${result.projectsMoved}, audit events moved: ${result.auditEventsMoved}, accounts moved: ${result.accountsMoved}, usage moved: ${result.usageMoved}, profiles moved: ${result.profilesMoved}`);
    if (result.backupDir) {
      console.log(`Originals archived under: ${result.backupDir}`);
    }
    if (result.migrated) {
      const tenant = getTenant(result.tenantId, rootDir);
      if (tenant) {
        config.tenants.defaultTenant = tenant.id;
        saveConfig(config, rootDir);
        console.log(`Default tenant is now ${tenant.id}. Saved to config.yaml.`);
        appendAudit(
          { at: new Date().toISOString(), runId, event: "tenant_migrated", detail: `tenant:${tenant.id} audit_before:${before}`, result: "ok" },
          rootDir,
          tenant.id,
        );
        const after = readAuditEvents(rootDir, tenant.id).length;
        console.log(`Audit events before migration: ${before}, in tenant ${tenant.id} after migration: ${after}.`);
      }
    }
    return;
  }

  if (command === "setup") {
    const id = getArg(args, "--id", "");
    const name = getArg(args, "--name", "");
    const label = getArg(args, "--label", "");
    if (!id || !name) {
      console.log("Usage: node dist/index.js setup --id <id> --name \"<Name>\" [--label \"<label>\"]");
      console.log("Setup creates a tenant and a config.yaml when one is missing. It never asks for a password or a key.");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Setup is blocked until HOLD is lifted by the user.");
      return;
    }
    const configPath = path.join(rootDir, "config.yaml");
    const examplePath = path.join(rootDir, "config.example.yaml");
    if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
      console.log("Created config.yaml from config.example.yaml.");
    }
    const existing = getTenant(id, rootDir);
    if (existing) {
      console.log(`Tenant ${id} already exists (${existing.displayName}, ${existing.status}). Setup changes nothing.`);
    } else {
      try {
        const { tenant, steps } = setupTenant(
          { id, displayName: name, museAccountLabel: label || undefined },
          { rootDir, maxTenants: config.tenants.maxTenants },
        );
        const fresh = loadConfig(rootDir);
        fresh.tenants.defaultTenant = tenant.id;
        saveConfig(fresh, rootDir);
        console.log(`Tenant created: ${tenant.id} (${tenant.displayName}). Default tenant saved to config.yaml.`);
        console.log("Next steps:");
        for (const [index, step] of steps.entries()) {
          console.log(`  ${index + 1}. ${step}`);
        }
      } catch (error) {
        console.log(`Setup failed. ${String(error).replace(/^Error: /, "")}`);
      }
    }
    return;
  }

  if (command === "project-discover") {
    const candidates = discoverProjects();
    if (candidates.length === 0) {
      console.log("No project candidates found in ~/workspace or ~/workspace/github-repos.");
      return;
    }
    console.log(`Project candidates found: ${candidates.length}. Discovery is read only. Nothing was connected.`);
    for (const candidate of candidates) {
      console.log(`  ${candidate.suggestedId} (${candidate.kind}, stack ${candidate.stack})`);
      console.log(`    Root: ${candidate.rootPath}`);
      console.log(`    Signals: ${candidate.signals.join(", ")}. ${candidate.reason}`);
      console.log(`    Connect with: project-add --id ${candidate.suggestedId} --name "${candidate.suggestedName}" --kind ${candidate.kind} --path ${candidate.rootPath}`);
    }
    return;
  }

  // Telegram allowlist commands. The allowlist is install-wide in
  // gitignored state/telegram.json, not per tenant, so these commands do
  // not resolve a tenant first. Only the numeric user id and an
  // owner-given label are stored. No username, no token, no credential.
  if (command === "telegram-allow") {
    const userIdRaw = getArg(args, "--user-id", "");
    const label = getArg(args, "--label", "");
    if (!userIdRaw || !label) {
      console.log("Usage: node dist/index.js telegram-allow --user-id <id> --label \"<Name>\"");
      console.log("The user id is the numeric Telegram user id. Send /start to the bot first: the bot prints the id in the terminal where it runs when an unknown user tries it.");
      return;
    }
    const userId = Number(userIdRaw);
    try {
      const entries = allowTelegramUser(rootDir, userId, label);
      console.log(`Telegram user allowlisted: ${userId} (${label}). ${entries.length} user(s) on the allowlist.`);
      console.log("That user can now send /start to the bot and get a reply. Anyone else gets no reply at all.");
    } catch (error) {
      console.log(`Telegram user was not allowlisted. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "telegram-deny") {
    const userIdRaw = getArg(args, "--user-id", "");
    if (!userIdRaw) {
      console.log("Usage: node dist/index.js telegram-deny --user-id <id>");
      return;
    }
    const userId = Number(userIdRaw);
    try {
      const removed = denyTelegramUser(rootDir, userId);
      if (removed) {
        console.log(`Telegram user removed from the allowlist: ${userId}. That user gets no reply from the bot any more.`);
      } else {
        console.log(`Telegram user ${userId} was not on the allowlist. Nothing changed.`);
      }
    } catch (error) {
      console.log(`Telegram user was not removed. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "telegram-allowlist") {
    const entries = loadAllowlist(rootDir);
    if (entries.length === 0) {
      console.log("Telegram allowlist is empty. No Telegram user gets a reply yet.");
      console.log("Add one with: node dist/index.js telegram-allow --user-id <id> --label \"<Name>\"");
      return;
    }
    console.log(`Telegram allowlist: ${entries.length} user(s). Only these ids get a reply from the bot.`);
    for (const entry of entries) {
      console.log(`  ${entry.id} (${entry.label}, added ${entry.addedAt})`);
    }
    return;
  }

  if (command === "telegram-link") {
    console.log("Connect Telegram to the harness:");
    console.log("  1. Open Telegram and talk to @BotFather. Send /newbot, give it a name and a username, and copy the token it gives you.");
    console.log("  2. Set the token in the environment: export TELEGRAM_BOT_TOKEN=<token from @BotFather>. Or save it from the TrustyHarness panel box, which writes the file token in state/telegram.json. The environment token wins when both are set.");
    console.log("  3. Start the bot: node dist/index.js telegram-start [--tenant <id>]");
    console.log("  4. Send /start to your bot in Telegram. The bot will not reply yet, because you are not allowlisted.");
    console.log("  5. Read your numeric Telegram user id from the terminal where the bot runs. The bot prints it when an unknown user tries /start. It is also in the audit log as a telegram_unauthorized event.");
    console.log("  6. Allowlist yourself: node dist/index.js telegram-allow --user-id <id> --label \"<Your name>\"");
    console.log("  7. Send /start to the bot again. Now it replies. Send /help for the command list.");
    console.log("Check the token any time with telegram-token-status. It prints only set or not set, never the token. Remove the file token with telegram-token-clear. Stop the bot any time with Ctrl+C, and remove a user any time with telegram-deny.");
    return;
  }

  // Telegram token status and clear. The token value is never printed:
  // status prints only set or not set, and the source, env or file.
  if (command === "telegram-token-status") {
    const source = getTelegramTokenSource(rootDir, process.env);
    if (source.set) {
      console.log(`Telegram bot token: set (source: ${source.source}). The value is never printed.`);
      if (source.source === "env") {
        console.log("The environment token wins over the file token when both are set.");
      }
    } else {
      console.log("Telegram bot token: not set. Set TELEGRAM_BOT_TOKEN in the environment, or save the token from the TrustyHarness panel box.");
    }
    return;
  }

  if (command === "telegram-token-clear") {
    const removed = clearTelegramFileToken(rootDir);
    if (removed) {
      console.log("Telegram file token removed from state/telegram.json. The allowlist was kept. The bot will refuse to start until a token is set again.");
    } else {
      console.log("No Telegram file token was set. Nothing changed. The environment token, when set, is untouched.");
    }
    return;
  }

  // Every remaining command is tenant-scoped. Resolve the tenant first;
  // an unknown, paused, or corrupt tenant stops the command here.
  const ctx = resolveContext(args, config, rootDir);
  if (!ctx) {
    return;
  }
  const tenantId = ctx.tenantId;
  const budget = new BudgetTracker(tenantCapUsd(ctx.tenant, config), config.warnAtPercent, rootDir, tenantId);
  const tenantCount = listTenants(rootDir).length;

  if (command === "tenant-status") {
    const status = budget.getStatus();
    const projects = listProjects(rootDir, tenantId);
    const accounts = loadAccounts(rootDir, tenantId);
    const events = readAuditEvents(rootDir, tenantId);
    console.log(`Tenant: ${ctx.tenant.displayName} (${ctx.tenant.id}, label ${ctx.tenant.museAccountLabel}, ${ctx.tenant.status})`);
    console.log(`State: ${ctx.stateDir}`);
    console.log(`Profiles: ${ctx.profileRoot}`);
    console.log(`Budget: cap ${status.capUsd} ${config.currency}, used ${status.usedUsd}, remaining ${status.remainingUsd}, month ${status.month}${status.blocked ? ", BLOCKED (cap is 0)" : ""}`);
    console.log(`Projects: ${projects.length} connected, accounts: ${accounts.length}, audit events: ${events.length}`);
    console.log(`Created: ${ctx.tenant.createdAt}, last used: ${ctx.tenant.lastUsed || "never"}`);
    return;
  }

  if (command === "status") {
    const status = budget.getStatus();
    console.log("TrustyMUSE Harness V2.0 status");
    console.log(`Tenant: ${ctx.tenant.displayName} (${ctx.tenant.id}), ${tenantCount} tenant(s) on this install`);
    console.log(`Mode: ${config.subscriptionEnabled ? "subscription" : "none"}${config.apiEnabled ? " + api" : ""}${config.browser.enabled ? " + browser" : ""}`);
    console.log(`Browser: ${config.browser.enabled ? "ENABLED (opt in)" : "OFF by default"}, headless ${config.browser.headless}, pacing ${config.browser.pacingMs} ms, daily limit ${config.browser.dailyLimitPerAccount} per account, max accounts ${config.browser.maxAccounts}`);
    const browserAccounts = loadAccounts(rootDir, tenantId);
    const connectedAccounts = browserAccounts.filter((a) => a.browserConnected === true).length;
    console.log(`Browser connections: ${connectedAccounts} of ${browserAccounts.length} account(s) connected. Connect one with browser-connect --account <id>, stop one with browser-disconnect --account <id>.`);
    const projects = listProjects(rootDir, tenantId);
    const activeProjects = projects.filter((p) => p.status === "active").length;
    console.log(`Projects: ${projects.length} connected (${activeProjects} active), max ${config.projects.maxProjects}`);
    console.log(`Budget: cap ${status.capUsd} ${config.currency}, used ${status.usedUsd}, remaining ${status.remainingUsd}, month ${status.month}`);
    if (status.blocked) {
      console.log("Budget: BLOCKED. Paid API calls are blocked because the cap is 0.");
    }
    if (status.warning) {
      console.log(`Budget: WARNING. Usage is at or above ${status.warnAtPercent} percent of the cap.`);
    }
    console.log(`Policy HOLD: ${config.hold ? "ON" : "OFF"}`);
    console.log("Models:");
    for (const model of listModels()) {
      const connected =
        model.connection === "subscription" ? (isModelConnected(ctx, model.id) ? "connected" : "not connected") : "-";
      console.log(`  ${model.id} (${model.provider}, ${model.connection}, ${model.costMode}, ${model.status}, browser ${model.browserSupport}, ${connected}${model.chatUrl ? `, ${model.chatUrl}` : ""})`);
    }
    const connectedModels = listConnectedModels(ctx);
    console.log(
      `Connected subscription models for tenant ${tenantId}: ${connectedModels.map((m) => m.id).join(", ") || "none"}. Packet mode works for every connected one. Browser driver is wired only for chatgpt and claude.`,
    );
    console.log(CONNECTED_LEGEND);
    console.log("Routes:");
    for (const route of listRoutes()) {
      console.log(`  ${route.taskType} -> ${route.slot}, primary ${route.primaryModel}, fallback ${route.fallbackModel}, tier ${route.tier}`);
    }
    appendAudit({ at: new Date().toISOString(), runId, event: "status_checked", result: "ok" }, rootDir, tenantId);
    return;
  }

  if (command === "packet") {
    const model = getArg(args, "--model", "chatgpt");
    const taskType = getArg(args, "--type", "seo");
    const title = getArg(args, "--title", "Untitled task");
    const task = getArg(args, "--task", "Write a clear draft for this task.");
    const context = getArg(args, "--context", "");
    const projectId = getArg(args, "--project", "");
    // Packet gate: any connected subscription model may run a packet.
    // Unknown, API, and unconnected models fail closed before any file
    // is written. The browser driver is a separate gate, in run-browser.
    let modelEntry;
    try {
      modelEntry = assertPacketAllowed(ctx, model);
    } catch (error) {
      console.log(`Packet was not created. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "packet_blocked_model", model, taskType, detail: `project:${projectId || "none"}`, result: "blocked" },
        rootDir,
        tenantId,
      );
      return;
    }
    if (!config.subscriptionEnabled) {
      console.log("Subscription mode is off in config. Enable it before generating a packet.");
      return;
    }
    let projectContext = context || undefined;
    if (projectId) {
      try {
        const scope = scopeJobToProject(projectId, taskType, { rootDir, hold: config.hold, tenantId });
        projectContext = buildProjectContext(scope.project, taskType);
        if (context) {
          projectContext = `${projectContext}\n\nExtra context from the user:\n${context}`;
        }
        console.log(`Project scope: ${scope.project.name} (${scope.project.id}, ${scope.project.kind}). Draft only, no publish, send, merge, or deploy.`);
      } catch (error) {
        console.log(`Packet was not created. ${String(error).replace(/^Error: /, "")}`);
        appendAudit(
          { at: new Date().toISOString(), runId, event: "packet_blocked_project_scope", model, taskType, detail: `project:${projectId}`, result: "blocked" },
          rootDir,
          tenantId,
        );
        return;
      }
    }
    const route = routeTask(taskType);
    const result = generatePacket(
      {
        model: model as PacketModel,
        taskType,
        title,
        task,
        context: projectContext,
      },
      path.join(rootDir, "packets", tenantId),
    );
    console.log(`Packet created: ${result.filePath}`);
    console.log(`Route: ${route.taskType} -> ${route.slot}, primary ${route.primaryModel}, tier ${route.tier}`);
    console.log(
      `Next step: copy the packet into your own ${modelEntry.displayName} app at ${modelEntry.chatUrl}, run it, paste the result back to TrustyMUSE.`,
    );
    appendAudit(
      { at: new Date().toISOString(), runId, event: "packet_generated", model, taskType, detail: projectId ? `project:${projectId} ${result.filePath}` : result.filePath, result: "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "check-api") {
    const provider = getArg(args, "--provider", "openai");
    const adapters = {
      openai: new OpenAiAdapter(),
      anthropic: new AnthropicAdapter(),
      gemini: new GeminiAdapter(),
    } as const;
    const adapter = (adapters as Record<string, typeof adapters.openai>)[provider];
    if (!adapter) {
      console.log("Provider must be openai, anthropic, or gemini.");
      return;
    }
    const result = await adapter.call({ prompt: "Test prompt.", taskType: "content", model: provider }, config, budget);
    console.log(`Provider: ${result.provider}, blocked: ${result.blocked}, ok: ${result.ok}`);
    console.log(`Reason: ${result.reason}`);
    appendAudit(
      { at: new Date().toISOString(), runId, event: "api_call_blocked", model: provider, detail: result.reason, result: result.blocked ? "blocked" : "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "audit") {
    const events = readAuditEvents(rootDir, tenantId);
    console.log(`Audit events for tenant ${tenantId}: ${events.length}`);
    for (const event of events.slice(-10)) {
      console.log(`${event.at} ${event.event} ${event.model || ""} ${event.result || ""}`);
    }
    return;
  }

  if (command === "validate-result") {
    const file = getArg(args, "--file", "");
    if (!file || !fs.existsSync(file)) {
      console.log("Provide a result file with --file path/to/result.txt");
      return;
    }
    const text = fs.readFileSync(file, "utf-8");
    const check = validatePacketResult(text);
    console.log(`Valid: ${check.valid}. ${check.reason}`);
    const policy = checkPolicy("draft", 1, config.hold);
    console.log(`Policy: ${policy.reason}`);
    appendAudit(
      { at: new Date().toISOString(), runId, event: "packet_result_validated", detail: file, result: check.valid ? "valid" : "invalid" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "account-add") {
    const provider = getArg(args, "--provider", "");
    const id = getArg(args, "--id", "");
    const label = getArg(args, "--label", "");
    if (!provider || !id || !label) {
      console.log("Usage: node dist/index.js account-add --provider chatgpt --id main --label \"Main ChatGPT\"");
      console.log("No password is asked for and no password is stored. Log in once by hand in the profile later.");
      return;
    }
    try {
      const account = addAccount(
        { provider, id, label },
        // Base profiles root only: addAccount appends the tenant id once
        // via tenantProfileRoot. Passing ctx.profileRoot here would append
        // it a second time (profiles/<tenant>/<tenant>/...).
        { rootDir, profileRoot: path.join(rootDir, "profiles"), maxAccounts: config.browser.maxAccounts, tenantId },
      );
      console.log(`Account added: ${account.id} (${account.provider}, ${account.label})`);
      console.log(`Profile dir: ${account.profileDir}`);
      console.log("Next step: log in once by hand in that profile, in your own browser. The harness never asks for your password.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "account_added", model: account.provider, detail: account.id, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Account was not added. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "account-list") {
    const accounts = loadAccounts(rootDir, tenantId);
    if (accounts.length === 0) {
      console.log("No browser accounts yet. Add one with account-add. No password is stored.");
      return;
    }
    console.log(`Browser accounts for tenant ${tenantId}: ${accounts.length}`);
    for (const account of accounts) {
      const connected = account.browserConnected === true ? `connected, verified ${account.browserLastVerified || "never"}` : "disconnected";
      console.log(`  ${account.id} (${account.provider}, ${account.label}, ${connected}, status ${account.status}, enabled ${account.enabled}, profile ${account.profileDir}, today ${account.dailyCount} jobs, last used ${account.lastUsed || "never"})`);
    }
    return;
  }

  if (command === "session-status") {
    console.log("TrustyMUSE Harness V2.0 browser session status");
    console.log(`Tenant: ${ctx.tenant.displayName} (${tenantId})`);
    console.log(`Browser mode: ${config.browser.enabled ? "ENABLED (opt in)" : "OFF by default"}`);
    console.log(`Headless: ${config.browser.headless}, profile root: ${ctx.profileRoot}`);
    console.log(`Pacing: ${config.browser.pacingMs} ms, daily limit: ${config.browser.dailyLimitPerAccount} per account, max accounts: ${config.browser.maxAccounts}`);
    console.log(`Policy HOLD: ${config.hold ? "ON" : "OFF"}`);
    const accounts = loadAccounts(rootDir, tenantId);
    if (accounts.length === 0) {
      console.log("No browser accounts yet. Packet mode stays as the fallback.");
      return;
    }
    for (const status of listConnectionStatuses(ctx)) {
      console.log(formatConnectionLine(status));
    }
    appendAudit({ at: new Date().toISOString(), runId, event: "session_status_checked", result: "ok" }, rootDir, tenantId);
    return;
  }

  if (command === "browser-connect") {
    const accountId = getArg(args, "--account", "");
    if (!accountId) {
      console.log("Usage: node dist/index.js browser-connect --account main [--tenant <id>]");
      console.log("Connect verifies the login by opening the account profile with the driver. It never types a password and never auto solves a challenge.");
      return;
    }
    const useMock = process.env.TRUSTYMUSE_BROWSER_MOCK === "1";
    const driver = useMock
      ? new MockBrowserDriver()
      : new PlaywrightBrowserDriver({ headless: config.browser.headless });
    try {
      const account = await connectBrowser(ctx, accountId, driver, { hold: config.hold });
      console.log(`Browser connected for tenant ${tenantId}: ${account.id} (${account.provider}, ${account.label}).`);
      console.log(`Verified at ${account.browserLastVerified}. The login was found in profile ${account.profileDir}.`);
      if (!config.browser.enabled) {
        console.log("Note: browser mode is OFF, so run-browser will still refuse jobs until you set browser.enabled to true in config.yaml.");
      }
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_connected", model: account.provider, detail: account.id, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Browser was not connected. ${String(error).replace(/^Error: /, "")}`);
      console.log("Packet mode stays the fallback. Log in once by hand in that profile, then run browser-connect again.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_connect_blocked", detail: accountId, result: "blocked" },
        rootDir,
        tenantId,
      );
    }
    return;
  }

  if (command === "browser-disconnect") {
    const accountId = getArg(args, "--account", "");
    const reason = getArg(args, "--reason", "");
    if (!accountId) {
      console.log("Usage: node dist/index.js browser-disconnect --account main [--reason \"...\"] [--tenant <id>]");
      console.log("Disconnect stops the harness from using the session. It never deletes the profile and never logs you out of the site.");
      return;
    }
    try {
      const account = disconnectBrowser(ctx, accountId, reason);
      console.log(`Browser disconnected for tenant ${tenantId}: ${account.id} (${account.provider}, ${account.label}).`);
      console.log(`Reason: ${account.browserDisconnectReason}`);
      console.log("The login stays in the profile. Run browser-connect again to verify it and reconnect.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_disconnected", model: account.provider, detail: account.id, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Browser was not disconnected. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "browser-status") {
    const statuses = listConnectionStatuses(ctx);
    if (statuses.length === 0) {
      console.log(`No browser accounts for tenant ${tenantId} yet.`);
      console.log("Add one with: node dist/index.js account-add --provider chatgpt --id main --label \"Main ChatGPT\"");
      console.log("Then log in once by hand in that profile, and verify it with: node dist/index.js browser-connect --account main");
      return;
    }
    console.log(`Browser connections for tenant ${tenantId}: ${statuses.filter((s) => s.connected).length} of ${statuses.length} connected.`);
    for (const status of statuses) {
      console.log(formatConnectionLine(status));
    }
    appendAudit({ at: new Date().toISOString(), runId, event: "browser_status_checked", result: "ok" }, rootDir, tenantId);
    return;
  }

  if (command === "run-browser") {
    const model = getArg(args, "--model", "chatgpt");
    const accountId = getArg(args, "--account", "");
    const taskType = getArg(args, "--type", "seo");
    const title = getArg(args, "--title", "Untitled task");
    const task = getArg(args, "--task", "Write a clear draft for this task.");
    const projectId = getArg(args, "--project", "");
    // Browser gate: only models with a wired driver may run here. Every
    // packet-only model is refused with a clear message, even when an
    // account exists for it, because no login or selector is verified.
    try {
      assertBrowserAllowed(model);
    } catch (error) {
      console.log(`Browser job was not started. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_blocked_packet_only", model, taskType, detail: `project:${projectId || "none"}`, result: "blocked" },
        rootDir,
        tenantId,
      );
      return;
    }
    if (!accountId) {
      console.log("Provide an account with --account. See account-list for existing accounts.");
      return;
    }
    if (!config.browser.enabled) {
      console.log("Browser mode is OFF. Set browser.enabled to true in config.yaml after reading docs/V1-1-BROWSER-MODE.md.");
      console.log("Packet mode is the fallback. Run the packet command instead, or turn browser mode on first.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_blocked_disabled", model, detail: accountId, result: "blocked" },
        rootDir,
        tenantId,
      );
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. All browser jobs are blocked until HOLD is lifted by the user.");
      return;
    }
    let projectContext: string | undefined;
    if (projectId) {
      try {
        const scope = scopeJobToProject(projectId, taskType, { rootDir, hold: config.hold, tenantId });
        projectContext = buildProjectContext(scope.project, taskType);
        console.log(`Project scope: ${scope.project.name} (${scope.project.id}, ${scope.project.kind}). Draft only, no publish, send, merge, or deploy.`);
      } catch (error) {
        console.log(`Browser job was not started. ${String(error).replace(/^Error: /, "")}`);
        appendAudit(
          { at: new Date().toISOString(), runId, event: "browser_blocked_project_scope", model, taskType, detail: `project:${projectId}`, result: "blocked" },
          rootDir,
          tenantId,
        );
        return;
      }
    }
    const account = getAccount(accountId, rootDir, tenantId);
    if (!account) {
      console.log(`Account ${accountId} was not found. Use account-list to see existing accounts.`);
      return;
    }
    if (account.provider !== model) {
      console.log(`Account ${accountId} is a ${account.provider} account, but model is ${model}. Use the matching model.`);
      return;
    }
    // Connection gate, V1.6: a disconnected account never reaches the
    // driver. Packet mode stays the fallback.
    try {
      assertBrowserConnected(ctx, accountId);
    } catch (error) {
      console.log(`Browser job was not started. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "browser_blocked_not_connected", model, detail: accountId, result: "blocked" },
        rootDir,
        tenantId,
      );
      return;
    }
    const useMock = process.env.TRUSTYMUSE_BROWSER_MOCK === "1";
    const driver = useMock
      ? new MockBrowserDriver()
      : new PlaywrightBrowserDriver({ headless: config.browser.headless });
    const prompt = buildPacketContent({ model: model as PacketModel, taskType, title, task, context: projectContext });
    const route = routeTask(taskType);
    const queue = new BrowserQueue({
      browserEnabled: config.browser.enabled,
      pacingMs: config.browser.pacingMs,
      dailyLimitPerAccount: config.browser.dailyLimitPerAccount,
      onEvent: (event, detail) => {
        appendAudit({ at: new Date().toISOString(), runId, event, model, taskType, detail, result: "ok" }, rootDir, tenantId);
      },
    });
    console.log(`Browser job queued: ${accountId} (${model}, ${taskType}, tier ${route.tier})`);
    const result = await queue.run(
      { accountId, model, taskType, title, task },
      account,
      driver,
      prompt,
    );
    const allAccounts = loadAccounts(rootDir, tenantId);
    const saved = allAccounts.find((a) => a.id === accountId);
    if (saved) {
      saved.status = account.status;
      saved.enabled = account.enabled;
      saved.dailyCount = account.dailyCount;
      saved.dailyDate = account.dailyDate;
      saved.lastUsed = account.lastUsed;
      // A paused account is no longer verified as connected. The login
      // may have been lost or challenged, so the flag must not keep
      // claiming a connection that the last job just disproved.
      if (account.status === "paused" || account.status === "challenge") {
        saved.browserConnected = false;
        saved.browserDisconnectReason =
          account.status === "challenge"
            ? "Account paused after a challenge. Check it by hand, then run browser-connect again."
            : "Account paused after driver errors. Check it by hand, then run browser-connect again.";
      }
      saveAccounts(allAccounts, rootDir, tenantId);
    }
    if (!result.ok) {
      console.log(`Browser job did not finish. ${result.reason}`);
      if (result.paused) {
        console.log("Account is paused. Check it by hand in your browser. Packet mode is the fallback.");
      }
      return;
    }
    const check = validatePacketResult(result.text || "");
    console.log(`Browser job finished in ${result.attempts} attempt(s). Valid: ${check.valid}. ${check.reason}`);
    const sendPath = (driver as unknown as { lastSendPath?: string | null }).lastSendPath;
    if (sendPath) {
      console.log(`Send path used: ${sendPath}. Send button after typing was not verified live, Enter is the fallback.`);
    }
    const resultsDir = path.join(rootDir, "browser-results", tenantId);
    fs.mkdirSync(resultsDir, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
    const outFile = path.join(resultsDir, `${model}-${accountId}-${slug}-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outFile, (result.text || "") + "\n", "utf-8");
    console.log(`Result saved: ${outFile}`);
    console.log("Review it before you use it. Publish, send, merge, and deploy are never automatic.");
    if (projectId) {
      markProjectUsed(projectId, rootDir, tenantId);
    }
    appendAudit(
      { at: new Date().toISOString(), runId, event: "browser_job_done", model, taskType, detail: projectId ? `project:${projectId} ${outFile}` : outFile, result: "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "project-add") {
    const id = getArg(args, "--id", "");
    const name = getArg(args, "--name", "");
    const kind = getArg(args, "--kind", "");
    const rootPath = getArg(args, "--path", "");
    const liveUrl = getArg(args, "--live-url", "");
    const repo = getArg(args, "--repo", "");
    const stack = getArg(args, "--stack", "");
    const tasks = getArg(args, "--tasks", "");
    const notes = getArg(args, "--notes", "");
    if (!id || !name || !kind || !rootPath) {
      console.log("Usage: node dist/index.js project-add --id my-project --name \"My Project\" --kind web-app --path ~/workspace/my-project [--live-url https://example.com] [--repo owner/repo] [--stack \"Node.js\"] [--tasks seo,blog] [--notes \"...\"]");
      console.log("Kind must be web-app, api, extension, static-site, docs, or repo-only. Connecting never deploys or publishes the project.");
      return;
    }
    try {
      assertProjectWriteAllowed(config.hold);
      const project = addProject(
        {
          id,
          name,
          kind,
          rootPath,
          liveUrl: liveUrl || undefined,
          repo: repo || undefined,
          stack: stack || undefined,
          allowedTaskTypes: tasks ? tasks.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : undefined,
          notes: notes || undefined,
        },
        { rootDir, maxProjects: config.projects.maxProjects, tenantId },
      );
      console.log(`Project connected: ${project.id} (${project.name}, ${project.kind}, ${project.status})`);
      console.log(`Root: ${project.rootPath}`);
      console.log(`Allowed task types: ${project.allowedTaskTypes.join(", ")}. Allowed actions: ${project.allowedActions.join(", ")}.`);
      console.log("Next step: run a scoped packet with --project " + project.id + ", or list projects with project-list.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "project_added", detail: `project:${project.id}`, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Project was not connected. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "project_add_blocked", detail: `project:${id}`, result: "blocked" },
        rootDir,
        tenantId,
      );
    }
    return;
  }

  if (command === "project-list") {
    const projects = listProjects(rootDir, tenantId);
    if (projects.length === 0) {
      console.log("No projects connected yet. Add one with project-add, or see candidates with project-discover.");
      return;
    }
    console.log(`Connected projects for tenant ${tenantId}: ${projects.length} (max ${config.projects.maxProjects})`);
    for (const project of projects) {
      console.log(`  ${project.id} (${project.name}, ${project.kind}, ${project.status}, tasks ${project.allowedTaskTypes.join(",")}, root ${project.rootPath}${project.liveUrl ? `, live ${project.liveUrl}` : ""})`);
    }
    return;
  }

  if (command === "project-show") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js project-show --id my-project");
      return;
    }
    const project = getProject(id, rootDir, tenantId);
    if (!project) {
      console.log(`Project ${id} was not found. Use project-list to see connected projects.`);
      return;
    }
    console.log(`Project: ${project.name} (${project.id})`);
    console.log(`Kind: ${project.kind}, status: ${project.status}`);
    console.log(`Root: ${project.rootPath}`);
    if (project.liveUrl) {
      console.log(`Live URL: ${project.liveUrl}`);
    }
    if (project.repo) {
      console.log(`Repo: ${project.repo}`);
    }
    if (project.stack) {
      console.log(`Stack: ${project.stack}`);
    }
    console.log(`Allowed task types: ${project.allowedTaskTypes.join(", ")}`);
    console.log(`Allowed actions: ${project.allowedActions.join(", ")} (publish, send, merge, deploy are never allowed)`);
    if (project.notes) {
      console.log(`Notes: ${project.notes}`);
    }
    console.log(`Connected: ${project.connectedAt}, last used: ${project.lastUsed || "never"}`);
    console.log("");
    console.log("Context this project sends with a scoped job:");
    console.log(buildProjectContext(project, project.allowedTaskTypes[0] || "content"));
    return;
  }

  if (command === "project-remove") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js project-remove --id my-project");
      return;
    }
    try {
      assertProjectWriteAllowed(config.hold);
      const removed = removeProject(id, rootDir, tenantId);
      console.log(`Project removed: ${removed.id} (${removed.name}). The project folder itself was not touched.`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "project_removed", detail: `project:${id}`, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Project was not removed. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "project-pause") {
    const id = getArg(args, "--id", "");
    if (!id) {
      console.log("Usage: node dist/index.js project-pause --id my-project");
      return;
    }
    try {
      assertProjectWriteAllowed(config.hold);
      const paused = pauseProject(id, rootDir, tenantId);
      console.log(`Project paused: ${paused.id} (${paused.name}). Paused projects cannot run jobs until they are active again.`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "project_paused", detail: `project:${id}`, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Project was not paused. ${String(error).replace(/^Error: /, "")}`);
    }
    return;
  }

  if (command === "project-status") {
    const projects = listProjects(rootDir, tenantId);
    const byStatus = { active: 0, paused: 0, archived: 0 };
    for (const project of projects) {
      byStatus[project.status] += 1;
    }
    console.log("TrustyMUSE Harness V2.0 project status");
    console.log(`Tenant: ${ctx.tenant.displayName} (${tenantId})`);
    console.log(`Connected: ${projects.length} of max ${config.projects.maxProjects}. Active ${byStatus.active}, paused ${byStatus.paused}, archived ${byStatus.archived}.`);
    console.log(`Policy HOLD: ${config.hold ? "ON, project writes are blocked" : "OFF"}`);
    for (const project of projects) {
      console.log(`  ${project.id} (${project.name}, ${project.kind}, ${project.status}, last used ${project.lastUsed || "never"})`);
    }
    return;
  }

  if (command === "model-list") {
    const connected = new Set(listConnectedModels(ctx).map((m) => m.id));
    console.log(`Models for tenant ${tenantId}: ${listModels().length} in the registry, ${listSubscriptionModels().length} subscription models.`);
    for (const model of listModels()) {
      const state =
        model.connection === "subscription"
          ? connected.has(model.id)
            ? "connected"
            : "not connected"
          : "api, never connected here";
      console.log(`  ${model.id} (${model.provider}, ${model.connection}, ${model.costMode}, ${model.status}, browser ${model.browserSupport}, ${state}${model.chatUrl ? `, ${model.chatUrl}` : ""})`);
    }
    console.log("Connect a subscription model with model-connect. Packet mode works for every connected one. Browser driver is wired only for chatgpt and claude.");
    console.log(CONNECTED_LEGEND);
    return;
  }

  if (command === "model-connect" || command === "connect") {
    const modelId = getArg(args, "--model", "");
    if (!modelId) {
      console.log("Usage: node dist/index.js model-connect --model gemini [--tenant <id>]");
      console.log("Connect works for subscription models only: chatgpt, claude, gemini, grok, deepseek, perplexity, meta-ai, copilot, mistral.");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Model connects are blocked until HOLD is lifted by the user.");
      return;
    }
    try {
      const wasAlreadyConnected = isModelConnected(ctx, modelId);
      const ids = connectModel(ctx, modelId);
      const entry = getModel(modelId);
      console.log(`Model connected for tenant ${tenantId}: ${entry ? entry.displayName : modelId} (${modelId}).`);
      console.log(`Connected models now: ${ids.join(", ")}.`);
      console.log("What Connect does: packet mode is ready now. Open the chat app in your own browser and run packets there.");
      if (entry) {
        console.log(`Chat app: ${entry.chatUrl}`);
        if (entry.browserSupport === "packet-only") {
          console.log("Browser mode is NOT wired for this model yet. No login or selector is verified for it, so run-browser will refuse it. Use packet mode for now.");
        } else {
          console.log("Browser mode is wired for this model. Add a browser account with account-add and log in once by hand in its profile.");
        }
      }
      if (wasAlreadyConnected) {
        console.log("This model was already connected. Nothing changed.");
      }
      appendAudit(
        { at: new Date().toISOString(), runId, event: "model_connected", model: modelId, detail: `tenant:${tenantId}`, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Model was not connected. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "model_connect_blocked", model: modelId, detail: `tenant:${tenantId}`, result: "blocked" },
        rootDir,
        tenantId,
      );
    }
    return;
  }

  if (command === "model-disconnect") {
    const modelId = getArg(args, "--model", "");
    if (!modelId) {
      console.log("Usage: node dist/index.js model-disconnect --model gemini [--tenant <id>]");
      return;
    }
    if (config.hold) {
      console.log("HOLD is on. Model disconnects are blocked until HOLD is lifted by the user.");
      return;
    }
    try {
      const accounts = loadAccounts(rootDir, tenantId);
      const hasActiveAccount = accounts.some(
        (a) => a.provider === modelId && a.enabled && a.status === "active",
      );
      const remaining = disconnectModel(ctx, modelId, { hasActiveAccount });
      console.log(`Model disconnected for tenant ${tenantId}: ${modelId}.`);
      console.log(`Connected models now: ${remaining.join(", ") || "none"}.`);
      console.log("Packets for this model are refused from now on. Connect it again with model-connect to use it.");
      appendAudit(
        { at: new Date().toISOString(), runId, event: "model_disconnected", model: modelId, detail: `tenant:${tenantId}`, result: "ok" },
        rootDir,
        tenantId,
      );
    } catch (error) {
      console.log(`Model was not disconnected. ${String(error).replace(/^Error: /, "")}`);
      appendAudit(
        { at: new Date().toISOString(), runId, event: "model_disconnect_blocked", model: modelId, detail: `tenant:${tenantId}`, result: "blocked" },
        rootDir,
        tenantId,
      );
    }
    return;
  }

  // Analytics Phase 1, V1.8: local collector, dry-run preview only.
  // analytics-preview builds the exact payload that would be sent and
  // prints it. It sends nothing, because there is no sending code yet
  // and the central service does not exist. analytics-enable is refused
  // until Phase 2 builds that service. analytics-disable is a no-op
  // that confirms nothing is being sent. See
  // docs/V1-8-ANALYTICS-PHASE-1.md.
  if (command === "analytics-preview") {
    const payload = buildAnalyticsPayload(rootDir);
    recordPreview(rootDir);
    console.log(`Analytics preview for tenant ${tenantId}. Nothing was sent.`);
    console.log(JSON.stringify(payload, null, 2));
    console.log("This payload is a dry run only. It was built from local counts, never left this machine, and holds no prompt text, results, project names, account labels, emails, or credentials.");
    appendAudit(
      { at: new Date().toISOString(), runId, event: "analytics_preview", result: "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "analytics-status") {
    const state = readAnalyticsState(rootDir);
    console.log("Analytics: OFF. Phase 1 is a dry-run preview only. The central service is not built yet, so nothing can be enabled and nothing is sent.");
    console.log(`Install id: ${state ? state.install_id : "not generated yet. Run analytics-preview to generate it."} (a random id, not identity)`);
    console.log(`Payload version: ${PAYLOAD_VERSION}`);
    console.log("Collector: ready. It reads local state only and counts, never sends.");
    console.log(`Last preview: ${state && state.last_preview_at ? state.last_preview_at : "never"}`);
    console.log("Last send: never. Phase 1 sends nothing.");
    appendAudit(
      { at: new Date().toISOString(), runId, event: "analytics_status_checked", result: "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "analytics-enable") {
    console.log("Analytics cannot be enabled yet. The central service is not built (Phase 2). Nothing was enabled and nothing is sent. Use analytics-preview to see the exact payload that would be sent.");
    appendAudit(
      { at: new Date().toISOString(), runId, event: "analytics_enable_refused", result: "blocked" },
      rootDir,
      tenantId,
    );
    return;
  }

  if (command === "analytics-disable") {
    console.log("Analytics is off and nothing is being sent. In Phase 1 there is nothing to disable: no data was ever enabled or sent, and no key exists. Nothing was changed. The local install id is kept, so Phase 2 can reuse it.");
    appendAudit(
      { at: new Date().toISOString(), runId, event: "analytics_disabled", result: "ok" },
      rootDir,
      tenantId,
    );
    return;
  }

  // Telegram bot, V2.0. Long polling only, no webhook. The token comes
  // from TELEGRAM_BOT_TOKEN first, then from the file token in
  // state/telegram.json. The bot serves this one tenant, resolved like
  // any CLI command. Only allowlisted user ids get a reply. See
  // docs/V2-0-TELEGRAM-FULL-CONTROL.md.
  if (command === "telegram-start") {
    let token: string;
    try {
      token = requireTelegramToken(process.env, rootDir);
    } catch (error) {
      console.log(`Telegram bot was not started. ${String(error).replace(/^Error: /, "")}`);
      return;
    }
    const api = new TelegramHttpApi(token);
    const bot = createTelegramBot({ rootDir, ctx, config, api });
    console.log("TrustyMUSE Harness V2.0 Telegram bot starting...");
    console.log(`Tenant: ${ctx.tenant.displayName} (${tenantId}). Only allowlisted Telegram users get a reply.`);
    console.log("Link a user first with: node dist/index.js telegram-allow --user-id <id> --label \"<Name>\"");
    console.log("Stop the bot with Ctrl+C. HOLD blocks every write from Telegram. /run runs one browser job on a connected account. Nothing here ever deploys.");
    await bot.run();
    return;
  }

  console.log(`Unknown command: ${command}`);
  printHelp();
}

main().catch((error) => {
  console.error("Harness failed. Fail closed, no external action was taken.");
  console.error(String(error));
  process.exit(1);
});

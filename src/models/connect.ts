import * as fs from "fs";
import * as path from "path";
import { TenantContext } from "../tenants/context";
import {
  ModelEntry,
  getModel,
  getSubscriptionModel,
  isBrowserWired,
  listConnectedModels as listConnectedRegistryModels,
} from "../registry";

// Per-tenant connected subscription models, V1.5, fixed in V1.7.
// A "Connect" is a local record only: the tenant's models.json holds the
// ids of the subscription models that tenant has connected. Connecting
// never logs in, never stores a password or a token, never places a call,
// and never touches another tenant: the file lives under
// state/tenants/<tenantId>/models.json, and every function here takes the
// tenant's own TenantContext.
// Since V1.7 every tenant starts with ZERO connected models. A model
// becomes connected only through an explicit model-connect command by the
// user. Before V1.7 a fresh tenant was seeded with chatgpt and claude on
// first read, which made them look connected without anyone connecting
// them; that seeding is removed. Tenants whose models.json already exists
// keep exactly what they have. API models can never be connected here: an
// API needs a key and a budget cap above 0, which is a separate flow.

// One-line legend printed by model-list and status, so "connected" is
// never mistaken for a live login. Keep it short and plain.
export const CONNECTED_LEGEND =
  "Connected means enabled for packet mode only. It is not a live login, not a stored token, and not a live call. For chatgpt and claude, run browser-status to check the live browser verification.";

export function modelsFilePath(ctx: TenantContext): string {
  return path.join(ctx.stateDir, "models.json");
}

function assertValidConnectedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new Error("Connected models file is corrupt: it must hold an array of model ids.");
  }
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") {
      throw new Error("Connected models file is corrupt: every entry must be a model id string.");
    }
    const entry = getSubscriptionModel(id);
    if (!entry) {
      throw new Error(
        `Connected models file is corrupt: ${id} is not a known subscription model. Check the file by hand first.`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  return clean;
}

function saveConnectedIds(ctx: TenantContext, ids: string[]): void {
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.writeFileSync(modelsFilePath(ctx), JSON.stringify(ids, null, 2) + "\n", "utf-8");
}

// Load the tenant's connected ids. A missing file means a fresh tenant,
// which starts with zero connected models: an empty list is written to
// disk, so the file always exists after the first read, and nothing is
// connected until the user runs model-connect for it. A file that already
// exists is loaded exactly as it is, so explicit connections are never
// removed on load.
export function loadConnectedIds(ctx: TenantContext): string[] {
  const file = modelsFilePath(ctx);
  if (!fs.existsSync(file)) {
    saveConnectedIds(ctx, []);
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return assertValidConnectedIds(parsed);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Connected models file is corrupt")) {
      throw error;
    }
    throw new Error("Connected models file is corrupt: it is not valid JSON. Check the file by hand first.");
  }
}

export function listConnectedModels(ctx: TenantContext): ModelEntry[] {
  return listConnectedRegistryModels(loadConnectedIds(ctx));
}

export function isModelConnected(ctx: TenantContext, modelId: string): boolean {
  return loadConnectedIds(ctx).includes(modelId);
}

// Connect one subscription model for this tenant only. Returns the full
// connected id list after the change. Idempotent: connecting an already
// connected model changes nothing. The caller logs the audit event.
export function connectModel(ctx: TenantContext, modelId: string): string[] {
  const entry = getModel(modelId);
  if (!entry) {
    throw new Error(
      `Model ${modelId} is not known. Use model-list to see the models the harness offers. No state was changed.`,
    );
  }
  if (entry.connection !== "subscription") {
    throw new Error(
      `Model ${modelId} is an API model, not a subscription model. It cannot be connected with model-connect. API use needs a key in the environment and a budget cap above 0, which is a separate flow. No state was changed.`,
    );
  }
  const ids = loadConnectedIds(ctx);
  if (ids.includes(modelId)) {
    return ids;
  }
  ids.push(modelId);
  saveConnectedIds(ctx, ids);
  return ids;
}

export interface DisconnectOptions {
  // True when this tenant has an active browser account for this model.
  // The CLI sets it from its own account registry; there is no persisted
  // browser queue to check, because the queue only lives in memory while
  // a browser job runs.
  hasActiveAccount?: boolean;
}

// Disconnect one subscription model for this tenant only. Refuses when the
// model is chatgpt or claude and the tenant still has an active browser
// account for it, because that account would be left pointing at a model
// the harness no longer routes to. Remove or pause the account first.
export function disconnectModel(ctx: TenantContext, modelId: string, options: DisconnectOptions = {}): string[] {
  const entry = getModel(modelId);
  if (!entry) {
    throw new Error(
      `Model ${modelId} is not known. Use model-list to see the models the harness offers. No state was changed.`,
    );
  }
  if (entry.connection !== "subscription") {
    throw new Error(
      `Model ${modelId} is an API model. It was never connected as a subscription model, so there is nothing to disconnect. No state was changed.`,
    );
  }
  const ids = loadConnectedIds(ctx);
  if (!ids.includes(modelId)) {
    throw new Error(
      `Model ${modelId} is not connected for tenant ${ctx.tenantId}. Nothing to disconnect. No state was changed.`,
    );
  }
  if ((modelId === "chatgpt" || modelId === "claude") && options.hasActiveAccount) {
    throw new Error(
      `Model ${modelId} cannot be disconnected while this tenant still has an active browser account for it. Remove or pause that account first, then disconnect the model. No state was changed.`,
    );
  }
  const remaining = ids.filter((id) => id !== modelId);
  saveConnectedIds(ctx, remaining);
  return remaining;
}

// Packet gate, shared by the CLI and the tests. Throws with the exact
// message the user sees. Unknown, API, and unconnected models all fail
// closed here, before any packet file is written.
export function assertPacketAllowed(ctx: TenantContext, modelId: string): ModelEntry {
  const entry = getModel(modelId);
  if (!entry) {
    throw new Error(
      `Model ${modelId} is not known. Use model-list to see the models the harness offers. No packet was created.`,
    );
  }
  if (entry.connection !== "subscription") {
    throw new Error(
      `Model ${modelId} is an API model, not a subscription model. Packets are for normal chat accounts. No packet was created.`,
    );
  }
  if (!isModelConnected(ctx, modelId)) {
    throw new Error(
      `Model ${modelId} is not connected for tenant ${ctx.tenantId}. Connect it first with model-connect --model ${modelId}. No packet was created.`,
    );
  }
  return entry;
}

// Browser gate, shared by the CLI and the tests. Only models with a wired
// driver may run through run-browser. Every other subscription model is
// packet-only, and the message says so.
export function assertBrowserAllowed(modelId: string): ModelEntry {
  const entry = getModel(modelId);
  if (!entry) {
    throw new Error(
      `Model ${modelId} is not known. Use model-list to see the models the harness offers. No browser job was started.`,
    );
  }
  if (entry.connection !== "subscription") {
    throw new Error(
      `Model ${modelId} is an API model, not a subscription model. Browser mode is for normal chat accounts. No browser job was started.`,
    );
  }
  if (!isBrowserWired(modelId)) {
    throw new Error(
      `Browser driver is not wired for ${modelId} yet, use packet mode. No login or selector is verified for ${modelId}, so run-browser refuses it. Run packet --model ${modelId} instead, open ${entry.chatUrl} in your own app, and paste the packet there.`,
    );
  }
  return entry;
}

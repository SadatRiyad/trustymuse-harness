// Model registry for V1.5. Subscription models are normal chat accounts,
// used by default through prompt packets. API models are interfaces only,
// disabled by default, and blocked by budget 0.
// Browser support split, stated honestly: the Playwright driver is wired
// ONLY for chatgpt and claude, with live verified selectors (V1.2). Every
// other model is packet-only: the packet works at once, because a packet is
// plain text the user runs in their own app, but no browser login, selector,
// or live test exists for it yet. Never claim a live browser connection
// for a packet-only model.

export type ConnectionMode = "subscription" | "api";
export type CostMode = "free" | "paid" | "free_tier_unverified";
export type BrowserSupport = "wired" | "packet-only";

export interface ModelEntry {
  id: string;
  provider: string;
  displayName: string;
  connection: ConnectionMode;
  costMode: CostMode;
  status: "enabled" | "disabled";
  // Chat URL of the normal chat app, used by packets and by the Connect
  // button. Empty for API models, which have no chat app.
  chatUrl: string;
  // "wired" means the Playwright driver is wired with live verified
  // selectors. "packet-only" means packets only, no browser driver.
  browserSupport: BrowserSupport;
  envKey?: string;
  notes: string;
}

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: "chatgpt",
    provider: "OpenAI",
    displayName: "ChatGPT, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://chatgpt.com",
    browserSupport: "wired",
    notes: "Used through a prompt packet, or through the wired browser driver. The user runs it in their own ChatGPT app. No login automation, no scraping.",
  },
  {
    id: "claude",
    provider: "Anthropic",
    displayName: "Claude, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://claude.ai",
    browserSupport: "wired",
    notes: "Used through a prompt packet, or through the wired browser driver. The user runs it in their own Claude app. No login automation, no scraping.",
  },
  {
    id: "gemini",
    provider: "Google",
    displayName: "Gemini, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://gemini.google.com",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Gemini app. No browser driver is wired, no login or selector is verified for Gemini yet.",
  },
  {
    id: "grok",
    provider: "xAI",
    displayName: "Grok, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://grok.com",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Grok app. No browser driver is wired, no login or selector is verified for Grok yet.",
  },
  {
    id: "deepseek",
    provider: "DeepSeek",
    displayName: "DeepSeek, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://chat.deepseek.com",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own DeepSeek app. No browser driver is wired, no login or selector is verified for DeepSeek yet.",
  },
  {
    id: "perplexity",
    provider: "Perplexity",
    displayName: "Perplexity, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://perplexity.ai",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Perplexity app. No browser driver is wired, no login or selector is verified for Perplexity yet.",
  },
  {
    id: "meta-ai",
    provider: "Meta",
    displayName: "Meta AI, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://meta.ai",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Meta AI app. No browser driver is wired, no login or selector is verified for Meta AI yet.",
  },
  {
    id: "copilot",
    provider: "Microsoft",
    displayName: "Copilot, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://copilot.microsoft.com",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Copilot app. No browser driver is wired, no login or selector is verified for Copilot yet.",
  },
  {
    id: "mistral",
    provider: "Mistral AI",
    displayName: "Mistral, normal account",
    connection: "subscription",
    costMode: "free",
    status: "enabled",
    chatUrl: "https://chat.mistral.ai",
    browserSupport: "packet-only",
    notes: "Packet-only. Used through a prompt packet the user runs in their own Mistral app. No browser driver is wired, no login or selector is verified for Mistral yet.",
  },
  {
    id: "openai-api",
    provider: "OpenAI",
    displayName: "OpenAI API",
    connection: "api",
    costMode: "paid",
    status: "disabled",
    chatUrl: "",
    browserSupport: "packet-only",
    envKey: "OPENAI_API_KEY",
    notes: "Disabled by default. No free API quota is claimed. Enable only with a key and a budget cap above 0.",
  },
  {
    id: "anthropic-api",
    provider: "Anthropic",
    displayName: "Anthropic API",
    connection: "api",
    costMode: "paid",
    status: "disabled",
    chatUrl: "",
    browserSupport: "packet-only",
    envKey: "ANTHROPIC_API_KEY",
    notes: "Disabled by default. No free API quota is claimed. Enable only with a key and a budget cap above 0.",
  },
  {
    id: "gemini-api",
    provider: "Google",
    displayName: "Gemini API",
    connection: "api",
    costMode: "free_tier_unverified",
    status: "disabled",
    chatUrl: "",
    browserSupport: "packet-only",
    envKey: "GEMINI_API_KEY",
    notes: "Disabled by default. A free tier may exist, but it must be verified at runtime. It is not hardcoded as guaranteed. This is a separate entry from the gemini subscription model.",
  },
];

export function getModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((entry) => entry.id === id);
}

export function listModels(): ModelEntry[] {
  return [...MODEL_REGISTRY];
}

export function listEnabledModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.status === "enabled");
}

export function listSubscriptionModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.connection === "subscription" && entry.status === "enabled");
}

// The subscription entry for one model id, or undefined when the id is
// unknown or is an API model. Connect buttons only ever offer these.
export function getSubscriptionModel(id: string): ModelEntry | undefined {
  const entry = getModel(id);
  if (!entry || entry.connection !== "subscription") {
    return undefined;
  }
  return entry;
}

// True only when the Playwright browser driver is wired for this model
// with live verified selectors. In V1.5 that is chatgpt and claude only.
export function isBrowserWired(modelId: string): boolean {
  const entry = getModel(modelId);
  return entry !== undefined && entry.browserSupport === "wired";
}

// Registry entries for a list of connected model ids, in registry order.
// Unknown ids are dropped, never invented: the caller validates ids first.
export function listConnectedModels(connectedIds: string[]): ModelEntry[] {
  const wanted = new Set(connectedIds);
  return MODEL_REGISTRY.filter((entry) => entry.connection === "subscription" && wanted.has(entry.id));
}

export function listApiModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.connection === "api");
}

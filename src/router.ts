// Task router for V1. TrustyMUSE is the controller and routes each task to a slot.
// A slot is a capability, not a hardcoded model name, so a model can be swapped
// later without rewriting the task flow. Verification is part of every route.

export type TaskType = "seo" | "blog" | "code_review" | "research" | "content" | "social";
export type Slot = "reasoning" | "research" | "drafting" | "coding" | "media";
export type Tier = 0 | 1 | 2 | 3;

export interface Route {
  taskType: TaskType;
  slot: Slot;
  primaryModel: string;
  fallbackModel: string;
  tier: Tier;
  verification: string;
}

export const TASK_TYPES: TaskType[] = ["seo", "blog", "code_review", "research", "content", "social"];

const ROUTES: Record<TaskType, Route> = {
  seo: {
    taskType: "seo",
    slot: "drafting",
    primaryModel: "chatgpt",
    fallbackModel: "claude",
    tier: 1,
    verification: "Check facts against the live site and the source files before any draft is approved.",
  },
  blog: {
    taskType: "blog",
    slot: "drafting",
    primaryModel: "claude",
    fallbackModel: "chatgpt",
    tier: 1,
    verification: "Check facts, links, and word count against the brief before any draft is approved.",
  },
  code_review: {
    taskType: "code_review",
    slot: "coding",
    primaryModel: "claude",
    fallbackModel: "chatgpt",
    tier: 2,
    verification: "Check every finding against the exact file and line. No fix is applied without user approval for that exact item.",
  },
  research: {
    taskType: "research",
    slot: "research",
    primaryModel: "claude",
    fallbackModel: "chatgpt",
    tier: 1,
    verification: "Check claims against a primary source. Do not present an unverified claim as fact.",
  },
  content: {
    taskType: "content",
    slot: "drafting",
    primaryModel: "chatgpt",
    fallbackModel: "claude",
    tier: 1,
    verification: "Check tone, facts, and brand rules before any draft is approved.",
  },
  social: {
    taskType: "social",
    slot: "drafting",
    primaryModel: "chatgpt",
    fallbackModel: "claude",
    tier: 2,
    verification: "Draft only. The user posts it. No auto posting in V1.",
  },
};

export function routeTask(taskType: string): Route {
  if ((TASK_TYPES as string[]).includes(taskType)) {
    return ROUTES[taskType as TaskType];
  }
  return {
    taskType: "content",
    slot: "drafting",
    primaryModel: "chatgpt",
    fallbackModel: "claude",
    tier: 1,
    verification: "Unknown task type. Treated as a draft task and checked before approval.",
  };
}

export function listRoutes(): Route[] {
  return TASK_TYPES.map((taskType) => ROUTES[taskType]);
}

// Suggested subscription models for each capability slot. These are
// SUGGESTIONS ONLY, never a verified capability claim: every model in the
// list works through a prompt packet, but only chatgpt and claude have a
// wired browser driver, and no model here has been live tested for slot
// quality. Primaries and fallbacks in ROUTES above are unchanged.
const SLOT_SUGGESTIONS: Record<Slot, string[]> = {
  drafting: ["chatgpt", "claude", "gemini", "grok", "deepseek"],
  research: ["perplexity", "claude", "gemini"],
  coding: ["claude", "chatgpt", "deepseek"],
  reasoning: ["claude", "grok", "gemini"],
  media: ["gemini", "chatgpt"],
};

export function modelsForSlot(slot: Slot): string[] {
  return [...(SLOT_SUGGESTIONS[slot] || [])];
}

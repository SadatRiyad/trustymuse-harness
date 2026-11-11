// Policy gate for V1. Fail closed, always.
// Tier 0: read only, automatic.
// Tier 1: draft only, no external action.
// Tier 2: needs explicit user approval for that exact item before any action.
// Tier 3: blocked in V1, never automatic.
// Publish, send, merge, and deploy are never automatic in V1, even at Tier 2
// without a per item approval recorded by the user.
// If HOLD is on, or if policy state cannot be read, every write is blocked.

export type Tier = 0 | 1 | 2 | 3;
export type Action = "read" | "draft" | "publish" | "send" | "merge" | "deploy";

export interface PolicyCheck {
  allowed: boolean;
  reason: string;
}

export const BLOCKED_ACTIONS: Action[] = ["publish", "send", "merge", "deploy"];

export function checkPolicy(action: Action, tier: Tier, hold: boolean): PolicyCheck {
  if (hold) {
    return { allowed: false, reason: "HOLD is on. All writes are blocked until HOLD is lifted by the user." };
  }
  if (action === "read") {
    return { allowed: true, reason: "Read only action is allowed." };
  }
  if (action === "draft") {
    return { allowed: true, reason: "Draft action is allowed. No external action is taken." };
  }
  if (BLOCKED_ACTIONS.includes(action)) {
    if (tier === 3) {
      return { allowed: false, reason: `Action ${action} is Tier 3 in V1 and is always blocked.` };
    }
    if (tier === 2) {
      return {
        allowed: false,
        reason: `Action ${action} needs explicit per item user approval. It is not automatic. Ask the user for that exact item first.`,
      };
    }
    return {
      allowed: false,
      reason: `Action ${action} is never automatic in V1. It needs explicit per item user approval.`,
    };
  }
  return { allowed: false, reason: "Unknown action. Fail closed." };
}

export function isWriteAction(action: Action): boolean {
  return BLOCKED_ACTIONS.includes(action);
}

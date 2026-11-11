import { BudgetTracker } from "../budget";
import { HarnessConfig } from "../config";

// Common adapter interface for V1. Every adapter must use the same guard.
// No adapter makes a live network call in V1. The guard runs first, and the
// stub result runs second, so a disabled API can never spend money by accident.

export interface AdapterRequest {
  prompt: string;
  taskType: string;
  model: string;
}

export interface AdapterResult {
  ok: boolean;
  blocked: boolean;
  provider: string;
  model: string;
  reason: string;
  text?: string;
  costUsd?: number;
}

export interface ModelAdapter {
  id: string;
  provider: string;
  call(request: AdapterRequest, config: HarnessConfig, budget: BudgetTracker): Promise<AdapterResult>;
}

export function apiGuard(provider: string, model: string, config: HarnessConfig, budget: BudgetTracker, envKeyName?: string): AdapterResult | null {
  if (!config.apiEnabled) {
    return {
      ok: false,
      blocked: true,
      provider,
      model,
      reason: "API mode is off. Set api.enabled to true in config.yaml only when you are ready to enable paid API use.",
    };
  }
  const check = budget.canSpend(0.01);
  if (!check.allowed) {
    return { ok: false, blocked: true, provider, model, reason: check.reason };
  }
  if (envKeyName && !process.env[envKeyName]) {
    return {
      ok: false,
      blocked: true,
      provider,
      model,
      reason: `No API key was found in the environment variable ${envKeyName}. Keys are never stored in code or in config.`,
    };
  }
  return null;
}

export function stubBlockedResult(provider: string, model: string): AdapterResult {
  return {
    ok: false,
    blocked: true,
    provider,
    model,
    reason: "V1 adapter is a stub. No live API call is made in V1. The interface is ready, and live calls are a later phase after a budget cap and a key are set.",
  };
}

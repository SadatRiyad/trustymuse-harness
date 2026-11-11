import * as fs from "fs";
import * as path from "path";
import { stateDir } from "./audit";

// Monthly budget guard. Default cap is 0, and 0 means every paid API call is blocked.
// The user can later set any cap in config.yaml. The guard then allows spend only
// up to that cap, warns at the configured percent, and stops hard at the cap.
// Usage is stored per calendar month in state/usage.json. No key or card is stored here.

export interface BudgetStatus {
  month: string;
  capUsd: number;
  usedUsd: number;
  remainingUsd: number;
  percentUsed: number;
  warnAtPercent: number;
  warning: boolean;
  blocked: boolean;
}

export interface SpendCheck {
  allowed: boolean;
  reason: string;
  warning: boolean;
}

export function currentMonthKey(now?: Date): string {
  const d = now || new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${month}`;
}

export function usageFilePath(rootDir?: string, tenantId?: string): string {
  return path.join(stateDir(rootDir, tenantId), "usage.json");
}

export function loadUsage(rootDir?: string, tenantId?: string): Record<string, number> {
  const file = usageFilePath(rootDir, tenantId);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, number>;
    return parsed || {};
  } catch {
    return {};
  }
}

export function saveUsage(usage: Record<string, number>, rootDir?: string, tenantId?: string): void {
  const dir = stateDir(rootDir, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(usageFilePath(rootDir, tenantId), JSON.stringify(usage, null, 2) + "\n", "utf-8");
}

export class BudgetTracker {
  private capUsd: number;
  private warnAtPercent: number;
  private rootDir?: string;
  private tenantId?: string;

  constructor(capUsd: number, warnAtPercent: number, rootDir?: string, tenantId?: string) {
    this.capUsd = capUsd >= 0 ? capUsd : 0;
    this.warnAtPercent = warnAtPercent > 0 && warnAtPercent <= 100 ? warnAtPercent : 80;
    this.rootDir = rootDir;
    this.tenantId = tenantId;
  }

  getStatus(now?: Date): BudgetStatus {
    const month = currentMonthKey(now);
    const usage = loadUsage(this.rootDir, this.tenantId);
    const used = usage[month] || 0;
    const remaining = Math.max(0, this.capUsd - used);
    const percentUsed = this.capUsd > 0 ? (used / this.capUsd) * 100 : used > 0 ? 100 : 0;
    return {
      month,
      capUsd: this.capUsd,
      usedUsd: used,
      remainingUsd: remaining,
      percentUsed,
      warnAtPercent: this.warnAtPercent,
      warning: this.capUsd > 0 && percentUsed >= this.warnAtPercent,
      blocked: this.capUsd <= 0,
    };
  }

  canSpend(amountUsd: number, now?: Date): SpendCheck {
    if (this.capUsd <= 0) {
      return {
        allowed: false,
        reason: "Monthly budget cap is 0. Paid API calls are blocked. Raise monthly_cap_usd in config.yaml to allow paid use.",
        warning: false,
      };
    }
    if (amountUsd < 0) {
      return { allowed: false, reason: "Spend amount must not be negative.", warning: false };
    }
    const status = this.getStatus(now);
    if (status.usedUsd + amountUsd > this.capUsd) {
      return {
        allowed: false,
        reason: `Spend of ${amountUsd} USD would exceed the monthly cap of ${this.capUsd} USD. Used so far: ${status.usedUsd} USD.`,
        warning: true,
      };
    }
    return {
      allowed: true,
      reason: "Within monthly budget cap.",
      warning: status.percentUsed >= this.warnAtPercent,
    };
  }

  recordSpend(amountUsd: number, now?: Date): BudgetStatus {
    const month = currentMonthKey(now);
    const usage = loadUsage(this.rootDir, this.tenantId);
    usage[month] = (usage[month] || 0) + amountUsd;
    saveUsage(usage, this.rootDir, this.tenantId);
    return this.getStatus(now);
  }
}

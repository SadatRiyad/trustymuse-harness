import { dailyCountToday, recordAccountUse, todayKey } from "./accounts";
import type { BrowserAccount } from "./accounts";
import { detectChallenge } from "./browser";
import type { BrowserDriver } from "./browser";

// Browser job queue for V1.1. Safety rules, in order:
// - One job at a time per account. A second job for the same busy account is blocked, never run in parallel.
// - Global pacing delay per account. A job that arrives too soon after the last run is blocked with a wait time.
// - Per account daily limit. A job past the limit is blocked until the next day.
// - Retry once, then pause. A driver failure retries one time. A second failure pauses the account.
// - CAPTCHA or challenge pauses the account. The queue logs account_paused_challenge and never auto solves it.
// - Every decision is reported through onEvent so the CLI can write it to the audit log.

export interface QueueOptions {
  browserEnabled: boolean;
  pacingMs: number;
  dailyLimitPerAccount: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: string, detail: string) => void;
}

export interface BrowserRunRequest {
  accountId: string;
  model: string;
  taskType: string;
  title: string;
  task: string;
}

export interface BrowserRunResult {
  ok: boolean;
  blocked: boolean;
  paused: boolean;
  reason: string;
  text?: string;
  attempts: number;
  accountId: string;
}

export class BrowserQueue {
  private busy = new Map<string, boolean>();
  private lastRunAtMs = new Map<string, number>();
  private opts: QueueOptions;

  constructor(opts: QueueOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    if (this.opts.sleep) {
      await this.opts.sleep(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emit(event: string, detail: string): void {
    if (this.opts.onEvent) {
      this.opts.onEvent(event, detail);
    }
  }

  // Pure preflight check, used by the CLI and by tests. It does not run a job.
  canRun(account: BrowserAccount, nowDate?: Date): { allowed: boolean; reason: string; waitMs?: number } {
    if (!this.opts.browserEnabled) {
      return { allowed: false, reason: "Browser mode is off. Set browser.enabled to true in config.yaml after reading docs/V1-1-BROWSER-MODE.md." };
    }
    if (!account.enabled) {
      return { allowed: false, reason: `Account ${account.id} is disabled.` };
    }
    if (account.status === "challenge") {
      return { allowed: false, reason: `Account ${account.id} is paused after a challenge. Check it by hand in your browser before you use it again.` };
    }
    if (account.status === "paused") {
      return { allowed: false, reason: `Account ${account.id} is paused. Check the audit log, then re enable it by hand.` };
    }
    if (account.status !== "active") {
      return { allowed: false, reason: `Account ${account.id} has status ${account.status} and cannot run a job.` };
    }
    const today = nowDate || new Date();
    if (dailyCountToday(account, today) >= this.opts.dailyLimitPerAccount) {
      return { allowed: false, reason: `Daily limit reached for account ${account.id}. Limit is ${this.opts.dailyLimitPerAccount} jobs per day.` };
    }
    const lastRun = this.lastRunAtMs.get(account.id);
    if (lastRun !== undefined) {
      const waitMs = this.opts.pacingMs - (this.now() - lastRun);
      if (waitMs > 0) {
        return { allowed: false, reason: `Pacing delay for account ${account.id}. Wait ${Math.ceil(waitMs / 1000)} seconds before the next job.`, waitMs };
      }
    }
    if (this.busy.get(account.id)) {
      return { allowed: false, reason: `Account ${account.id} is already running a job. One job at a time per account.` };
    }
    return { allowed: true, reason: "Ready to run." };
  }

  async run(
    request: BrowserRunRequest,
    account: BrowserAccount,
    driver: BrowserDriver,
    prompt: string,
  ): Promise<BrowserRunResult> {
    const preflight = this.canRun(account);
    if (!preflight.allowed) {
      this.emit("browser_job_blocked", `${request.accountId}: ${preflight.reason}`);
      return { ok: false, blocked: true, paused: false, reason: preflight.reason, attempts: 0, accountId: request.accountId };
    }
    this.busy.set(account.id, true);
    this.emit("browser_job_started", `${request.accountId}: ${request.taskType} ${request.title}`);
    let attempts = 0;
    try {
      for (attempts = 1; attempts <= 2; attempts += 1) {
        try {
          await driver.openProfile(account);
          await driver.sendPrompt(prompt);
          const text = await driver.waitForResponse(120000);
          if (detectChallenge(text)) {
            account.status = "challenge";
            this.emit("account_paused_challenge", `${request.accountId}: challenge text was detected in the response. Account paused. CAPTCHA is never auto solved.`);
            return {
              ok: false,
              blocked: false,
              paused: true,
              reason: "Challenge detected in the response. Account is paused. Check it by hand in your browser.",
              attempts,
              accountId: request.accountId,
            };
          }
          recordAccountUse(account);
          this.lastRunAtMs.set(account.id, this.now());
          this.emit("browser_job_done", `${request.accountId}: job finished after ${attempts} attempt(s).`);
          return { ok: true, blocked: false, paused: false, reason: "Job finished.", text, attempts, accountId: request.accountId };
        } catch (error) {
          if (attempts >= 2) {
            account.status = "paused";
            this.emit("account_paused_error", `${request.accountId}: driver failed twice. Account paused. Error: ${String(error)}`);
            return {
              ok: false,
              blocked: false,
              paused: true,
              reason: "Driver failed twice. Account is paused. Check the audit log and the account by hand.",
              attempts,
              accountId: request.accountId,
            };
          }
          this.emit("browser_job_retry", `${request.accountId}: attempt ${attempts} failed, retrying once after the pacing delay.`);
          await this.sleep(this.opts.pacingMs);
        }
      }
      return { ok: false, blocked: true, paused: false, reason: "Job did not finish.", attempts, accountId: request.accountId };
    } finally {
      this.busy.set(account.id, false);
      try {
        await driver.close();
      } catch {
        // Closing the driver must never mask the job result.
      }
    }
  }
}

export function dayKeyForTest(date: Date): string {
  return todayKey(date);
}

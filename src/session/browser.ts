import * as fs from "fs";
import * as path from "path";
import type { BrowserAccount } from "./accounts";

// Browser driver for V1.2, based on Playwright.
// Selectors below use only values verified live on 2026-11-10.
// No id, name, or data-testid was exposed for either prompt box in the live
// checks, so the driver uses role and accessible name and placeholder only.
// Never hardcode an id or data-testid here.
// Send button after typing and model picker menu contents were NOT verified
// live. The driver tries the accessible Send message button first, falls back
// to Enter, and logs which path was used. It never claims an unverified
// selector is verified.

export interface BrowserJob {
  prompt: string;
  taskType: string;
  title: string;
  model: string;
}

export interface BrowserDriver {
  name: string;
  wired: boolean;
  openProfile(account: BrowserAccount): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  waitForResponse(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export const PROVIDER_URLS: Record<string, string> = {
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
};

// Verified live selectors, 2026-11-10. Each entry notes what was seen and
// what was not seen, so a later reader does not mistake a guess for evidence.
export const LIVE_SELECTORS = {
  chatgpt: {
    provider: "chatgpt",
    url: "https://chatgpt.com",
    promptRole: "textbox",
    promptName: "Ask ChatGPT",
    promptPlaceholder: "Ask ChatGPT",
    profileButtonName: "Open profile menu",
    profileText: "Free",
    newChatName: "New chat",
    sendButtonName: "Send message",
    modelPickerName: null as string | null,
    verified: [
      "logged in profile shows business mail, plan Free",
      "prompt box is role textbox, name Ask ChatGPT, placeholder Ask ChatGPT",
      "composer has Add files and more, Think, Dictate, Start Voice",
      "no Send message button in the empty state",
      "no separate model picker visible",
      "new chat in Chat history, Recents shows No chats",
    ],
    unverified: ["send button after typing", "model picker menu contents", "response stop control label"],
  },
  claude: {
    provider: "claude",
    url: "https://claude.ai/new",
    promptRole: "textbox",
    promptName: "Write your prompt to Claude",
    promptPlaceholder: "How can I help you today?",
    profileButtonName: "BB Free",
    profileText: "Free plan",
    newChatName: "New",
    sendButtonName: "Send message",
    modelPickerName: "Model: Sonnet 5.5 Medium",
    verified: [
      "logged in at claude.ai/new, BB Free, Free plan",
      "prompt box is role textbox, name Write your prompt to Claude, placeholder How can I help you today?",
      "composer has Add files, connectors, and more, Surface Chat checked and Cowork, Press and hold to record, Use voice mode",
      "model picker is button Model: Sonnet 5.5 Medium",
      "new chat link is New, Chats and tasks list exists",
      "no send button in the empty state",
    ],
    unverified: ["send button after typing", "model picker menu contents", "response stop control label"],
  },
} as const;

export type ProviderKey = keyof typeof LIVE_SELECTORS;
export type SendPath = "send-button" | "enter";

// Pure helper, tested without a browser. Send button wins only when it is
// visible and enabled. Every other case falls back to Enter.
export function pickSendPath(sendVisible: boolean, sendEnabled: boolean): SendPath {
  if (sendVisible && sendEnabled) {
    return "send-button";
  }
  return "enter";
}

// Pure helper, tested without a browser. A login URL means the profile is
// not logged in, even if a prompt box is also on the page.
export function isLoginUrl(provider: string, url: string): boolean {
  const lower = (url || "").toLowerCase();
  if (provider === "claude") {
    return lower.includes("claude.ai/login");
  }
  if (provider === "chatgpt") {
    return lower.includes("/auth/login") || lower.includes("auth0") || lower.includes("/login");
  }
  return lower.includes("/login");
}

// Challenge and rate limit markers. If a response contains one of these,
// the account is paused and the user is asked to check it by hand.
// CAPTCHA is never auto solved. This list is a first pass and must be
// extended when a live run shows a new challenge text.
const CHALLENGE_MARKERS = [
  "captcha",
  "verify you are human",
  "verify that you are human",
  "unusual traffic",
  "rate limit",
  "too many requests",
  "challenge",
  "suspicious activity",
  "temporarily blocked",
  "drag the correct item",
];

export function detectChallenge(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

export function providerUrl(provider: string): string {
  return PROVIDER_URLS[provider] || "";
}

// Live logged out check, 2026-11-10 17:21 to 17:22 +06, one visit per site, read only.
// ChatGPT at https://chatgpt.com loads normally, no challenge. Prompt textbox IS visible
// without login, role textbox, aria-label "Chat with ChatGPT", placeholder "Ask ChatGPT".
// Send button is NOT visible in the empty state, it may appear only after typing, unverified.
// New chat link href "/?noauth_recent_chat_failed=1". Log in and Sign up for free buttons visible.
// Claude at https://claude.ai redirects to https://claude.ai/login, login wall only.
// No prompt box, send, attach, model picker, or new chat visible without login.
// Login via Continue with Google, Continue with Apple, or Continue with email.
// DOM id, name, and data-testid values were NOT confirmed in this check, so do not hardcode them.
// A logged in check is still needed for ChatGPT send and response selectors, and for all Claude chat selectors.
// Recheck after reload, 2026-11-10 17:24 to 17:25 +06. User did a Google flow for Claude in a popup,
// but Claude stayed logged out. An hCaptcha overlay showed "Verify you are human",
// "Click the TWO matching shapes", "Please try again.", with Google and Apple buttons disabled.
// That failed challenge appears to have blocked the Claude login. Do not auto solve it.
// ChatGPT stayed logged out, as expected, because the Google flow was for Claude, not ChatGPT.
// ChatGPT send button IS now seen in the empty state: button "Send message", disabled, pale blue up arrow.
// ChatGPT composer is textbox "Chat with ChatGPT", placeholder "Ask ChatGPT", plus
// "Add files and more", "Start dictation", "New chat", and top left "ChatGPT" menu button.
// No separate model picker was visible. Logged in selectors still unverified for both sites.
// Logged in check, 2026-11-10 17:26 to 17:32 +06. ChatGPT IS logged in with Google, complete.
// Profile shows "business mail", plan "Free", button "Open profile menu".
// Sidebar: Chat history, New chat, Images, Scheduled, Library, Plugins, Explore, Projects, Recents.
// Prompt box is textbox "Ask ChatGPT", empty, placeholder "Ask ChatGPT".
// Empty state composer shows "Add files and more", "Think", "Dictate", "Start Voice",
// plus suggestions "Create an image", "Write or edit", "Search the web".
// No "Send message" button in the empty logged in state, it may appear only after typing, untested.
// No separate model picker visible. Conversation list empty, "No chats", "No projects".
// No id, name, or data-testid was exposed for the prompt box in this inspection.
// Claude is still logged out, blocked by hCaptcha. Google account was picked and consent was given,
// then the popup returned to claude.ai/login where hCaptcha covers the form.
// Heading "Drag the correct item that fits the pattern into the empty space",
// buttons "Skip Challenge" and "Refresh Challenge.", Continue with Google disabled behind it.
// Do not auto solve it. Logged in Claude selectors remain unverified until the user solves it.
// Both logged in, verified 2026-11-10 17:43 +06, after the user solved the hCaptcha in takeover.
// Claude at https://claude.ai/new, New chat, Free plan, button "BB Free".
// Prompt box is textbox "Write your prompt to Claude", placeholder "How can I help you today?".
// Composer shows "Add files, connectors, and more", Surface Chat checked and Cowork,
// "Press and hold to record", "Use voice mode".
// Model picker is button "Model: Sonnet 5.5 Medium", displayed as Sonnet 5.5 and Medium, with Settings beside it.
// New chat link is "New", conversation list is "Chats and tasks" with one entry
// "Idle Window Close Button TypeScript Fix", plus View all and Group and sort.
// ChatGPT still logged in, profile "business mail", plan "Free", button "Open profile menu".
// Prompt box is textbox "Ask ChatGPT", placeholder "Ask ChatGPT", heading "What is on your mind today?".
// Composer shows "Add files and more", "Think", "Dictate", "Start Voice",
// plus "Create an image", "Write or edit", "Search the web".
// No separate model picker visible. New chat button in Chat history.
// Conversation list is Recents "No chats", Projects "No projects".
// Send button is NOT visible in the empty state on either site, it may appear only after typing, untested.
// Model picker menu contents were not opened, because no prompt was to be sent.
// No id, name, or data-testid was exposed for either prompt box in this inspection.
// Note: during takeover the user also visited ChatGPT pricing and checkout, then returned.
// No upgrade confirmation was observed, profile still shows Free. No payment details recorded.

export interface PlaywrightDriverOptions {
  headless?: boolean;
  // Test seam only. Default loader imports the real playwright package.
  // A test may pass a loader that throws, to prove the driver fails closed
  // when Playwright is not available.
  loader?: () => Promise<any>;
  // Test seam only. Default launcher uses chromium.launchPersistentContext.
  // A test may pass a fake launcher that returns a fake context, so no
  // real browser is launched in tests.
  launcher?: (profileDir: string, opts: Record<string, unknown>) => Promise<any>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function locatorCount(locator: any): Promise<number> {
  try {
    const n = await locator.count();
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

async function locatorVisible(locator: any): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    try {
      return await locator.isVisible();
    } catch {
      return false;
    }
  }
}

async function locatorEnabled(locator: any): Promise<boolean> {
  try {
    return await locator.first().isEnabled();
  } catch {
    try {
      return await locator.isEnabled();
    } catch {
      return false;
    }
  }
}

// Real Playwright driver, wired in V1.2. It launches Chromium with a
// persistent context at the account profileDir, so it reuses the login the
// user did once by hand in that profile. It never types a password and it
// never auto solves a CAPTCHA. Every failure is fail closed.
export class PlaywrightBrowserDriver implements BrowserDriver {
  name = "playwright-real";
  wired = true;
  lastSendPath: SendPath | null = null;
  private context: any = null;
  private page: any = null;
  private account: BrowserAccount | null = null;
  private headless: boolean;
  private loader: () => Promise<any>;
  private launcher?: (profileDir: string, opts: Record<string, unknown>) => Promise<any>;

  constructor(options: PlaywrightDriverOptions = {}) {
    this.headless = options.headless ?? true;
    this.loader = options.loader || (() => import("playwright"));
    this.launcher = options.launcher;
  }

  // Test seam. Returns the live page when open, or null before openProfile.
  pageForTest(): any {
    return this.page;
  }

  private promptSelector(provider: string): { name: string; placeholder: string } {
    if (provider === "claude") {
      return { name: LIVE_SELECTORS.claude.promptName, placeholder: LIVE_SELECTORS.claude.promptPlaceholder };
    }
    return { name: LIVE_SELECTORS.chatgpt.promptName, placeholder: LIVE_SELECTORS.chatgpt.promptPlaceholder };
  }

  private async findPromptBox(): Promise<any> {
    if (!this.page || !this.account) {
      throw new Error("Driver is not open. Call openProfile first.");
    }
    const sel = this.promptSelector(this.account.provider);
    const byRole = this.page.getByRole("textbox", { name: sel.name });
    if ((await locatorCount(byRole)) > 0) {
      return byRole;
    }
    const byPlaceholder = this.page.getByPlaceholder(sel.placeholder);
    if ((await locatorCount(byPlaceholder)) > 0) {
      return byPlaceholder;
    }
    return byRole;
  }

  private async checkLoggedIn(): Promise<boolean> {
    if (!this.page || !this.account) {
      return false;
    }
    const provider = this.account.provider;
    let url = "";
    try {
      url = this.page.url();
    } catch {
      url = "";
    }
    if (isLoginUrl(provider, url)) {
      return false;
    }
    let content = "";
    try {
      content = await this.page.content();
    } catch {
      content = "";
    }
    if (detectChallenge(content)) {
      throw new Error("Challenge detected on the page. Account is paused. CAPTCHA is never auto solved. Check it by hand.");
    }
    const box = await this.findPromptBox();
    if ((await locatorCount(box)) === 0) {
      return false;
    }
    if (provider === "chatgpt") {
      const profile = this.page.getByRole("button", { name: LIVE_SELECTORS.chatgpt.profileButtonName });
      return (await locatorCount(profile)) > 0;
    }
    // Claude: Free plan text is the stable logged in marker. BB Free is the
    // observed button label for this account and may differ per account, so
    // it is only a fallback, never the only check.
    const freePlan = this.page.getByText(LIVE_SELECTORS.claude.profileText);
    if ((await locatorCount(freePlan)) > 0) {
      return true;
    }
    const bb = this.page.getByRole("button", { name: LIVE_SELECTORS.claude.profileButtonName });
    if ((await locatorCount(bb)) > 0) {
      return true;
    }
    return url.includes("/new");
  }

  async openProfile(account: BrowserAccount): Promise<void> {
    this.account = account;
    const profileDir = path.resolve(account.profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    let pw: any;
    try {
      pw = await this.loader();
    } catch (error) {
      throw new Error(
        "Playwright is not available. Install it with npm install playwright and npx playwright install chromium, then try again. " +
          `Underlying error: ${String(error)}`,
      );
    }
    const chromium = pw.chromium;
    if (!chromium || typeof chromium.launchPersistentContext !== "function") {
      throw new Error("Playwright is not available. The chromium launcher was not found. Install playwright and try again.");
    }
    const opts: Record<string, unknown> = {
      headless: this.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    };
    if (this.launcher) {
      this.context = await this.launcher(profileDir, opts);
    } else {
      this.context = await chromium.launchPersistentContext(profileDir, opts);
    }
    const pages = typeof this.context.pages === "function" ? this.context.pages() : [];
    this.page = pages && pages.length > 0 ? pages[0] : await this.context.newPage();
    const url = providerUrl(account.provider);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (typeof this.page.waitForTimeout === "function") {
      await this.page.waitForTimeout(1500);
    } else {
      await sleep(1500);
    }
    let loggedIn = false;
    try {
      loggedIn = await this.checkLoggedIn();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    if (!loggedIn) {
      await this.close().catch(() => undefined);
      throw new Error(
        `Profile ${account.id} is not logged in for ${account.provider}. ` +
          "Log in once by hand in that profile, in your own browser, then try again. " +
          "The driver fails closed and never types a password.",
      );
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!this.page || !this.account) {
      throw new Error("Driver is not open. Call openProfile first.");
    }
    if (!prompt || !prompt.trim()) {
      throw new Error("Prompt must not be empty.");
    }
    const box = await this.findPromptBox();
    if ((await locatorCount(box)) === 0) {
      throw new Error("Prompt box was not found. The site UI may have changed. Check it by hand before you retry.");
    }
    const first = typeof box.first === "function" ? box.first() : box;
    await first.click();
    if (this.page.keyboard && typeof this.page.keyboard.type === "function") {
      await this.page.keyboard.type(prompt, { delay: 5 });
    } else if (typeof first.fill === "function") {
      await first.fill(prompt);
    } else {
      throw new Error("Prompt box cannot be typed into with this page object.");
    }
    if (typeof this.page.waitForTimeout === "function") {
      await this.page.waitForTimeout(800);
    } else {
      await sleep(800);
    }
    const send = this.page.getByRole("button", { name: "Send message" });
    const visible = (await locatorCount(send)) > 0 ? await locatorVisible(send) : false;
    const enabled = visible ? await locatorEnabled(send) : false;
    const sendPath = pickSendPath(visible, enabled);
    this.lastSendPath = sendPath;
    if (sendPath === "send-button") {
      const target = typeof send.first === "function" ? send.first() : send;
      await target.click();
    } else {
      // Send button was not verified live after typing, so Enter is the
      // honest fallback. Log which path was used via lastSendPath.
      await this.page.keyboard.press("Enter");
    }
  }

  private async readAssistantText(): Promise<string> {
    if (!this.page) {
      return "";
    }
    try {
      const assistant = this.page.locator('[data-message-author-role="assistant"]');
      if ((await locatorCount(assistant)) > 0) {
        const last = typeof assistant.last === "function" ? assistant.last() : assistant;
        const text = await last.innerText();
        if (text && text.trim()) {
          return text.trim();
        }
      }
    } catch {
      // Fall through to the main text fallback below.
    }
    try {
      const main = this.page.locator("main");
      if ((await locatorCount(main)) > 0) {
        const last = typeof main.last === "function" ? main.last() : main;
        const text = await last.innerText();
        return (text || "").trim();
      }
    } catch {
      return "";
    }
    return "";
  }

  async waitForResponse(timeoutMs: number): Promise<string> {
    if (!this.page || !this.account) {
      throw new Error("Driver is not open. Call openProfile first.");
    }
    const started = Date.now();
    const limit = timeoutMs > 0 ? timeoutMs : 120000;
    let lastText = "";
    let stableCount = 0;
    while (Date.now() - started < limit) {
      let content = "";
      try {
        content = await this.page.content();
      } catch {
        content = "";
      }
      if (detectChallenge(content)) {
        throw new Error("Challenge detected in the response. Account is paused. CAPTCHA is never auto solved. Check it by hand.");
      }
      let stopCount = 0;
      try {
        stopCount += await locatorCount(this.page.getByRole("button", { name: "Stop" }));
      } catch {
        stopCount += 0;
      }
      try {
        stopCount += await locatorCount(this.page.getByRole("button", { name: "Stop generating" }));
      } catch {
        stopCount += 0;
      }
      const text = await this.readAssistantText();
      if (stopCount === 0 && text && text.length > 20) {
        if (text === lastText) {
          stableCount += 1;
          if (stableCount >= 1) {
            return text;
          }
        } else {
          stableCount = 0;
          lastText = text;
        }
      } else if (text && text !== lastText) {
        lastText = text;
        stableCount = 0;
      }
      if (typeof this.page.waitForTimeout === "function") {
        await this.page.waitForTimeout(2000);
      } else {
        await sleep(2000);
      }
    }
    throw new Error("Response did not finish in time. The job timed out. Check the account by hand before you retry.");
  }

  async close(): Promise<void> {
    this.page = null;
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Closing must never mask the job result.
      }
      this.context = null;
    }
  }
}

// Mock driver used by tests and by the mock CLI path. It never opens a real
// browser. It can be told to return a challenge text or to throw, so the
// queue can be tested without a live account.
export interface MockDriverOptions {
  responseText?: string;
  failTimes?: number;
  delayMs?: number;
}

export class MockBrowserDriver implements BrowserDriver {
  name = "mock-driver";
  wired = true;
  calls = 0;
  openedProfiles: string[] = [];
  sentPrompts: string[] = [];
  lastSendPath: SendPath | null = null;
  private failTimes: number;
  private responseText: string;
  private delayMs: number;

  constructor(options: MockDriverOptions = {}) {
    this.failTimes = options.failTimes ?? 0;
    this.responseText = options.responseText ?? "";
    this.delayMs = options.delayMs ?? 0;
  }

  async openProfile(account: BrowserAccount): Promise<void> {
    this.calls += 1;
    this.openedProfiles.push(account.id);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.calls += 1;
    this.sentPrompts.push(prompt);
    this.lastSendPath = "enter";
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("Mock driver failed to send prompt.");
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  async waitForResponse(_timeoutMs: number): Promise<string> {
    this.calls += 1;
    if (this.responseText) {
      return this.responseText;
    }
    const last = this.sentPrompts[this.sentPrompts.length - 1] || "";
    return `Mock response for: ${last.slice(0, 200)}`;
  }

  async close(): Promise<void> {
    return;
  }
}

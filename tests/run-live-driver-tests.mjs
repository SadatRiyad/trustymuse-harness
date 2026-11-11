import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.2 live driver tests. Plain Node, no test framework.
// Run with: npm test, or node tests/run-live-driver-tests.mjs after npm run build.
// These tests use fake pages only. No real browser is launched, no live
// network call is made, no real account is used, and no prompt is sent.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const browser = await import(path.join(distDir, "session", "browser.js"));
const {
  LIVE_SELECTORS,
  PlaywrightBrowserDriver,
  pickSendPath,
  isLoginUrl,
  detectChallenge,
} = browser;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-live-driver-test-"));
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

function makeLocator(opts = {}) {
  const count = opts.count ?? 1;
  const text = opts.text ?? "";
  const loc = {
    count: async () => count,
    first: () => loc,
    last: () => loc,
    click: async () => {
      loc.clicked = true;
    },
    fill: async () => {},
    isVisible: async () => opts.visible ?? true,
    isEnabled: async () => opts.enabled ?? true,
    innerText: async () => text,
    clicked: false,
  };
  return loc;
}

function makeFakePage(cfg = {}) {
  const state = {
    url: cfg.startUrl || "https://chatgpt.com/",
    typed: "",
    pressed: "",
    clickedSend: false,
  };
  const sendLoc = makeLocator({
    count: cfg.sendPresent ? 1 : 0,
    visible: cfg.sendPresent ? true : false,
    enabled: cfg.sendEnabled ?? true,
  });
  const origClick = sendLoc.click.bind(sendLoc);
  sendLoc.click = async () => {
    state.clickedSend = true;
    await origClick();
  };
  const page = {
    _state: state,
    url: () => state.url,
    goto: async (target) => {
      if (String(target).includes("claude.ai")) {
        state.url = cfg.afterGotoUrl || "https://claude.ai/new";
      } else {
        state.url = String(target);
      }
    },
    waitForTimeout: async () => {},
    content: async () => (cfg.challengeContent ? "<html>Verify you are human, CAPTCHA challenge</html>" : "<html>chat page</html>"),
    keyboard: {
      type: async (text) => {
        state.typed = text;
      },
      press: async (key) => {
        state.pressed = key;
      },
    },
    getByRole: (role, opts = {}) => {
      const name = opts.name || "";
      if (role === "textbox") {
        if (name === "Ask ChatGPT" || name === "Write your prompt to Claude") {
          return makeLocator({ count: cfg.promptPresent === false ? 0 : 1 });
        }
        return makeLocator({ count: 0 });
      }
      if (role === "button") {
        if (name === "Send message") {
          return sendLoc;
        }
        if (name === "Open profile menu") {
          return makeLocator({ count: cfg.profilePresent === false ? 0 : 1 });
        }
        if (name === "BB Free") {
          return makeLocator({ count: cfg.profilePresent === false ? 0 : 1 });
        }
        if (name === "Stop" || name === "Stop generating") {
          return makeLocator({ count: 0 });
        }
        return makeLocator({ count: 0 });
      }
      return makeLocator({ count: 0 });
    },
    getByText: (text) => {
      if (text === "Free plan") {
        return makeLocator({ count: cfg.profilePresent === false ? 0 : 1 });
      }
      return makeLocator({ count: 0 });
    },
    getByPlaceholder: (text) => {
      if (text === "Ask ChatGPT" || text === "How can I help you today?") {
        return makeLocator({ count: cfg.promptPresent === false ? 0 : 1 });
      }
      return makeLocator({ count: 0 });
    },
    locator: (selector) => {
      if (String(selector).includes("data-message-author-role")) {
        return makeLocator({ count: 1, text: cfg.assistantText || "This is a fake assistant reply with enough content to count as a response." });
      }
      if (String(selector) === "main") {
        return makeLocator({ count: 1, text: cfg.assistantText || "Fallback main text with enough content to count." });
      }
      return makeLocator({ count: 0 });
    },
  };
  return page;
}

function makeFakeContext(page) {
  return {
    pages: () => [page],
    newPage: async () => page,
    close: async () => {},
  };
}

function makeAccount(provider, id) {
  return {
    id,
    provider,
    label: `Test ${provider}`,
    profileDir: path.join(tmp, `${provider}-${id}`),
    status: "active",
    lastUsed: null,
    dailyCount: 0,
    dailyDate: null,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

// Test 1: selector constants use only live verified values, no id or testid.
assert.strictEqual(LIVE_SELECTORS.chatgpt.promptName, "Ask ChatGPT", "ChatGPT prompt name must be Ask ChatGPT");
assert.strictEqual(LIVE_SELECTORS.chatgpt.promptPlaceholder, "Ask ChatGPT", "ChatGPT placeholder must be Ask ChatGPT");
assert.strictEqual(LIVE_SELECTORS.chatgpt.profileButtonName, "Open profile menu", "ChatGPT profile button must be Open profile menu");
assert.strictEqual(LIVE_SELECTORS.chatgpt.modelPickerName, null, "ChatGPT must have no verified model picker");
assert.strictEqual(LIVE_SELECTORS.claude.promptName, "Write your prompt to Claude", "Claude prompt name must be Write your prompt to Claude");
assert.strictEqual(LIVE_SELECTORS.claude.promptPlaceholder, "How can I help you today?", "Claude placeholder must be How can I help you today?");
assert.strictEqual(LIVE_SELECTORS.claude.modelPickerName, "Model: Sonnet 5.5 Medium", "Claude model picker must be Model: Sonnet 5.5 Medium");
assert.strictEqual(LIVE_SELECTORS.claude.profileText, "Free plan", "Claude profile text must be Free plan");
const flat = JSON.stringify(LIVE_SELECTORS);
assert.strictEqual(flat.includes("data-testid"), false, "Selectors must not contain a data-testid");
assert.strictEqual(flat.includes("testid"), false, "Selectors must not contain testid");
assert.ok(LIVE_SELECTORS.chatgpt.unverified.includes("send button after typing"), "ChatGPT send after typing must be listed as unverified");
assert.ok(LIVE_SELECTORS.claude.unverified.includes("model picker menu contents"), "Claude model menu must be listed as unverified");
ok("selector constants use only live verified values, no id or testid");

// Test 2: send fallback logic.
assert.strictEqual(pickSendPath(true, true), "send-button", "Visible and enabled send button must win");
assert.strictEqual(pickSendPath(true, false), "enter", "Disabled send button must fall back to Enter");
assert.strictEqual(pickSendPath(false, false), "enter", "Missing send button must fall back to Enter");
assert.strictEqual(pickSendPath(false, true), "enter", "Invisible send button must fall back to Enter");
ok("send fallback logic picks send button only when visible and enabled");

// Test 3: login URL detection.
assert.strictEqual(isLoginUrl("claude", "https://claude.ai/login"), true, "Claude login URL must be detected");
assert.strictEqual(isLoginUrl("claude", "https://claude.ai/new"), false, "Claude new chat URL must not be a login URL");
assert.strictEqual(isLoginUrl("chatgpt", "https://chatgpt.com/auth/login"), true, "ChatGPT auth login URL must be detected");
assert.strictEqual(isLoginUrl("chatgpt", "https://chatgpt.com/"), false, "ChatGPT home URL must not be a login URL");
assert.strictEqual(detectChallenge("Drag the correct item that fits the pattern"), true, "Drag challenge text must be detected");
ok("login URL detection and challenge detection work");

// Test 4: real driver fails closed when Playwright is not available.
{
  const driver = new PlaywrightBrowserDriver({
    loader: async () => {
      throw new Error("Cannot find module 'playwright'");
    },
  });
  assert.strictEqual(driver.wired, true, "Real driver must report wired in V1.2");
  const account = makeAccount("chatgpt", "main");
  await assert.rejects(
    () => driver.openProfile(account),
    /Playwright is not available/,
    "Driver must fail closed with a clear Playwright message",
  );
  ok("real driver fails closed when Playwright is not available");
}

// Test 5: real driver fails closed when the profile is not logged in.
{
  const page = makeFakePage({
    startUrl: "https://claude.ai/login",
    afterGotoUrl: "https://claude.ai/login",
    promptPresent: false,
    profilePresent: false,
  });
  const driver = new PlaywrightBrowserDriver({
    loader: async () => ({ chromium: { launchPersistentContext: async () => makeFakeContext(page) } }),
    launcher: async () => makeFakeContext(page),
  });
  const account = makeAccount("claude", "main");
  await assert.rejects(
    () => driver.openProfile(account),
    /not logged in/,
    "Driver must fail closed when the profile is still on the login page",
  );
  ok("real driver fails closed when the profile is not logged in");
}

// Test 6: send fallback uses Enter when the send button is absent.
{
  const page = makeFakePage({ sendPresent: false, sendEnabled: false });
  const driver = new PlaywrightBrowserDriver({
    loader: async () => ({ chromium: { launchPersistentContext: async () => makeFakeContext(page) } }),
    launcher: async () => makeFakeContext(page),
  });
  const account = makeAccount("chatgpt", "main");
  await driver.openProfile(account);
  await driver.sendPrompt("Hello, test prompt for fallback.");
  assert.strictEqual(driver.lastSendPath, "enter", "Send path must be enter when the send button is absent");
  assert.strictEqual(page._state.pressed, "Enter", "Enter must be pressed when the send button is absent");
  assert.strictEqual(page._state.clickedSend, false, "Send button must not be clicked when it is absent");
  await driver.close();
  ok("send fallback uses Enter when the send button is absent");
}

// Test 7: send button is used when it is visible and enabled.
{
  const page = makeFakePage({ sendPresent: true, sendEnabled: true });
  const driver = new PlaywrightBrowserDriver({
    loader: async () => ({ chromium: { launchPersistentContext: async () => makeFakeContext(page) } }),
    launcher: async () => makeFakeContext(page),
  });
  const account = makeAccount("chatgpt", "main");
  await driver.openProfile(account);
  await driver.sendPrompt("Hello, test prompt for send button.");
  assert.strictEqual(driver.lastSendPath, "send-button", "Send path must be send-button when the button is visible and enabled");
  assert.strictEqual(page._state.clickedSend, true, "Send button must be clicked when it is visible and enabled");
  assert.strictEqual(page._state.pressed, "", "Enter must not be pressed when the send button is used");
  await driver.close();
  ok("send button is used when it is visible and enabled");
}

// Test 8: waitForResponse returns the last assistant text, with no live network.
{
  const page = makeFakePage({
    assistantText: "This is a fake assistant reply with enough content to count as a finished response.",
  });
  const driver = new PlaywrightBrowserDriver({
    loader: async () => ({ chromium: { launchPersistentContext: async () => makeFakeContext(page) } }),
    launcher: async () => makeFakeContext(page),
  });
  const account = makeAccount("claude", "main");
  await driver.openProfile(account);
  const text = await driver.waitForResponse(10000);
  assert.ok(text.includes("fake assistant reply"), "waitForResponse must return the assistant text");
  await driver.close();
  ok("waitForResponse returns the last assistant text");
}

// Test 9: waitForResponse fails closed on challenge text.
// The challenge appears after login, not during openProfile, so the fake
// page only returns challenge content once the test turns it on.
{
  const cfg = {
    challengeContent: false,
    assistantText: "This text must not be returned when a challenge is present.",
  };
  const page = makeFakePage(cfg);
  const driver = new PlaywrightBrowserDriver({
    loader: async () => ({ chromium: { launchPersistentContext: async () => makeFakeContext(page) } }),
    launcher: async () => makeFakeContext(page),
  });
  const account = makeAccount("chatgpt", "main");
  await driver.openProfile(account);
  cfg.challengeContent = true;
  await assert.rejects(
    () => driver.waitForResponse(10000),
    /Challenge detected/,
    "waitForResponse must fail closed on challenge text",
  );
  await driver.close();
  ok("waitForResponse fails closed on challenge text");
}

console.log(`All ${passed} live driver test groups passed. Temp dir: ${tmp}`);

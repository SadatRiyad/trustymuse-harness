import * as fs from "fs";
import * as path from "path";
import { getModel } from "./registry";
import { routeTask } from "./router";

// Subscription packet flow. This is the safe way to use a normal chat account.
// The harness writes a packet file. The user copies it into their own chat
// app, runs it there, and pastes the result back. The harness then validates
// the result and logs it. No login, no automation, no scraping.
// Packet mode works for every connected subscription model at once, because
// a packet is plain text. The browser driver is a separate matter: it is
// wired only for chatgpt and claude (see registry.ts browserSupport).

export type PacketModel =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "grok"
  | "deepseek"
  | "perplexity"
  | "meta-ai"
  | "copilot"
  | "mistral";

export interface PacketInput {
  model: PacketModel;
  taskType: string;
  title: string;
  task: string;
  context?: string;
  expectedFormat?: string;
}

export interface PacketResult {
  model: PacketModel;
  taskType: string;
  title: string;
  filePath: string;
  content: string;
}

export function packetFileName(model: PacketModel, taskType: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  const date = new Date().toISOString().slice(0, 10);
  return `${model}-${taskType}-${slug}-${date}.md`;
}

export function buildPacketContent(input: PacketInput): string {
  const model = getModel(input.model);
  const route = routeTask(input.taskType);
  const expected = input.expectedFormat || "Return a clear draft with headings, short paragraphs, and a short checklist at the end.";
  const context = input.context || "No extra context was supplied. Ask for the missing fact instead of inventing it.";
  const lines: string[] = [];
  lines.push(`# Packet for ${model ? model.displayName : input.model}`);
  lines.push("");
  // The packet names the model and its chat URL, so the user always knows
  // exactly where to run it. For packet-only models this is the whole
  // connection: open the URL in your own app, paste this packet, run it.
  if (model && model.chatUrl) {
    lines.push(`Run this packet in your own ${model.displayName} app: ${model.chatUrl}`);
    lines.push("");
  }
  if (model && model.browserSupport === "packet-only") {
    lines.push("Browser mode is not wired for this model yet. Packet mode is the only way to run it through the harness for now.");
    lines.push("");
  }
  lines.push(`Task type: ${input.taskType}`);
  lines.push(`Slot: ${route.slot}`);
  lines.push(`Title: ${input.title}`);
  lines.push(`Tier: ${route.tier}`);
  lines.push("");
  lines.push("## Safety rules for this packet");
  lines.push("Do not include any password, API key, or secret in your reply.");
  lines.push("Do not invent facts, links, prices, or dates. If a fact is missing, say it is missing.");
  lines.push("Keep the tone clear and natural. Avoid generic filler.");
  lines.push("");
  lines.push("## Task");
  lines.push(input.task);
  lines.push("");
  lines.push("## Context");
  lines.push(context);
  lines.push("");
  lines.push("## Expected output format");
  lines.push(expected);
  lines.push("");
  lines.push("## Verification");
  lines.push(route.verification);
  lines.push("");
  lines.push("## How to return the result");
  lines.push("Paste the full result back to TrustyMUSE. Keep the headings from the expected format.");
  return lines.join("\n");
}

export function generatePacket(input: PacketInput, outputDir?: string): PacketResult {
  const base = outputDir || path.resolve(__dirname, "..", "packets");
  fs.mkdirSync(base, { recursive: true });
  const content = buildPacketContent(input);
  const fileName = packetFileName(input.model, input.taskType, input.title);
  const filePath = path.join(base, fileName);
  fs.writeFileSync(filePath, content + "\n", "utf-8");
  return { model: input.model, taskType: input.taskType, title: input.title, filePath, content };
}

export function validatePacketResult(resultText: string): { valid: boolean; reason: string } {
  if (!resultText || !resultText.trim()) {
    return { valid: false, reason: "Result is empty." };
  }
  if (resultText.trim().length < 20) {
    return { valid: false, reason: "Result is too short to be a useful draft. It must be at least 20 characters." };
  }
  return { valid: true, reason: "Result has content and can be checked against the brief." };
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProjectEntry } from "./projects";

// Project context for packets and browser jobs, V1.3.
// Builds a short, safe context block from a connected project. It never
// reads file contents, and it never includes secrets. Only a top-level file
// listing is included, at most 20 entries, with sensitive names removed.

const EXCLUDED_NAMES = new Set([".env", ".git", "node_modules", "profiles", "state", "credentials"]);
const EXCLUDED_SUFFIXES = [".pem", ".key"];
const EXCLUDED_MARKERS = ["credential", "secret"];

function isExcludedName(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) {
    return true;
  }
  const lower = name.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  if (EXCLUDED_MARKERS.some((marker) => lower.includes(marker))) {
    return true;
  }
  return false;
}

export function listProjectFiles(project: ProjectEntry, maxEntries = 20): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(project.rootPath);
  } catch {
    return [];
  }
  const visible = entries.filter((entry) => !isExcludedName(entry)).sort();
  return visible.slice(0, maxEntries);
}

export function projectFileListing(project: ProjectEntry, maxEntries = 20): string {
  let total = 0;
  try {
    total = fs.readdirSync(project.rootPath).length;
  } catch {
    return "Project folder could not be listed. Ask the user for the missing fact instead of inventing it.";
  }
  const visible = listProjectFiles(project, maxEntries);
  if (visible.length === 0) {
    return "No listable files at the top level. Sensitive names are always excluded.";
  }
  const lines = visible.map((entry) => `- ${entry}`);
  if (total > visible.length) {
    lines.push(`- ... and more entries not listed (top ${maxEntries} shown, sensitive names excluded).`);
  }
  return lines.join("\n");
}

export function relativeRootPath(project: ProjectEntry): string {
  const workspace = path.join(os.homedir(), "workspace");
  const relative = path.relative(workspace, project.rootPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/workspace/${relative}`;
  }
  return project.rootPath;
}

export function buildProjectContext(project: ProjectEntry, taskType: string): string {
  const lines: string[] = [];
  lines.push(`Project: ${project.name} (${project.id})`);
  lines.push(`Kind: ${project.kind}`);
  if (project.stack) {
    lines.push(`Stack: ${project.stack}`);
  }
  if (project.liveUrl) {
    lines.push(`Live URL: ${project.liveUrl}`);
  }
  if (project.repo) {
    lines.push(`Repo: ${project.repo}`);
  }
  lines.push(`Root: ${relativeRootPath(project)}`);
  lines.push(`Allowed task types for this project: ${project.allowedTaskTypes.join(", ")}`);
  lines.push(`This job type: ${taskType}`);
  if (project.notes) {
    lines.push(`Project notes: ${project.notes}`);
  }
  lines.push("");
  lines.push("Boundaries for this project:");
  lines.push("- Draft only. Do not publish, send, merge, or deploy anything.");
  lines.push("- Do not include any password, API key, or secret in the reply.");
  lines.push("- Do not invent facts, links, prices, or dates about this project. If a fact is missing, say it is missing.");
  lines.push("- If HOLD is on, all writes are blocked. No change is applied without per-item user approval.");
  lines.push("");
  lines.push("Top-level files in this project (names only, no contents, sensitive names excluded):");
  lines.push(projectFileListing(project));
  return lines.join("\n");
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProjectKind } from "./projects";

// Read-only discovery, V1.3. Scans one level deep under ~/workspace and
// ~/workspace/github-repos, and reports what looks like a project. It never
// auto-connects anything and never writes anything. Connecting is always an
// explicit project-add by the user, after they have checked the candidate.

export interface ProjectCandidate {
  dirName: string;
  rootPath: string;
  suggestedId: string;
  suggestedName: string;
  kind: ProjectKind;
  stack: string;
  signals: string[];
  reason: string;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "state",
  "profiles",
  "trustymuse-harness",
  "github-repos",
]);

function exists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

function isDir(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasPythonFiles(dir: string): boolean {
  try {
    if (fs.readdirSync(dir).some((entry) => entry.endsWith(".py") && fs.statSync(path.join(dir, entry)).isFile())) {
      return true;
    }
    // Automation repos often keep code one level down, in scripts/.
    const scriptsDir = path.join(dir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      return fs.readdirSync(scriptsDir).some((entry) => entry.endsWith(".py"));
    }
    return false;
  } catch {
    return false;
  }
}

function hasExtensionManifest(dir: string): boolean {
  return exists(dir, "manifest.json") || exists(path.join(dir, "extension"), "manifest.json");
}

function detectStack(dir: string, pkg: Record<string, unknown> | null, signals: string[]): string {
  const parts: string[] = [];
  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) || {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) || {}),
  };
  if (pkg || signals.includes("server.js") || signals.includes("server/package.json")) {
    parts.push("Node.js");
    if (deps.express) {
      parts.push("Express");
    }
    if (deps.mongoose) {
      parts.push("MongoDB");
    }
    if (deps.stripe) {
      parts.push("Stripe");
    }
    if (deps["@libsql/client"]) {
      parts.push("libsql/Turso");
    }
    if (deps.next) {
      parts.push("Next.js");
    }
    if (deps.react) {
      parts.push("React");
    }
  }
  if (hasPythonFiles(dir)) {
    parts.push("Python");
  }
  if (hasExtensionManifest(dir)) {
    parts.push("Chrome extension");
  }
  if (signals.includes("index.html") && !pkg && !signals.includes("server.js")) {
    parts.push("static HTML");
  }
  return parts.length > 0 ? parts.join(", ") : "Unknown, check the folder by hand.";
}

function classify(dir: string, signals: string[], pkg: Record<string, unknown> | null): { kind: ProjectKind; reason: string } {
  const hasManifest = hasExtensionManifest(dir);
  const hasServer = signals.includes("server.js") || signals.includes("server/package.json");
  const hasIndex = signals.includes("index.html");
  const hasPkg = pkg !== null;
  if (hasManifest && !hasPkg && !hasServer && !hasIndex) {
    return { kind: "extension", reason: "Has an extension manifest and no web server or site files." };
  }
  if (hasServer && !hasIndex && !hasPkg) {
    return { kind: "api", reason: "Has a server folder with a Node package, and no site index page at the top level." };
  }
  if (hasPkg || hasServer || hasIndex) {
    const detail = hasManifest ? " It also has a Chrome extension." : "";
    return { kind: "web-app", reason: `Has ${signals.filter((s) => s !== ".git" && s !== "README.md").join(", ") || "web files"}.${detail}` };
  }
  if (hasIndex) {
    return { kind: "static-site", reason: "Has an index.html and no server code." };
  }
  if (signals.includes("README.md") && signals.includes("docs/")) {
    return { kind: "docs", reason: "Has a README and a docs folder, and no code signals." };
  }
  return { kind: "repo-only", reason: "Has a git repo or README, but no web, API, or extension code signals at the top level." };
}

function scanOneDir(dir: string): ProjectCandidate | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const signals: string[] = [];
  if (exists(dir, "package.json")) {
    signals.push("package.json");
  }
  if (exists(dir, "server.js")) {
    signals.push("server.js");
  }
  if (exists(path.join(dir, "server"), "package.json")) {
    signals.push("server/package.json");
  }
  if (exists(dir, "index.html")) {
    signals.push("index.html");
  }
  if (exists(dir, "README.md")) {
    signals.push("README.md");
  }
  if (exists(dir, ".git")) {
    signals.push(".git");
  }
  if (hasExtensionManifest(dir)) {
    signals.push("extension manifest");
  }
  if (isDir(dir, "docs")) {
    signals.push("docs/");
  }
  if (isDir(dir, "src")) {
    signals.push("src/");
  }
  if (signals.length === 0) {
    return null;
  }
  const pkg = readPackageJson(dir);
  const { kind, reason } = classify(dir, signals, pkg);
  const dirName = path.basename(dir);
  const suggestedId = dirName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const suggestedName = pkg && typeof pkg.name === "string" ? pkg.name : dirName;
  return {
    dirName,
    rootPath: dir,
    suggestedId,
    suggestedName,
    kind,
    stack: detectStack(dir, pkg, signals),
    signals,
    reason,
  };
}

export function discoverProjects(workspaceRoot?: string): ProjectCandidate[] {
  const workspace = workspaceRoot ? path.resolve(workspaceRoot) : path.join(os.homedir(), "workspace");
  const roots = [workspace, path.join(workspace, "github-repos")];
  const candidates: ProjectCandidate[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) {
        continue;
      }
      const full = path.join(root, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      const candidate = scanOneDir(full);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  candidates.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
  return candidates;
}

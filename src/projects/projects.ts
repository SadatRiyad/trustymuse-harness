import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stateDir } from "../audit";
import { TASK_TYPES, TaskType } from "../router";

// Project registry for V1.3. Any running project, or any new project, can
// connect to the harness. A project is a scope: every harness job can be
// tied to one project, with that project's context, boundaries, and audit
// trail. Connecting a project never deploys it, never publishes from it,
// and never stores a credential. A project only ever allows read and draft
// by default. Publish, send, merge, and deploy are rejected at validation
// time and are never automatic.

export type ProjectKind = "web-app" | "api" | "extension" | "static-site" | "docs" | "repo-only";
export type ProjectStatus = "active" | "paused" | "archived";
export type ProjectAction = "read" | "draft" | "publish" | "send" | "merge" | "deploy";

export const PROJECT_KINDS: ProjectKind[] = ["web-app", "api", "extension", "static-site", "docs", "repo-only"];
export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "archived"];
export const PROJECT_ACTIONS: ProjectAction[] = ["read", "draft", "publish", "send", "merge", "deploy"];
export const DEFAULT_ALLOWED_ACTIONS: ProjectAction[] = ["read", "draft"];
export const FORBIDDEN_PROJECT_ACTIONS: ProjectAction[] = ["publish", "send", "merge", "deploy"];
export const DEFAULT_MAX_PROJECTS = 20;

export interface ProjectEntry {
  id: string;
  name: string;
  kind: ProjectKind;
  status: ProjectStatus;
  rootPath: string;
  liveUrl?: string;
  repo?: string;
  stack?: string;
  allowedTaskTypes: TaskType[];
  allowedActions: ProjectAction[];
  notes: string;
  createdAt: string;
  connectedAt: string;
  lastUsed: string | null;
}

export interface ProjectInput {
  id: string;
  name: string;
  kind: string;
  rootPath: string;
  liveUrl?: string;
  repo?: string;
  stack?: string;
  allowedTaskTypes?: string[];
  allowedActions?: string[];
  notes?: string;
}

export interface ProjectOptions {
  rootDir?: string;
  workspaceRoot?: string;
  maxProjects?: number;
  tenantId?: string;
}

export function projectsFilePath(rootDir?: string, tenantId?: string): string {
  return path.join(stateDir(rootDir, tenantId), "projects.json");
}

// The workspace is the only place a project may live. The harness folder
// itself is not a connectable project root.
export function workspaceRootFor(workspaceRoot?: string): string {
  if (workspaceRoot) {
    return path.resolve(workspaceRoot);
  }
  return path.join(os.homedir(), "workspace");
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

// Fail closed if anyone tries to smuggle a secret into a project record.
// Checks both field names and string values, case-insensitive. Called on
// every load and every save, following the accounts.ts pattern.
export const SECRET_MARKERS = ["password", "token", "secret", "apikey", "api_key", "sessiontoken", "cookie"];

export function assertNoSecretsInProject(record: unknown): void {
  if (!record || typeof record !== "object") {
    return;
  }
  const entries = Object.entries(record as Record<string, unknown>);
  for (const [key, value] of entries) {
    const keyLower = key.toLowerCase();
    if (SECRET_MARKERS.some((marker) => keyLower.includes(marker))) {
      throw new Error(`Project record must never contain a field named ${key}. No password or token is stored.`);
    }
    if (typeof value === "string") {
      const valueLower = value.toLowerCase();
      const hit = SECRET_MARKERS.find((marker) => valueLower.includes(marker));
      if (hit) {
        throw new Error(`Project field ${key} must never contain ${hit}. No password or token is stored.`);
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const itemLower = item.toLowerCase();
          const hit = SECRET_MARKERS.find((marker) => itemLower.includes(marker));
          if (hit) {
            throw new Error(`Project field ${key} must never contain ${hit}. No password or token is stored.`);
          }
        }
      }
    }
  }
}

// Resolve and validate a project root. It must exist, be a directory, and
// sit inside the workspace. Anything outside, including /tmp, /etc, the home
// directory itself, and any .. escape, is rejected.
export function resolveProjectRoot(rootPath: string, workspaceRoot?: string): string {
  if (!rootPath || !rootPath.trim()) {
    throw new Error("Project root path must not be empty.");
  }
  const workspace = workspaceRootFor(workspaceRoot);
  const resolved = path.resolve(rootPath);
  const inside = resolved === workspace || resolved.startsWith(workspace + path.sep);
  if (!inside) {
    throw new Error(`Project root ${rootPath} must be inside the workspace (${workspace}). Paths outside it, including /tmp and /etc, are rejected.`);
  }
  if (resolved === workspace) {
    throw new Error("Project root must be a single project folder, not the whole workspace.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Project root ${rootPath} does not exist on disk. Connect a folder that exists.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Project root ${rootPath} is not a directory.`);
  }
  return resolved;
}

export function validateProjectInput(input: ProjectInput, existing: ProjectEntry[], options: ProjectOptions = {}): void {
  if (!isValidId(input.id)) {
    throw new Error("Project id must be a lowercase slug, letters, digits, or short hyphens, for example my-project.");
  }
  if (existing.some((p) => p.id === input.id)) {
    throw new Error(`Project id ${input.id} already exists. Use project-list to see connected projects.`);
  }
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
  if (existing.length >= maxProjects) {
    throw new Error(`Project limit reached. At most ${maxProjects} projects can be connected.`);
  }
  if (!input.name || !input.name.trim()) {
    throw new Error("Project name must not be empty.");
  }
  if (!(PROJECT_KINDS as string[]).includes(input.kind)) {
    throw new Error(`Project kind must be one of ${PROJECT_KINDS.join(", ")}.`);
  }
  resolveProjectRoot(input.rootPath, options.workspaceRoot);
  if (input.liveUrl) {
    if (!/^https?:\/\/\S+$/.test(input.liveUrl.trim())) {
      throw new Error("Live URL must start with http:// or https://.");
    }
  }
  if (input.repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo.trim())) {
      throw new Error("Repo must look like owner/repo, for example my-org/my-repo.");
    }
  }
  const taskTypes = input.allowedTaskTypes ?? [...TASK_TYPES];
  for (const taskType of taskTypes) {
    if (!(TASK_TYPES as string[]).includes(taskType)) {
      throw new Error(`Task type ${taskType} is not a known harness task type. Known types: ${TASK_TYPES.join(", ")}.`);
    }
  }
  const actions = input.allowedActions ?? [...DEFAULT_ALLOWED_ACTIONS];
  for (const action of actions) {
    if (!(PROJECT_ACTIONS as string[]).includes(action)) {
      throw new Error(`Action ${action} is not a known project action.`);
    }
    if ((FORBIDDEN_PROJECT_ACTIONS as string[]).includes(action)) {
      throw new Error(`Action ${action} can never be allowed for a project. Projects allow read and draft only. Publish, send, merge, and deploy need per-item user approval and are never automatic.`);
    }
  }
  assertNoSecretsInProject(input);
}

export function loadProjects(rootDir?: string, tenantId?: string): ProjectEntry[] {
  const file = projectsFilePath(rootDir, tenantId);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const projects = parsed as ProjectEntry[];
    for (const project of projects) {
      assertNoSecretsInProject(project);
    }
    return projects;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must never contain")) {
      throw error;
    }
    return [];
  }
}

export function saveProjects(projects: ProjectEntry[], rootDir?: string, tenantId?: string): void {
  for (const project of projects) {
    assertNoSecretsInProject(project);
  }
  const dir = stateDir(rootDir, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projectsFilePath(rootDir, tenantId), JSON.stringify(projects, null, 2) + "\n", "utf-8");
}

export function addProject(input: ProjectInput, options: ProjectOptions = {}): ProjectEntry {
  const existing = loadProjects(options.rootDir, options.tenantId);
  validateProjectInput(input, existing, options);
  const now = new Date().toISOString();
  const project: ProjectEntry = {
    id: input.id,
    name: input.name.trim(),
    kind: input.kind as ProjectKind,
    status: "active",
    rootPath: resolveProjectRoot(input.rootPath, options.workspaceRoot),
    liveUrl: input.liveUrl ? input.liveUrl.trim() : undefined,
    repo: input.repo ? input.repo.trim() : undefined,
    stack: input.stack ? input.stack.trim() : undefined,
    allowedTaskTypes: (input.allowedTaskTypes ?? [...TASK_TYPES]) as TaskType[],
    allowedActions: (input.allowedActions ?? [...DEFAULT_ALLOWED_ACTIONS]) as ProjectAction[],
    notes: input.notes ? input.notes.trim() : "",
    createdAt: now,
    connectedAt: now,
    lastUsed: null,
  };
  assertNoSecretsInProject(project);
  existing.push(project);
  saveProjects(existing, options.rootDir, options.tenantId);
  return project;
}

export function getProject(id: string, rootDir?: string, tenantId?: string): ProjectEntry | null {
  return loadProjects(rootDir, tenantId).find((p) => p.id === id) || null;
}

export function listProjects(rootDir?: string, tenantId?: string): ProjectEntry[] {
  return loadProjects(rootDir, tenantId);
}

export function removeProject(id: string, rootDir?: string, tenantId?: string): ProjectEntry {
  const projects = loadProjects(rootDir, tenantId);
  const index = projects.findIndex((p) => p.id === id);
  if (index < 0) {
    throw new Error(`Project ${id} was not found. Use project-list to see connected projects.`);
  }
  const [removed] = projects.splice(index, 1);
  saveProjects(projects, rootDir, tenantId);
  return removed;
}

export function setProjectStatus(id: string, status: ProjectStatus, rootDir?: string, tenantId?: string): ProjectEntry {
  const projects = loadProjects(rootDir, tenantId);
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`Project ${id} was not found. Use project-list to see connected projects.`);
  }
  project.status = status;
  saveProjects(projects, rootDir, tenantId);
  return project;
}

export function pauseProject(id: string, rootDir?: string, tenantId?: string): ProjectEntry {
  return setProjectStatus(id, "paused", rootDir, tenantId);
}

export function markProjectUsed(id: string, rootDir?: string, tenantId?: string): ProjectEntry | null {
  const projects = loadProjects(rootDir, tenantId);
  const project = projects.find((p) => p.id === id);
  if (!project) {
    return null;
  }
  project.lastUsed = new Date().toISOString();
  saveProjects(projects, rootDir, tenantId);
  return project;
}

// Project writes (add, remove, pause) are blocked while HOLD is on.
// Read only commands are not writes and are not blocked by this check.
export function assertProjectWriteAllowed(hold: boolean): void {
  if (hold) {
    throw new Error("HOLD is on. All project writes are blocked until HOLD is lifted by the user.");
  }
}

export interface ProjectJobScope {
  project: ProjectEntry;
}

// Validate a job scoped to one project. Fail closed: the project must exist
// and be active, the task type must be allowed for that project, and HOLD
// must be off, because a scoped job writes a packet or runs a browser job.
export function scopeJobToProject(
  id: string,
  taskType: string,
  options: { rootDir?: string; hold?: boolean; tenantId?: string } = {},
): ProjectJobScope {
  if (options.hold) {
    throw new Error("HOLD is on. All project jobs are blocked until HOLD is lifted by the user.");
  }
  if (!id) {
    throw new Error("Provide a project with --project. Use project-list to see connected projects.");
  }
  const project = getProject(id, options.rootDir, options.tenantId);
  if (!project) {
    throw new Error(`Project ${id} was not found. Use project-list to see connected projects.`);
  }
  if (project.status !== "active") {
    throw new Error(`Project ${id} is ${project.status}. Only active projects can run jobs. Unpause it first, or use another project.`);
  }
  if (!(project.allowedTaskTypes as string[]).includes(taskType)) {
    throw new Error(`Task type ${taskType} is not allowed for project ${id}. Allowed types: ${project.allowedTaskTypes.join(", ")}.`);
  }
  return { project };
}

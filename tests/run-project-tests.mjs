import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// V1.3 project connector tests. Plain Node, no test framework.
// Temp dirs only, no live network, no live prompt, no GitHub, no deploy.
// Run with: npm test

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const {
  addProject,
  assertProjectWriteAllowed,
  getProject,
  listProjects,
  loadProjects,
  pauseProject,
  removeProject,
  scopeJobToProject,
} = await import(path.join(distDir, "projects", "projects.js"));
const { discoverProjects } = await import(path.join(distDir, "projects", "discover.js"));
const { buildProjectContext } = await import(path.join(distDir, "projects", "context.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustymuse-harness-projects-test-"));
const harnessRoot = path.join(tmp, "harness");
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(harnessRoot, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

function makeFakeProject(name, files) {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  return dir;
}

const trustytouchDir = makeFakeProject("trustytouch", {
  "package.json": JSON.stringify({ name: "trustytouch", dependencies: { "@libsql/client": "^0.18.0" } }),
  "server.js": "// fake server\n",
  "README.md": "# TrustyTouch\n",
});
const clienthuntDir = makeFakeProject("clienthunt-production", {
  "index.html": "<html></html>\n",
  "server/package.json": JSON.stringify({ name: "clienthunt-api-production", dependencies: { express: "^4.19.2" } }),
  "extension/manifest.json": JSON.stringify({ name: "ClientHunt AI" }),
  "README.md": "# ClientHuntAi\n",
});

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS: ${name}`);
}

const opts = { rootDir: harnessRoot, workspaceRoot: workspace, maxProjects: 20 };

// Test 1: add and list a project.
const added = addProject(
  { id: "trustytouch", name: "TrustyTouch", kind: "web-app", rootPath: trustytouchDir, liveUrl: "https://trustytouch.com", stack: "Node.js, libsql/Turso" },
  opts,
);
assert.strictEqual(added.id, "trustytouch", "Added project must keep its id");
assert.strictEqual(added.status, "active", "New project must start active");
assert.deepStrictEqual(added.allowedActions, ["read", "draft"], "New project must allow read and draft only");
assert.strictEqual(listProjects(harnessRoot).length, 1, "One project must be listed");
assert.strictEqual(getProject("trustytouch", harnessRoot)?.name, "TrustyTouch", "getProject must find the project by id");
ok("add and list a project");

// Test 2: duplicate id is rejected.
assert.throws(
  () => addProject({ id: "trustytouch", name: "TrustyTouch again", kind: "web-app", rootPath: trustytouchDir }, opts),
  /already exists/,
  "Duplicate project id must be rejected",
);
ok("duplicate project id is rejected");

// Test 3: a root path that does not exist is rejected.
assert.throws(
  () => addProject({ id: "ghost", name: "Ghost", kind: "web-app", rootPath: path.join(workspace, "does-not-exist") }, opts),
  /does not exist/,
  "Missing root path must be rejected",
);
ok("invalid root path is rejected");

// Test 4: path escape is rejected, including .., /tmp, /etc, and the home directory itself.
assert.throws(
  () => addProject({ id: "escape", name: "Escape", kind: "web-app", rootPath: path.join(workspace, "..", "outside") }, opts),
  /inside the workspace/,
  "A .. escape out of the workspace must be rejected",
);
assert.throws(
  () => addProject({ id: "tmp-proj", name: "Tmp", kind: "web-app", rootPath: "/tmp/some-project" }, opts),
  /inside the workspace/,
  "A /tmp path must be rejected",
);
assert.throws(
  () => addProject({ id: "etc-proj", name: "Etc", kind: "web-app", rootPath: "/etc/passwd" }, opts),
  /inside the workspace/,
  "An /etc path must be rejected",
);
assert.throws(
  () => addProject({ id: "home-proj", name: "Home", kind: "web-app", rootPath: os.homedir() }, opts),
  /inside the workspace/,
  "The home directory itself must be rejected",
);
assert.throws(
  () => addProject({ id: "ws-proj", name: "Whole workspace", kind: "web-app", rootPath: workspace }, opts),
  /not the whole workspace/,
  "The whole workspace as one project root must be rejected",
);
ok("path escape is rejected");

// Test 5: a secret in any field is rejected.
assert.throws(
  () => addProject({ id: "secret-proj", name: "Secret", kind: "web-app", rootPath: trustytouchDir, notes: "my apiKey is abc123" }, opts),
  /must never contain/,
  "A secret word in notes must be rejected",
);
assert.throws(
  () => addProject({ id: "pw-proj", name: "Pw", kind: "web-app", rootPath: trustytouchDir, notes: "password hunter2" }, opts),
  /must never contain/,
  "A password in notes must be rejected",
);
assert.throws(
  () => addProject({ id: "kind-proj", name: "Kind", kind: "mobile-app", rootPath: trustytouchDir }, opts),
  /kind must be/,
  "An unknown kind must be rejected",
);
assert.throws(
  () => addProject({ id: "act-proj", name: "Act", kind: "web-app", rootPath: trustytouchDir, allowedActions: ["read", "publish"] }, opts),
  /can never be allowed/,
  "publish in allowedActions must be rejected",
);
assert.throws(
  () => addProject({ id: "task-proj", name: "Task", kind: "web-app", rootPath: trustytouchDir, allowedTaskTypes: ["seo", "teleport"] }, opts),
  /not a known harness task type/,
  "An unknown task type must be rejected",
);
ok("secret field, bad kind, publish action, and bad task type are rejected");

// Test 6: discovery finds the fake trustytouch and clienthunt-production candidates.
const candidates = discoverProjects(workspace);
const byId = new Map(candidates.map((c) => [c.suggestedId, c]));
assert.ok(byId.has("trustytouch"), "Discovery must find the trustytouch candidate");
assert.ok(byId.has("clienthunt-production"), "Discovery must find the clienthunt-production candidate");
assert.strictEqual(byId.get("trustytouch").kind, "web-app", "trustytouch candidate must be a web-app");
assert.strictEqual(byId.get("clienthunt-production").kind, "web-app", "clienthunt-production candidate must be a web-app");
assert.ok(byId.get("trustytouch").signals.includes("package.json"), "trustytouch candidate must report package.json as a signal");
assert.ok(byId.get("clienthunt-production").signals.includes("extension manifest"), "clienthunt-production candidate must report the extension manifest");
assert.ok(byId.get("trustytouch").reason.length > 0, "Each candidate must carry a reason");
ok("discovery finds trustytouch and clienthunt-production candidates");

// Test 7: project context excludes secrets and .env, and states the boundaries.
fs.writeFileSync(path.join(trustytouchDir, ".env"), "OPENAI_API_KEY=fake-key\n", "utf-8");
fs.writeFileSync(path.join(trustytouchDir, "credentials.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(trustytouchDir, "id_rsa.pem"), "fake\n", "utf-8");
fs.mkdirSync(path.join(trustytouchDir, "node_modules"), { recursive: true });
const project = getProject("trustytouch", harnessRoot);
assert.ok(project, "trustytouch must exist for the context test");
const context = buildProjectContext(project, "seo");
assert.ok(context.includes("TrustyTouch"), "Context must name the project");
assert.ok(context.includes("https://trustytouch.com"), "Context must include the live URL");
assert.ok(context.includes("Draft only"), "Context must state the draft only boundary");
assert.ok(context.includes("Do not publish"), "Context must forbid publish");
assert.ok(!context.includes(".env"), "Context must never list .env");
assert.ok(!context.includes("credentials.json"), "Context must never list a credentials file");
assert.ok(!context.includes("id_rsa.pem"), "Context must never list a .pem file");
assert.ok(!context.includes("node_modules"), "Context must never list node_modules");
assert.ok(!context.includes("fake-key"), "Context must never include a secret value");
assert.ok(context.includes("server.js"), "Context must list a real top-level file");
ok("project context excludes secrets and .env and states boundaries");

// Test 8: remove works.
const second = addProject(
  { id: "clienthunt-production", name: "ClientHuntAi", kind: "web-app", rootPath: clienthuntDir, liveUrl: "https://clienthuntai.com" },
  opts,
);
assert.strictEqual(listProjects(harnessRoot).length, 2, "Two projects must be listed before removal");
const removed = removeProject("clienthunt-production", harnessRoot);
assert.strictEqual(removed.id, "clienthunt-production", "Removed project id must match");
assert.strictEqual(listProjects(harnessRoot).length, 1, "One project must remain after removal");
assert.strictEqual(getProject("clienthunt-production", harnessRoot), null, "Removed project must not be found");
assert.throws(() => removeProject("clienthunt-production", harnessRoot), /was not found/, "Removing a missing project must fail closed");
ok("remove works");

// Test 9: job scoping rejects a paused project and a disallowed task type.
const scoped = scopeJobToProject("trustytouch", "seo", { rootDir: harnessRoot, hold: false });
assert.strictEqual(scoped.project.id, "trustytouch", "An active project with an allowed task type must scope");

// Narrow the allowed list, then check pause and disallowed type.
const narrowed = loadProjects(harnessRoot);
narrowed[0].allowedTaskTypes = ["seo", "blog"];
const { saveProjects } = await import(path.join(distDir, "projects", "projects.js"));
saveProjects(narrowed, harnessRoot);
assert.throws(
  () => scopeJobToProject("trustytouch", "code_review", { rootDir: harnessRoot, hold: false }),
  /not allowed for project/,
  "A disallowed task type must be rejected for the project",
);
pauseProject("trustytouch", harnessRoot);
assert.throws(
  () => scopeJobToProject("trustytouch", "seo", { rootDir: harnessRoot, hold: false }),
  /is paused/,
  "A paused project must be rejected for jobs",
);
assert.throws(
  () => scopeJobToProject("missing-project", "seo", { rootDir: harnessRoot, hold: false }),
  /was not found/,
  "A missing project must be rejected for jobs",
);
ok("job scoping rejects paused project and disallowed task type");

// Test 10: HOLD blocks project writes and project jobs.
assert.throws(() => assertProjectWriteAllowed(true), /HOLD is on/, "HOLD must block project writes");
assert.doesNotThrow(() => assertProjectWriteAllowed(false), "HOLD off must allow project writes");
assert.throws(
  () => scopeJobToProject("trustytouch", "seo", { rootDir: harnessRoot, hold: true }),
  /HOLD is on/,
  "HOLD must block a scoped project job",
);
ok("HOLD blocks project writes and project jobs");

// Test 11: the project file on disk carries no secret fields.
const stored = JSON.parse(fs.readFileSync(path.join(harnessRoot, "state", "projects.json"), "utf-8"));
assert.ok(Array.isArray(stored), "projects.json must hold an array");
const storedText = JSON.stringify(stored).toLowerCase();
for (const marker of ["password", "apikey", "sessiontoken", "cookie"]) {
  assert.ok(!storedText.includes(marker), `Stored projects must never contain ${marker}`);
}
ok("stored project records carry no secret fields");

// Test 12: max projects is enforced.
const tinyOpts = { rootDir: path.join(tmp, "harness2"), workspaceRoot: workspace, maxProjects: 1 };
fs.mkdirSync(tinyOpts.rootDir, { recursive: true });
addProject({ id: "one", name: "One", kind: "web-app", rootPath: trustytouchDir }, tinyOpts);
assert.throws(
  () => addProject({ id: "two", name: "Two", kind: "web-app", rootPath: clienthuntDir }, tinyOpts),
  /Project limit reached/,
  "Adding past maxProjects must be rejected",
);
ok("max projects limit is enforced");

console.log(`All ${passed} test groups passed. Temp dir: ${tmp}`);

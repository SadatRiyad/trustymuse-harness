import * as fs from "fs";
import * as path from "path";

// Append only audit log. Every packet, check, block, and result is recorded.
// No event is ever edited or deleted by this code. The file is JSONL, one event per line.

export interface AuditEvent {
  at: string;
  runId: string;
  event: string;
  model?: string;
  taskType?: string;
  detail?: string;
  result?: string;
  tenant?: string;
}

// State layout, V1.4 multi-tenant. Without a tenant id, the legacy flat
// layout is used (state/audit.jsonl), so older callers keep working.
// With a tenant id, all state lives under state/tenants/<tenantId>/, and
// no tenant can see another tenant's files. The tenant id is validated by
// the tenants module before it ever reaches a path.
export function stateDir(rootDir?: string, tenantId?: string): string {
  const base = rootDir || path.resolve(__dirname, "..");
  if (!tenantId) {
    return path.join(base, "state");
  }
  return path.join(base, "state", "tenants", tenantId);
}

export function tenantsDir(rootDir?: string): string {
  const base = rootDir || path.resolve(__dirname, "..");
  return path.join(base, "state", "tenants");
}

export function auditFilePath(rootDir?: string, tenantId?: string): string {
  return path.join(stateDir(rootDir, tenantId), "audit.jsonl");
}

export function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${random}`;
}

export function appendAudit(event: AuditEvent, rootDir?: string, tenantId?: string): void {
  const dir = stateDir(rootDir, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    at: event.at || new Date().toISOString(),
    runId: event.runId,
    event: event.event,
    model: event.model,
    taskType: event.taskType,
    detail: event.detail,
    result: event.result,
    tenant: tenantId || event.tenant,
  };
  fs.appendFileSync(auditFilePath(rootDir, tenantId), JSON.stringify(record) + "\n", "utf-8");
}

export function readAuditEvents(rootDir?: string, tenantId?: string): AuditEvent[] {
  const file = auditFilePath(rootDir, tenantId);
  if (!fs.existsSync(file)) {
    return [];
  }
  const text = fs.readFileSync(file, "utf-8").trim();
  if (!text) {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line) as AuditEvent);
}

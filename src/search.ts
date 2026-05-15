import type { ThreadStatus, ThreadSummary } from "./plain";

export const ALL_STATUSES: ThreadStatus[] = ["TODO", "SNOOZED", "DONE"];

const DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

/**
 * Parse a `--since`/`--until` value into an absolute ISO8601 timestamp,
 * relative to `now`. Accepts:
 *   - relative durations: "30m", "24h", "7d", "2w"
 *   - bare ISO date:      "2026-05-01"
 *   - full ISO datetime:  "2026-05-01T12:34:56Z"
 */
export function parseTimeAnchor(input: string, now: Date = new Date()): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty time value");

  const rel = /^(\d+)\s*([mhdw])$/i.exec(trimmed);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = DURATION_UNITS[unit];
    return new Date(now.getTime() - n * ms).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `cannot parse "${input}" — expected a duration like 7d/24h/2w or an ISO date`,
    );
  }
  return new Date(parsed).toISOString();
}

const STATUS_ALIASES: Record<string, ThreadStatus> = {
  todo: "TODO",
  open: "TODO",
  snoozed: "SNOOZED",
  snooze: "SNOOZED",
  done: "DONE",
  closed: "DONE",
};

export function parseStatuses(input: string): ThreadStatus[] {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("--status was empty");
  const result: ThreadStatus[] = [];
  const seen = new Set<ThreadStatus>();
  for (const p of parts) {
    const canonical = STATUS_ALIASES[p.toLowerCase()];
    if (!canonical) {
      throw new Error(
        `unknown status "${p}" — expected one of: todo, snoozed, done`,
      );
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

export function threadUrl(workspaceId: string, threadId: string): string {
  const template = process.env.PLAIN_THREAD_URL_TEMPLATE;
  if (template) {
    return template.replace("{workspaceId}", workspaceId).replace("{threadId}", threadId);
  }
  return `https://app.plain.com/workspace/${workspaceId}/thread/${threadId}`;
}

export interface ListResult {
  ticket_id: string;
  thread_id: string;
  url: string;
  title: string;
  status: ThreadStatus;
  status_changed_at: string;
  updated_at: string;
  labels: string[];
}

export function toListResult(t: ThreadSummary, workspaceId: string): ListResult {
  return {
    ticket_id: t.ref,
    thread_id: t.id,
    url: threadUrl(workspaceId, t.id),
    title: t.title,
    status: t.status,
    status_changed_at: t.statusChangedAt,
    updated_at: t.updatedAt,
    labels: t.labels,
  };
}

/** Render a `ListResult[]` as one tab-separated line per row. */
export function formatListAsTsv(results: ListResult[]): string {
  return `${results
    .map((r) =>
      [
        r.ticket_id,
        r.url,
        r.status,
        r.status_changed_at,
        sanitizeForTsv(r.labels.join(",")),
        sanitizeForTsv(r.title),
      ].join("\t"),
    )
    .join("\n")}\n`;
}

function sanitizeForTsv(s: string): string {
  // Replace tabs/newlines so a single record always fits on one line.
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

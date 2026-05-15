import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatListAsTsv,
  type ListResult,
  parseStatuses,
  parseTimeAnchor,
  threadUrl,
  toListResult,
} from "../src/search";

const NOW = new Date("2026-05-15T12:00:00.000Z");

test("parseTimeAnchor handles relative durations", () => {
  assert.equal(parseTimeAnchor("7d", NOW), "2026-05-08T12:00:00.000Z");
  assert.equal(parseTimeAnchor("24h", NOW), "2026-05-14T12:00:00.000Z");
  assert.equal(parseTimeAnchor("2w", NOW), "2026-05-01T12:00:00.000Z");
  assert.equal(parseTimeAnchor("30m", NOW), "2026-05-15T11:30:00.000Z");
});

test("parseTimeAnchor is case-insensitive and tolerates whitespace", () => {
  assert.equal(parseTimeAnchor("7D", NOW), "2026-05-08T12:00:00.000Z");
  assert.equal(parseTimeAnchor("  24h  ", NOW), "2026-05-14T12:00:00.000Z");
});

test("parseTimeAnchor accepts ISO date strings", () => {
  // Date-only is interpreted as UTC midnight by V8.
  assert.equal(parseTimeAnchor("2026-05-01", NOW), "2026-05-01T00:00:00.000Z");
  assert.equal(
    parseTimeAnchor("2026-05-01T08:30:00Z", NOW),
    "2026-05-01T08:30:00.000Z",
  );
});

test("parseTimeAnchor rejects garbage", () => {
  assert.throws(() => parseTimeAnchor("yesterday", NOW), /cannot parse/);
  assert.throws(() => parseTimeAnchor("", NOW), /empty time value/);
});

test("parseStatuses normalizes aliases and casing", () => {
  assert.deepEqual(parseStatuses("done"), ["DONE"]);
  assert.deepEqual(parseStatuses("OPEN"), ["TODO"]);
  assert.deepEqual(parseStatuses("closed"), ["DONE"]);
  assert.deepEqual(parseStatuses("todo,snoozed,done"), ["TODO", "SNOOZED", "DONE"]);
});

test("parseStatuses de-dupes while preserving order", () => {
  assert.deepEqual(parseStatuses("done,DONE,closed"), ["DONE"]);
  assert.deepEqual(parseStatuses("todo,done,todo"), ["TODO", "DONE"]);
});

test("parseStatuses rejects unknown values", () => {
  assert.throws(() => parseStatuses("blocked"), /unknown status/);
  assert.throws(() => parseStatuses(""), /--status was empty/);
});

test("threadUrl defaults to app.plain.com", () => {
  delete process.env.PLAIN_THREAD_URL_TEMPLATE;
  assert.equal(
    threadUrl("w_01H5R1", "th_01ABC"),
    "https://app.plain.com/workspace/w_01H5R1/thread/th_01ABC",
  );
});

test("threadUrl honours PLAIN_THREAD_URL_TEMPLATE", () => {
  process.env.PLAIN_THREAD_URL_TEMPLATE = "https://plain.example/{workspaceId}/t/{threadId}";
  try {
    assert.equal(
      threadUrl("w_01H5R1", "th_01ABC"),
      "https://plain.example/w_01H5R1/t/th_01ABC",
    );
  } finally {
    delete process.env.PLAIN_THREAD_URL_TEMPLATE;
  }
});

test("toListResult shapes the row from a ThreadSummary", () => {
  const r = toListResult(
    {
      id: "th_01ABC",
      ref: "T-1234",
      title: "Webhooks failing",
      status: "DONE",
      statusChangedAt: "2026-05-10T09:11:44Z",
      updatedAt: "2026-05-10T09:11:44Z",
      labels: ["bug", "webhooks"],
    },
    "w_01H5R1",
  );
  assert.equal(r.ticket_id, "T-1234");
  assert.equal(r.thread_id, "th_01ABC");
  assert.equal(r.url, "https://app.plain.com/workspace/w_01H5R1/thread/th_01ABC");
  assert.equal(r.status, "DONE");
  assert.equal(r.title, "Webhooks failing");
  assert.deepEqual(r.labels, ["bug", "webhooks"]);
});

test("formatListAsTsv emits one tab-separated line per result and sanitizes titles", () => {
  const rows: ListResult[] = [
    {
      ticket_id: "T-1",
      thread_id: "th_a",
      url: "https://plain/a",
      title: "Simple title",
      status: "DONE",
      status_changed_at: "2026-05-15T00:00:00Z",
      updated_at: "2026-05-15T00:00:00Z",
      labels: ["bug", "p1"],
    },
    {
      ticket_id: "T-2",
      thread_id: "th_b",
      url: "https://plain/b",
      title: "Multi\nline\twith\ttabs",
      status: "TODO",
      status_changed_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      labels: [],
    },
  ];
  const out = formatListAsTsv(rows);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].split("\t"), [
    "T-1",
    "https://plain/a",
    "DONE",
    "2026-05-15T00:00:00Z",
    "bug,p1",
    "Simple title",
  ]);
  // Tabs and newlines collapsed to single spaces; labels empty -> empty column.
  assert.deepEqual(lines[1].split("\t"), [
    "T-2",
    "https://plain/b",
    "TODO",
    "2026-05-14T00:00:00Z",
    "",
    "Multi line with tabs",
  ]);
});

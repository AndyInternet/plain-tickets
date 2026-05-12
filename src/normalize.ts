export type Role = "team" | "customer" | "system";

export interface Author {
  role: Role;
  name: string;
  email: string | null;
}

export interface MessageEvent {
  type: "customer_message" | "team_reply";
  author: Author;
  timestamp: string;
  text: string;
}

export interface NoteEvent {
  type: "internal_note";
  author: Author;
  timestamp: string;
  text: string;
}

export interface SystemEvent {
  type: "system_event";
  author: Author;
  timestamp: string;
  event: string;
  summary: string;
}

export type TimelineEvent = MessageEvent | NoteEvent | SystemEvent;

export interface NormalizedTicket {
  ticket_id: string;
  thread_id: string;
  title: string;
  status: string;
  priority: number;
  labels: string[];
  customer: { name: string; email: string | null; company: string | null };
  created_at: string;
  updated_at: string;
  initial_question: MessageEvent | null;
  timeline: TimelineEvent[];
}

interface PlainDateTime {
  iso8601: string;
}

interface PlainLabel {
  labelType: { name: string };
}

interface PlainCustomer {
  fullName: string;
  email: { email: string } | null;
  company: { name: string } | null;
}

export interface PlainThread {
  id: string;
  ref: string;
  title: string;
  status: string;
  priority: number;
  createdAt: PlainDateTime;
  updatedAt: PlainDateTime;
  labels: PlainLabel[];
  customer: PlainCustomer;
}

export interface PlainTimelineEntry {
  id: string;
  timestamp: PlainDateTime;
  actor: { __typename: string; [k: string]: unknown };
  entry: { __typename: string; [k: string]: unknown };
  llmText: string | null;
}

export interface PlainThreadData {
  thread: PlainThread;
  timeline: PlainTimelineEntry[];
}

const TEAM_ACTORS = new Set(["UserActor", "MachineUserActor"]);
const CUSTOMER_ACTORS = new Set(["CustomerActor", "DeletedCustomerActor"]);

function classifyActor(actor: PlainTimelineEntry["actor"]): Author {
  const typename = actor.__typename;

  if (TEAM_ACTORS.has(typename)) {
    if (typename === "UserActor") {
      const user = actor.user as { fullName?: string; email?: string } | undefined;
      return {
        role: "team",
        name: user?.fullName ?? "Unknown user",
        email: user?.email ?? null,
      };
    }
    const mu = actor.machineUser as { fullName?: string } | undefined;
    return {
      role: "team",
      name: mu?.fullName ?? "Machine user",
      email: null,
    };
  }

  if (CUSTOMER_ACTORS.has(typename)) {
    if (typename === "CustomerActor") {
      const customer = actor.customer as
        | { fullName?: string; email?: { email?: string } }
        | undefined;
      return {
        role: "customer",
        name: customer?.fullName ?? "Customer",
        email: customer?.email?.email ?? null,
      };
    }
    return { role: "customer", name: "Deleted customer", email: null };
  }

  return { role: "system", name: "Plain", email: null };
}

function emailText(entry: Record<string, unknown>): string {
  const text = entry.textContent;
  if (typeof text === "string" && text.trim()) return text;
  const md = entry.markdownContent;
  if (typeof md === "string") return md;
  return "";
}

function chatText(entry: Record<string, unknown>): string {
  const t = entry.__typename;
  let candidate: unknown;
  switch (t) {
    case "ChatEntry":
      candidate = entry.chatText;
      break;
    case "SlackMessageEntry":
      candidate = entry.slackText;
      break;
    case "SlackReplyEntry":
      candidate = entry.slackReplyText;
      break;
  }
  return typeof candidate === "string" ? candidate : "";
}

function customEntryText(entry: Record<string, unknown>): string {
  const components = entry.components;
  if (!Array.isArray(components)) return "";
  const parts: string[] = [];
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const comp = c as Record<string, unknown>;
    switch (comp.__typename) {
      case "ComponentText":
        if (typeof comp.text === "string") parts.push(comp.text as string);
        break;
      case "ComponentPlainText":
        if (typeof comp.plainText === "string") parts.push(comp.plainText as string);
        break;
      case "ComponentBadge":
        if (typeof comp.badgeLabel === "string") parts.push(`[${comp.badgeLabel}]`);
        break;
      case "ComponentCopyButton":
        if (typeof comp.copyButtonValue === "string") parts.push(comp.copyButtonValue as string);
        break;
      case "ComponentLinkButton":
        if (typeof comp.linkButtonUrl === "string") {
          const label = typeof comp.linkButtonLabel === "string" ? comp.linkButtonLabel : "link";
          parts.push(`${label}: ${comp.linkButtonUrl}`);
        }
        break;
    }
  }
  return parts.join("\n\n").trim();
}

function noteText(entry: Record<string, unknown>): string {
  const t = entry.noteText;
  if (typeof t === "string") return t;
  const md = entry.markdown;
  return typeof md === "string" ? md : "";
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (l as PlainLabel)?.labelType?.name)
    .filter((n): n is string => typeof n === "string");
}

function describeSystemEntry(entry: Record<string, unknown>): { event: string; summary: string } {
  switch (entry.__typename) {
    case "ThreadStatusTransitionedEntry":
      return {
        event: "status_changed",
        summary: `Status ${entry.previousStatus} → ${entry.nextStatus}`,
      };
    case "ThreadPriorityChangedEntry":
      return {
        event: "priority_changed",
        summary: `Priority ${entry.previousPriority} → ${entry.nextPriority}`,
      };
    case "ThreadAssignmentTransitionedEntry":
      return { event: "assigned", summary: "Assignment changed" };
    case "ThreadAdditionalAssigneesTransitionedEntry":
      return { event: "additional_assignees_changed", summary: "Additional assignees changed" };
    case "ThreadLabelsChangedEntry": {
      const prev = new Set(labelNames(entry.previousLabels));
      const next = new Set(labelNames(entry.nextLabels));
      const added = [...next].filter((n) => !prev.has(n));
      const removed = [...prev].filter((n) => !next.has(n));
      const parts: string[] = [];
      if (added.length) parts.push(`added: ${added.join(", ")}`);
      if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
      return {
        event: "labels_changed",
        summary: parts.length ? parts.join("; ") : "Labels updated",
      };
    }
    case "ServiceLevelAgreementStatusTransitionedEntry":
      return {
        event: "sla_status_changed",
        summary: `SLA ${entry.slaPreviousStatus} → ${entry.slaNextStatus}`,
      };
    case "ThreadDiscussionResolvedEntry":
      return { event: "discussion_resolved", summary: "Internal discussion resolved" };
    default:
      return {
        event: "unknown",
        summary: `Unsupported entry type: ${entry.__typename}`,
      };
  }
}

const MESSAGE_TYPES = new Set([
  "EmailEntry",
  "ChatEntry",
  "SlackMessageEntry",
  "SlackReplyEntry",
  "MSTeamsMessageEntry",
  "DiscordMessageEntry",
  "CustomEntry",
]);

function classifyEntry(
  entry: PlainTimelineEntry,
  author: Author,
  customerAuthor: Author,
): TimelineEvent {
  const t = entry.entry.__typename;
  const timestamp = entry.timestamp.iso8601;

  if (t === "NoteEntry") {
    return {
      type: "internal_note",
      author,
      timestamp,
      text: noteText(entry.entry),
    };
  }

  if (MESSAGE_TYPES.has(t)) {
    let text: string;
    let effectiveAuthor = author;
    if (t === "EmailEntry") {
      text = emailText(entry.entry);
    } else if (t === "CustomEntry") {
      text = customEntryText(entry.entry);
      // CustomEntries posted by a machine integration (e.g. a support form
      // bridge) represent inbound customer messages — substitute the thread's
      // customer as the author. A CustomEntry posted by a real UserActor
      // stays attributed to that user and classified as team_reply.
      if (entry.actor.__typename === "MachineUserActor") {
        effectiveAuthor = customerAuthor;
      }
    } else {
      text = chatText(entry.entry);
    }
    const type: MessageEvent["type"] =
      effectiveAuthor.role === "customer" ? "customer_message" : "team_reply";
    return {
      type,
      author: effectiveAuthor,
      timestamp,
      text: text || entry.llmText || "",
    };
  }

  const sys = describeSystemEntry(entry.entry);
  return { type: "system_event", author, timestamp, ...sys };
}

export function normalizeTicket(input: PlainThreadData): NormalizedTicket {
  const { thread, timeline } = input;

  const customerAuthor: Author = {
    role: "customer",
    name: thread.customer.fullName,
    email: thread.customer.email?.email ?? null,
  };

  // Sort by timestamp before mapping so downstream consumers (and the
  // first-customer-message lookup below) don't depend on Plain returning
  // entries in chronological order.
  const sortedTimeline = [...timeline].sort((a, b) =>
    a.timestamp.iso8601.localeCompare(b.timestamp.iso8601),
  );

  const events: TimelineEvent[] = sortedTimeline.map((te) => {
    const author = classifyActor(te.actor);
    return classifyEntry(te, author, customerAuthor);
  });

  const initial = events.find((e): e is MessageEvent => e.type === "customer_message");

  return {
    ticket_id: thread.ref,
    thread_id: thread.id,
    title: thread.title,
    status: thread.status,
    priority: thread.priority,
    labels: labelNames(thread.labels),
    customer: {
      name: thread.customer.fullName,
      email: thread.customer.email?.email ?? null,
      company: thread.customer.company?.name ?? null,
    },
    created_at: thread.createdAt.iso8601,
    updated_at: thread.updatedAt.iso8601,
    initial_question: initial ?? null,
    timeline: events,
  };
}

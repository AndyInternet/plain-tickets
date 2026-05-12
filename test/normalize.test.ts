import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTicket, type PlainThreadData } from "../src/normalize";

const baseThread = {
  id: "th_01HX",
  ref: "T-1234",
  title: "Webhooks failing",
  status: "DONE",
  priority: 1,
  createdAt: { iso8601: "2026-05-08T14:22:01Z" },
  updatedAt: { iso8601: "2026-05-10T09:11:44Z" },
  labels: [{ labelType: { name: "webhooks" } }, { labelType: { name: "bug" } }],
  customer: {
    fullName: "Jane Doe",
    email: { email: "jane@acme.com" },
    company: { name: "Acme Inc" },
  },
};

const customerActor = {
  __typename: "CustomerActor",
  customer: { fullName: "Jane Doe", email: { email: "jane@acme.com" } },
};

const userActor = {
  __typename: "UserActor",
  user: { fullName: "Andy Lawrence", email: "andy@inngest.com" },
};

const systemActor = { __typename: "SystemActor" };

test("maps email from customer to customer_message", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: customerActor,
        entry: {
          __typename: "EmailEntry",
          textContent: "Our webhooks are failing.",
          markdownContent: null,
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "customer_message");
  assert.equal(out.timeline[0].author.role, "customer");
  assert.equal(out.timeline[0].author.name, "Jane Doe");
  assert.equal(out.timeline[0].author.email, "jane@acme.com");
  if (out.timeline[0].type === "customer_message") {
    assert.equal(out.timeline[0].text, "Our webhooks are failing.");
  }
});

test("maps email from team user to team_reply", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:35:12Z" },
        actor: userActor,
        entry: {
          __typename: "EmailEntry",
          textContent: "Looking into it.",
          markdownContent: null,
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "team_reply");
  assert.equal(out.timeline[0].author.role, "team");
  assert.equal(out.timeline[0].author.email, "andy@inngest.com");
});

test("maps machine user actor to team role", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:35:12Z" },
        actor: {
          __typename: "MachineUserActor",
          machineUser: { fullName: "Zapier bot" },
        },
        entry: { __typename: "ChatEntry", chatText: "Auto reply" },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "team_reply");
  assert.equal(out.timeline[0].author.role, "team");
  if (out.timeline[0].type === "team_reply") {
    assert.equal(out.timeline[0].text, "Auto reply");
  }
});

test("deleted customer actor stays customer", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: { __typename: "DeletedCustomerActor" },
        entry: { __typename: "ChatEntry", chatText: "hi" },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].author.role, "customer");
});

test("note entry becomes internal_note", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:36:00Z" },
        actor: userActor,
        entry: {
          __typename: "NoteEntry",
          noteText: "Same as INC-471.",
          markdown: null,
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "internal_note");
  if (out.timeline[0].type === "internal_note") {
    assert.equal(out.timeline[0].text, "Same as INC-471.");
  }
});

test("slack message from customer becomes customer_message", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: customerActor,
        entry: { __typename: "SlackMessageEntry", slackText: "Help!" },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "customer_message");
  if (out.timeline[0].type === "customer_message") {
    assert.equal(out.timeline[0].text, "Help!");
  }
});

test("status transition becomes system_event", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-10T09:11:44Z" },
        actor: systemActor,
        entry: {
          __typename: "ThreadStatusTransitionedEntry",
          previousStatus: "TODO",
          nextStatus: "DONE",
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "system_event");
  if (out.timeline[0].type === "system_event") {
    assert.equal(out.timeline[0].event, "status_changed");
    assert.match(out.timeline[0].summary, /TODO.*DONE/);
  }
});

test("labels changed event summarises additions and removals", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-09T09:00:00Z" },
        actor: userActor,
        entry: {
          __typename: "ThreadLabelsChangedEntry",
          previousLabels: [{ labelType: { name: "webhooks" } }],
          nextLabels: [{ labelType: { name: "webhooks" } }, { labelType: { name: "bug" } }],
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  if (out.timeline[0].type === "system_event") {
    assert.equal(out.timeline[0].event, "labels_changed");
    assert.match(out.timeline[0].summary, /bug/);
  } else {
    assert.fail("expected system_event");
  }
});

test("unknown entry types fall through to system_event with raw typename", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-09T09:00:00Z" },
        actor: systemActor,
        entry: { __typename: "SomeFutureEntry" },
        llmText: "Plain-provided fallback text",
      },
    ],
  };
  const out = normalizeTicket(input);
  if (out.timeline[0].type === "system_event") {
    assert.equal(out.timeline[0].event, "unknown");
    assert.match(out.timeline[0].summary, /SomeFutureEntry/);
  } else {
    assert.fail("expected system_event");
  }
});

test("initial_question is the first customer_message in chronological order", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: userActor,
        entry: { __typename: "NoteEntry", noteText: "preparing", markdown: null },
        llmText: null,
      },
      {
        id: "te_2",
        timestamp: { iso8601: "2026-05-08T14:25:00Z" },
        actor: customerActor,
        entry: {
          __typename: "EmailEntry",
          textContent: "The first real question",
          markdownContent: null,
        },
        llmText: null,
      },
      {
        id: "te_3",
        timestamp: { iso8601: "2026-05-08T14:30:00Z" },
        actor: customerActor,
        entry: {
          __typename: "EmailEntry",
          textContent: "follow up",
          markdownContent: null,
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.ok(out.initial_question);
  assert.equal(out.initial_question?.text, "The first real question");
});

test("initial_question is null when there are no customer messages", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: userActor,
        entry: { __typename: "NoteEntry", noteText: "internal only", markdown: null },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.initial_question, null);
});

test("top-level ticket fields map correctly", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [],
  };
  const out = normalizeTicket(input);
  assert.equal(out.ticket_id, "T-1234");
  assert.equal(out.thread_id, "th_01HX");
  assert.equal(out.title, "Webhooks failing");
  assert.equal(out.status, "DONE");
  assert.equal(out.priority, 1);
  assert.deepEqual(out.labels, ["webhooks", "bug"]);
  assert.equal(out.customer.name, "Jane Doe");
  assert.equal(out.customer.email, "jane@acme.com");
  assert.equal(out.customer.company, "Acme Inc");
  assert.equal(out.created_at, "2026-05-08T14:22:01Z");
  assert.equal(out.updated_at, "2026-05-10T09:11:44Z");
});

test("customer with no company returns null company", () => {
  const input: PlainThreadData = {
    thread: { ...baseThread, customer: { ...baseThread.customer, company: null } },
    timeline: [],
  };
  const out = normalizeTicket(input);
  assert.equal(out.customer.company, null);
});

test("timeline preserves chronological order from input", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_a",
        timestamp: { iso8601: "2026-05-08T10:00:00Z" },
        actor: customerActor,
        entry: { __typename: "ChatEntry", chatText: "1st" },
        llmText: null,
      },
      {
        id: "te_b",
        timestamp: { iso8601: "2026-05-08T11:00:00Z" },
        actor: userActor,
        entry: { __typename: "ChatEntry", chatText: "2nd" },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline.length, 2);
  if (out.timeline[0].type === "customer_message" && out.timeline[1].type === "team_reply") {
    assert.equal(out.timeline[0].text, "1st");
    assert.equal(out.timeline[1].text, "2nd");
  } else {
    assert.fail("unexpected timeline types");
  }
});

test("timeline is sorted by timestamp even if input is out of order", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_late",
        timestamp: { iso8601: "2026-05-08T11:00:00Z" },
        actor: userActor,
        entry: { __typename: "ChatEntry", chatText: "second" },
        llmText: null,
      },
      {
        id: "te_early",
        timestamp: { iso8601: "2026-05-08T10:00:00Z" },
        actor: customerActor,
        entry: { __typename: "ChatEntry", chatText: "first" },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].timestamp, "2026-05-08T10:00:00Z");
  assert.equal(out.timeline[1].timestamp, "2026-05-08T11:00:00Z");
  assert.equal(out.initial_question?.text, "first");
});

test("CustomEntry from a MachineUserActor is reclassified as customer_message", () => {
  const machineActor = {
    __typename: "MachineUserActor",
    machineUser: { fullName: "Inngest Support Center" },
  };
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: machineActor,
        entry: {
          __typename: "CustomEntry",
          components: [
            { __typename: "ComponentText", text: "first paragraph" },
            { __typename: "ComponentPlainText", plainText: "second paragraph" },
          ],
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "customer_message");
  assert.equal(out.timeline[0].author.role, "customer");
  assert.equal(out.timeline[0].author.name, "Jane Doe");
  if (out.timeline[0].type === "customer_message") {
    assert.equal(out.timeline[0].text, "first paragraph\n\nsecond paragraph");
  }
});

test("CustomEntry from a real UserActor stays as a team_reply", () => {
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: userActor,
        entry: {
          __typename: "CustomEntry",
          components: [{ __typename: "ComponentText", text: "manual note" }],
        },
        llmText: null,
      },
    ],
  };
  const out = normalizeTicket(input);
  assert.equal(out.timeline[0].type, "team_reply");
  assert.equal(out.timeline[0].author.name, "Andy Lawrence");
});

test("CustomEntry with no recognised components falls back to llmText", () => {
  const machineActor = {
    __typename: "MachineUserActor",
    machineUser: { fullName: "Inngest Support Center" },
  };
  const input: PlainThreadData = {
    thread: baseThread,
    timeline: [
      {
        id: "te_1",
        timestamp: { iso8601: "2026-05-08T14:22:01Z" },
        actor: machineActor,
        entry: { __typename: "CustomEntry", components: [] },
        llmText: "Customer sent a message: hello",
      },
    ],
  };
  const out = normalizeTicket(input);
  if (out.timeline[0].type === "customer_message") {
    assert.equal(out.timeline[0].text, "Customer sent a message: hello");
  } else {
    assert.fail("expected customer_message");
  }
});

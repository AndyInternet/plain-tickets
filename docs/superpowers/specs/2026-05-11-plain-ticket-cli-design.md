# Plain Ticket → JSON CLI

## Goal

A small CLI that takes a Plain ticket short ID (e.g. `T-1234`), pulls the full
thread from the Plain GraphQL API, and writes a normalized JSON file optimized
for downstream LLM analysis.

Output is written to `<TICKET-ID>.json` in the current working directory.

## File layout

```
json-plain-tickets/
├── .env                    # PLAIN_API_KEY=...
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # CLI entry: parse args, orchestrate, write file
│   ├── plain.ts            # Plain GraphQL client: lookup + timeline pagination
│   └── normalize.ts        # Plain entries → flat shape (pure function)
└── test/
    └── normalize.test.ts   # Pure-function tests with fixtures
```

Normalization is the part with branching logic and is most likely to silently
produce wrong output, so it lives in its own file with unit tests. The API
client and CLI entry stay thin.

Project uses TypeScript + `ts-node` to match the sibling `sql-runner` project's
conventions, and `dotenv` for loading the API key from `.env`.

## CLI surface

```
npx ts-node src/index.ts T-1234
```

Writes `T-1234.json` to the current working directory. Exits non-zero on any
error (missing key, ticket not found, network failure, GraphQL error).

## Plain API integration

- Endpoint: `https://core.plain.com/api/graphql/v1`
- Auth: `Authorization: Bearer ${PLAIN_API_KEY}` (loaded from `.env`)

Two phases:

1. **Resolve `T-1234` → thread UUID.** Plain exposes a short identifier on
   threads. The implementation will query Plain's `threads` connection with
   the short-ID filter — exact field name (likely `threadFields.identifier`
   or a dedicated lookup query) confirmed against Plain's schema during
   implementation.
2. **Fetch timeline entries.** Paginate `thread.timelineEntries`
   (cursor-based, 50 per page) until exhausted. Each entry includes its
   `actor` (with `__typename`) and a typed payload.

Sequential pagination — Plain's cursors are stateful. Most tickets fit in
one or two pages.

## Normalization rules

### Actor → role

Plain's `actor.__typename` maps directly. No email-domain heuristics needed:

| Plain actor type        | role       |
|-------------------------|------------|
| `UserActor`             | `team`     |
| `MachineUserActor`      | `team`     |
| `SupportAppActor`       | `team`     |
| `CustomerActor`         | `customer` |
| `DeletedCustomerActor`  | `customer` |
| `SystemActor`           | `system`   |

### Timeline entry → flat event type

Plain has many entry payload types; we collapse to four:

| Plain entry payload                                            | Resulting `type`    |
|---------------------------------------------------------------|---------------------|
| `EmailEntry`, `ChatEntry`, `SlackMessageEntry` (actor=customer)| `customer_message`  |
| `EmailEntry`, `ChatEntry`, `SlackMessageEntry` (actor=team)    | `team_reply`        |
| `NoteEntry`                                                   | `internal_note`     |
| Anything else (status / assignment / labels / priority / etc.)| `system_event`      |

For `system_event`, we keep an `event` subfield (`"status_changed"`,
`"assigned"`, `"labels_added"`, …) plus a short `summary` string. Unknown
entry payloads fall through to `system_event` with `event: "unknown"` and
the raw `__typename` preserved — forward-compatible if Plain adds new
entry kinds.

### Text extraction

- **Emails:** prefer `textContent`. Fall back to plain-text stripping of
  `htmlContent`. Strip Plain's quoted-reply markers so the LLM doesn't see
  the same earlier message repeated in every reply.
- **Chats / notes:** use the `text` / `markdown` field directly.

### Initial question

First entry in chronological order where `type === "customer_message"`.
Hoisted to a top-level `initial_question` field (full copy of that event)
so the LLM can find it without scanning. Still remains in the `timeline`
array — no duplication semantics, just easier access.

## Output JSON schema

```json
{
  "ticket_id": "T-1234",
  "thread_id": "01HX...",
  "title": "Webhook deliveries are failing intermittently",
  "status": "done",
  "priority": "urgent",
  "labels": ["webhooks", "bug"],
  "customer": {
    "name": "Jane Doe",
    "email": "jane@acme.com",
    "company": "Acme Inc"
  },
  "created_at": "2026-05-08T14:22:01Z",
  "updated_at": "2026-05-10T09:11:44Z",
  "initial_question": {
    "type": "customer_message",
    "author": { "role": "customer", "name": "Jane Doe", "email": "jane@acme.com" },
    "timestamp": "2026-05-08T14:22:01Z",
    "text": "Our webhooks have been failing for the last 2 hours..."
  },
  "timeline": [
    {
      "type": "customer_message",
      "author": { "role": "customer", "name": "Jane Doe", "email": "jane@acme.com" },
      "timestamp": "2026-05-08T14:22:01Z",
      "text": "Our webhooks have been failing..."
    },
    {
      "type": "team_reply",
      "author": { "role": "team", "name": "Andy Lawrence", "email": "andy@inngest.com" },
      "timestamp": "2026-05-08T14:35:12Z",
      "text": "Hey Jane — looking into this now..."
    },
    {
      "type": "internal_note",
      "author": { "role": "team", "name": "Andy Lawrence", "email": "andy@inngest.com" },
      "timestamp": "2026-05-08T14:36:00Z",
      "text": "Looks like the same regression as INC-471"
    },
    {
      "type": "system_event",
      "author": { "role": "system", "name": "Plain" },
      "timestamp": "2026-05-10T09:11:44Z",
      "event": "status_changed",
      "summary": "Status changed to Done"
    }
  ]
}
```

Conventions:

- ISO-8601 UTC timestamps everywhere.
- Timeline is chronological (oldest first).
- All fields present even when empty (`labels: []`, `company: null`). No
  optional-key handling needed downstream.

## Error handling

Tailored exit messages for the common failure modes; everything else bubbles
up with stack:

- Missing or empty `PLAIN_API_KEY` → `"Set PLAIN_API_KEY in .env"`
- Ticket not found → `"No thread found for T-1234"`
- 401 / 403 from Plain → `"Plain API rejected the key (check it has thread + timeline read scopes)"`
- GraphQL errors in the response body → print the `errors[]` array, exit 1

## Testing

Unit tests for `normalize.ts` only. It is the part with branching logic and
the part most likely to silently produce wrong output. Fixtures: a
hand-built timeline JSON covering one of each Plain entry payload type plus
the full actor-type matrix.

The API client and CLI entry stay thin enough that integration coverage
isn't worth the cost of mocking GraphQL or stashing a real API key for CI.

# json-plain-tickets

CLI that pulls a [Plain](https://www.plain.com/) support ticket and emits a
normalized JSON document of the full conversation. Output is optimized for
feeding to an LLM: every timeline entry is collapsed to a uniform
`{type, author, timestamp, text}` shape, regardless of whether the underlying
Plain event is an email, a chat, an internal note, a webform-style
`CustomEntry`, or a status change. The initial customer question is hoisted to
a top-level field for easy access.

## Install

Clone the repo, install dependencies, and link the binary globally:

```bash
npm install
npm link
```

`npm link` makes `plain-ticket` available on your `PATH` from any directory.
The `prepare` script ensures the TypeScript sources are compiled to `dist/`
during install/link.

Then provide your Plain API key. You can put it in a per-project `.env` or — so
the CLI works from anywhere — in a global config file:

```bash
echo 'PLAIN_API_KEY=plainApiKey_xxx' > ~/.plain-ticket.env
chmod 600 ~/.plain-ticket.env
```

Your key needs read access to threads and timeline entries. Generate one at
**Settings → Machine users → API keys** in your Plain workspace.

## Usage

```bash
plain-ticket <T-XXXX> [<T-XXXX> ...] [options]
```

The JSON document is written to **stdout** by default, so it pipes cleanly into
other tools. Pass one id for a single ticket, or several ids to fetch them as a
batch.

### Examples

```bash
# Print one ticket as a JSON object
plain-ticket T-1234

# Pipe straight into jq
plain-ticket T-1234 | jq '.timeline[] | select(.type == "customer_message")'

# Fetch multiple tickets as a JSON array
plain-ticket T-1234 T-5678 T-9012

# Iterate the array with jq
plain-ticket T-1234 T-5678 | jq '.[].title'

# Write to a file (object for one id, array for many)
plain-ticket T-1234 -o T-1234.json
# → Wrote /Users/you/work/T-1234.json (1 ticket, 17 timeline entries)

plain-ticket T-1234 T-5678 -o batch.json
# → Wrote /Users/you/work/batch.json (2 tickets, 41 timeline entries)

# Explicit stdout (curl-style, same as omitting the flag)
plain-ticket T-1234 -o -
```

### Output shape rules

| Invocation                       | stdout / file content                       |
|----------------------------------|---------------------------------------------|
| `plain-ticket T-1234`            | A JSON **object** (one ticket).             |
| `plain-ticket T-1234 T-5678 ...` | A JSON **array** of ticket objects.         |
| `plain-ticket T-1234 t-1234`     | Object — duplicate ids are deduplicated.    |

Fetches run sequentially. If any ticket fails the CLI exits non-zero and emits
nothing for the batch — partial output is never written (fail-fast).

### Options

| Flag                  | Description                                                                  |
|-----------------------|------------------------------------------------------------------------------|
| `-o, --output <path>` | Write JSON to `<path>` instead of stdout. Use `-` to mean stdout explicitly. |
| `-h, --help`          | Show the full help text and exit.                                            |

Run `plain-ticket --help` for the canonical reference.

## Claude Code skill: `/plain`

This repo ships a Claude Code skill at [`.claude/skills/plain/SKILL.md`](.claude/skills/plain/SKILL.md). When loaded, you can pull a Plain ticket into a Claude conversation by typing:

```
/plain T-1234 summarize the customer's actual question
/plain T-1234 T-5678 compare these two tickets — what's common?
```

The skill scans your prompt for every `T-XXXX` reference, runs `plain-ticket` under the hood to capture the ticket JSON(s) on stdout, and uses them as authoritative context to answer the rest of your prompt.

To make the skill available globally to Claude Code, symlink the project copy
into your personal skills directory (one-time setup):

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/.claude/skills/plain" ~/.claude/skills/plain
```

The project file is the source of truth — edits to
`.claude/skills/plain/SKILL.md` propagate to Claude Code automatically once the
symlink is in place. Restart your Claude Code session to pick up the skill (or
edits to it).

## Output shape

```json
{
  "ticket_id": "T-1234",
  "thread_id": "th_01HX...",
  "title": "Webhooks failing intermittently",
  "status": "DONE",
  "priority": 1,
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
    "text": "Our webhooks are failing..."
  },
  "timeline": [
    { "type": "customer_message", "author": { "role": "customer", "...": "..." }, "timestamp": "...", "text": "..." },
    { "type": "team_reply",       "author": { "role": "team",     "...": "..." }, "timestamp": "...", "text": "..." },
    { "type": "internal_note",    "author": { "role": "team",     "...": "..." }, "timestamp": "...", "text": "..." },
    { "type": "system_event",     "author": { "role": "system",   "...": "..." }, "timestamp": "...", "event": "status_changed", "summary": "Status TODO → DONE" }
  ]
}
```

### Event types

| `type`             | When                                                          |
|--------------------|---------------------------------------------------------------|
| `customer_message` | Inbound message from the customer — covers email, chat, Slack, MS Teams, Discord, and integration-posted `CustomEntry` events (e.g. webform/Inngest Support Center) |
| `team_reply`       | Outbound message from your team or a machine/API user         |
| `internal_note`    | Team-only note that the customer never saw                    |
| `system_event`     | Status change, assignment change, label change, priority change, SLA event, etc. Has extra `event` (e.g. `status_changed`) and `summary` fields. |

### Author roles

`role` is derived from Plain's actor type — no email-domain heuristics:

| Plain actor type        | role       |
|-------------------------|------------|
| `UserActor`             | `team`     |
| `MachineUserActor`      | `team`     |
| `CustomerActor`         | `customer` |
| `DeletedCustomerActor`  | `customer` |
| `SystemActor`           | `system`   |

`CustomEntry` events posted by a `MachineUserActor` are a special case: the
machine user is just the integration that bridged the message in, so the
thread's customer is substituted as the author and the event is classified as
`customer_message`.

## Configuration

| Env var          | Default                                              | Purpose |
|------------------|------------------------------------------------------|---------|
| `PLAIN_API_KEY`  | _required_                                           | Plain API key with thread + timeline read scopes |
| `PLAIN_API_URL`  | `https://core-api.uk.plain.com/graphql/v1`           | Override if your workspace is on a non-UK region |

Env vars are loaded in this order (first match wins for any given variable):

1. Variables already set in the shell environment
2. `.env` in the current working directory
3. `~/.plain-ticket.env`

## Development

```bash
npm test           # unit tests for the normalizer
npx tsc --noEmit   # typecheck
npm run build      # compile to dist/
npm start T-1234   # run via ts-node without the global symlink
```

## Project layout

```
src/
├── index.ts                  # CLI entry: arg parsing, orchestration, output
├── plain.ts                  # GraphQL client: threadByRef + paginated timeline
└── normalize.ts              # Pure function: Plain entries → flat shape
test/
└── normalize.test.ts
.claude/
└── skills/
    └── plain/
        └── SKILL.md          # Claude Code skill — see "Claude Code skill" above
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small TypeScript CLI (`plain-ticket`) that calls the Plain GraphQL API and emits a normalized JSON document representing the full conversation on a support thread. The output is shaped specifically for LLM ingestion — every timeline entry (email, chat, internal note, CustomEntry, status change, label change…) is collapsed into a uniform `{type, author, timestamp, text}` (or `+ event/summary` for system events) record.

## Common commands

```bash
# Build TypeScript → dist/. Also runs automatically via the "prepare" script on npm install / npm link.
npm run build

# Typecheck only (no emit). Fast inner-loop while editing.
npx tsc --noEmit

# All tests (node:test runner via ts-node)
npm test

# Single test, by name pattern
node --test --test-name-pattern="maps email from customer" --require ts-node/register test/normalize.test.ts

# Run the CLI through ts-node without rebuilding
npm start T-1234
```

## Install / link the CLI locally

The CLI is meant to be used from any directory, not just from this repo.

```bash
npm install            # also triggers `tsc` via the prepare script
npm link               # symlinks `plain-ticket` onto your PATH

# Provide the API key once, globally
echo 'PLAIN_API_KEY=plainApiKey_xxx' > ~/.plain-ticket.env
chmod 600 ~/.plain-ticket.env
```

After this, `plain-ticket T-1234` works from any cwd. JSON goes to **stdout** by default; `-o <path>` writes to a file instead; `-o -` is explicit stdout. The package's `bin` field points at `dist/index.js`, so any changes you make in `src/` need `npm run build` (or a fresh `npm link`) before the global symlink picks them up.

Env-var resolution order (first match wins per variable):

1. Shell environment
2. `.env` in the cwd where the CLI is invoked
3. `~/.plain-ticket.env`

## Architecture

Three modules, each with a single responsibility — the boundaries matter:

- **[src/plain.ts](src/plain.ts)** — GraphQL client. Two queries (`threadByRef`, paginated `timelineEntries`), a small `graphql<T>()` wrapper that surfaces HTTP and GraphQL errors as `PlainApiError`, and the inline fragment definitions used to ask for entry-specific fields.
- **[src/normalize.ts](src/normalize.ts)** — Pure function `normalizeTicket(PlainThreadData) → NormalizedTicket`. All of the interesting business logic lives here. No I/O. This is the file tests exercise.
- **[src/index.ts](src/index.ts)** — CLI front-end. Arg parsing (`-o/--output`, `-h/--help`), dotenv loading, and routing the normalized JSON to stdout or a file.

The flow is intentionally linear: `fetchThread()` returns raw `PlainThreadData`, `normalizeTicket()` transforms it, the CLI handles output. Tests only need to invent `PlainThreadData` fixtures — no network mocking required.

## Non-obvious design decisions

These are easy to break if you don't know about them. Look here first if a change causes regressions.

### GraphQL field aliases in `ENTRY_FRAGMENT`

Plain's timeline entry types have overlapping field names with **different nullability** (e.g. `text: String` on `ChatEntry` vs `text: String!` on `SlackMessageEntry`) and **different scalar/object types** (e.g. `previousStatus: ThreadStatus!` vs `previousStatus: ServiceLevelAgreementStatus!`). GraphQL rejects these unless aliased. The fragment in [src/plain.ts](src/plain.ts) aliases each per-type field (`chatText`, `slackText`, `slackReplyText`, `noteText`, `slaPreviousStatus`, etc.) and [src/normalize.ts](src/normalize.ts) reads from those aliases. **If you add a new entry type, alias any `text`/`previousStatus`/`nextStatus` fields uniquely.**

### `CustomEntry` is a customer message, not a system event

Plain represents some inbound messages (e.g. messages forwarded in by an integration like a webform or Inngest's Support Center bot) as `CustomEntry` with structured `components` (a union of `ComponentText`, `ComponentPlainText`, `ComponentBadge`, etc.). The actor on those entries is the **machine integration**, not the customer. [src/normalize.ts](src/normalize.ts) handles two things:

1. Flattens `components[]` into a single string (`customEntryText()`), falling back to `entry.llmText` if no recognised component variants are present.
2. When a CustomEntry's actor is a team/machine role, substitutes the thread's customer as the author so it gets classified as `customer_message`.

The `MSTeamsMessageEntry` and `DiscordMessageEntry` types are intentionally left out of the entry fragment — their content fields aren't part of the public schema. They still get captured via `llmText` because the timeline query asks for that on every node.

### Output is stdout by default

This was a deliberate change — the CLI used to write to a file by default. Status messages still go to **stdout** (not stderr) when writing to a file, so don't grep stdout for JSON in tests; check for the JSON shape instead. When writing to stdout, no status message is printed at all.

### Output shape switches on argument count

The CLI accepts multiple positional ticket ids. **One id → JSON object** (current/backwards-compatible shape). **Two or more ids → JSON array** of ticket objects in the order they were passed. Duplicate ids are deduplicated case-insensitively in [src/index.ts](src/index.ts) before fetching, so `plain-ticket T-1 t-1` still yields a single object. This shape switch matters for the `/plain` skill and any downstream `jq` pipelines — they need to branch on `type == "array"`. Behavior is fail-fast: any single ticket failure aborts the whole batch with no partial output on stdout.

## Claude Code skill: `/plain`

The repo ships a skill at [.claude/skills/plain/SKILL.md](.claude/skills/plain/SKILL.md) that lets you type `/plain T-1234 <question>` inside Claude Code and have the ticket JSON auto-fetched (via `plain-ticket`) and used as context. The user-global location `~/.claude/skills/plain` is a symlink to this project file, so the project copy is the source of truth — edit `.claude/skills/plain/SKILL.md` and restart the Claude Code session to pick up changes.

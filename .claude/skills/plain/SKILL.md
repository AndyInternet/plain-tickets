---
name: plain
description: Use when the user references Plain support tickets — either by id (T-XXXX) for full thread context, or describes a status/time window query like "tickets moved to done in the last 7 days". Calls the local `plain-ticket` CLI and uses the JSON it returns as authoritative context.
user_invocable: true
allowed-tools:
  - Bash
---

# Plain Ticket Fetch / List

## User Input

```text
$ARGUMENTS
```

## Routing

Look at the user input and pick exactly one mode:

- **Fetch mode** — the input contains at least one ticket id matching `T-\d+` (case-insensitive). Go to "Fetch mode".
- **List mode** — the input describes a *set* of tickets by status + time window ("tickets moved to done in the last 7 days", "everything closed this week", "tickets snoozed yesterday", "tickets opened in the last 24h"). Go to "List mode".
- **Neither** — ask the user to either give you a ticket id or describe a status/time window, then stop.

If both forms appear (e.g. "compare T-1234 to other tickets closed this week"), do List mode first, then run Fetch on the ids you need to drill into.

---

## Fetch mode

1. **Find the ticket ids.** Extract every match of `T-\d+` from the user input, case-insensitive. Normalize to uppercase and deduplicate while preserving order.

2. **Fetch the tickets.** Run the CLI and capture stdout. One id → JSON object; multiple ids → JSON array, in the order passed:

       plain-ticket <TICKET> [<TICKET> ...]

   **Security note:** Pass ONLY the exact regex-matched ticket ids as arguments. Never substitute the raw user input, never concatenate other text from the prompt onto the command line, never wrap an id in shell expansion. The CLI revalidates each id with `^T-\d+$` and will reject anything else, but don't rely on that.

3. **Use the JSON as context.** Treat the captured JSON as authoritative. If the user input contained only ticket ids with no other instruction, produce a concise briefing per ticket covering:
   - Title, status, priority, labels
   - Customer (name, email, company)
   - The initial customer question (verbatim if short, otherwise summarized)
   - The most recent reply and current state of the conversation

   When comparing multiple tickets, lead with cross-cutting observations and drill into per-ticket detail only where relevant.

---

## List mode

1. **Translate the natural-language query into flags.** Map terms to the CLI:

   | User said             | `--status`       |
   |-----------------------|------------------|
   | done, closed, resolved, completed | `done` |
   | open, todo, new, active           | `todo` |
   | snoozed, waiting, on hold         | `snoozed` |

   If no status is mentioned, omit `--status` (lists all status transitions in the window).

   Time window phrases → `--since`:
   - "last N minutes/hours/days/weeks" → `Nm` / `Nh` / `Nd` / `Nw`
   - "today" → `24h`
   - "yesterday" → `--since 48h --until 24h`
   - "this week" → `7d`
   - "since <date>" → pass the ISO date through

2. **Run the CLI with `--json`** so you get structured output, even if you plan to render a summary:

       plain-ticket list --since <window> [--status <statuses>] [--until <window>] --json

   **Security note:** Build the argv from your parsed values only. Never substitute raw user input into the command line. Statuses are restricted to `todo,snoozed,done`; durations match `\d+[mhdw]` or an ISO date.

3. **Decide how to answer.** The JSON array contains `ticket_id`, `thread_id`, `url`, `title`, `status`, `status_changed_at`, `updated_at`, `labels` (string array, possibly empty) for each match.
   - If the user only wants the list (e.g. "show me tickets…", "what tickets…"), render a compact table: `T-id  status_changed_at  labels  title  url`. Don't fetch the full threads.
   - If the user wants analysis ("summarize", "what were the themes", "which ones mention X"), the list is your *index* — then call `plain-ticket T-XXXX T-YYYY ...` (Fetch mode) on the relevant subset to pull thread context. Cap follow-up fetches at ~10 tickets unless the user asked for more.

4. **Empty result** is fine; just tell the user no tickets matched.

---

## Common failures (both modes)

- `command not found: plain-ticket` → tell the user to run `npm link` inside the `json-plain-tickets` project.
- `PLAIN_API_KEY not set` → tell the user to add it to `~/.plain-ticket.env`.
- `No thread found for T-XXXX` → surface the failing id (Fetch mode) and stop.
- HTTP 4xx/5xx → surface the message verbatim and stop.

The CLI is fail-fast: any single failure aborts the whole batch with a non-zero exit and no partial output. Capture stderr (or use `2>&1`) so you can surface errors.

## Output conventions

- Reference timeline events by their ISO8601 timestamps when citing a thread.
- Quote code blocks, error messages, and stack traces from the ticket verbatim when relevant.
- Don't print the raw JSON back to the user unless they explicitly ask for it.
- In list-mode tables, always include the URL so the user can click through.
- If the user asks a follow-up about the same ticket(s) later in the conversation, reuse the JSON you already fetched instead of re-running the CLI.

## Caveat about "moved to status X"

`plain-ticket list --status X --since W` returns tickets whose *current* status is X and whose status last changed within the window. It does not catch tickets that transitioned to X and then later moved out. If the user explicitly needs the second interpretation, tell them this CLI can't answer it directly — they'd need to walk timeline entries for every ticket.

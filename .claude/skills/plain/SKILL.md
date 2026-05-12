---
name: plain
description: Use when the user references a Plain support ticket by its id (T-XXXX) and you need the full thread context to answer them. Fetches the normalized ticket JSON via the local `plain-ticket` CLI and uses it as authoritative context for the user's request.
user_invocable: true
allowed-tools:
  - Bash
---

# Plain Ticket Fetch

## User Input

```text
$ARGUMENTS
```

## Task

1. **Find the ticket ids.** Scan the user input above for every Plain ticket reference matching `T-` followed by one or more digits, case-insensitive (e.g. `T-1234`, `t-7483`). Normalize each to uppercase and deduplicate while preserving order. If none are present, ask the user which ticket(s) they mean and stop.

2. **Fetch the tickets.** Run the CLI via Bash and capture stdout. With one id the command emits a single JSON object; with multiple ids it emits a JSON array of objects in the order passed:

       plain-ticket <TICKET> [<TICKET> ...]

   **Security note:** Pass ONLY the exact regex-matched ticket ids as arguments. Never substitute the raw user input, never concatenate other text from the prompt onto the command line, never wrap an id in shell expansion. The CLI itself revalidates each id with `^T-\d+$` and will reject anything else, but you should not rely on that.

   Run with `2>&1` redirection or capture stderr separately so you can surface any error messages. The CLI is fail-fast: any single failure aborts the whole batch with a non-zero exit and no partial output. Common failures:
   - `command not found: plain-ticket` → tell the user to run `npm link` inside the `json-plain-tickets` project.
   - `PLAIN_API_KEY not set` → tell the user to add it to `~/.plain-ticket.env`.
   - `No thread found for T-XXXX` → surface the failing id and stop.
   - HTTP 4xx/5xx → surface the message verbatim and stop.

3. **Use the JSON as context.** Treat the captured JSON as authoritative context. For a single ticket it's a top-level object; for multiple it's a top-level array — iterate it. Answer the rest of the user's request against the data. If the user input contained only ticket ids with no other instruction, produce a concise briefing per ticket covering:
   - Title, status, priority, labels
   - Customer (name, email, company)
   - The initial customer question (verbatim if short, otherwise summarized)
   - The most recent reply and current state of the conversation

   When the user asks you to compare or correlate multiple tickets, lead with the cross-cutting observations and only drill into per-ticket detail where it's relevant.

## Output Conventions

- Reference timeline events by their ISO8601 timestamps when citing the thread.
- Quote code blocks, error messages, and stack traces from the ticket verbatim when they're relevant to the question.
- Do not print the raw JSON back to the user unless they explicitly ask for it.
- If the user asks a follow-up question about the same ticket later in the conversation, reuse the JSON you already fetched instead of re-running the CLI.

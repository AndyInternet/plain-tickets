#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { type NormalizedTicket, normalizeTicket } from "./normalize";
import {
  fetchThread,
  fetchWorkspaceId,
  PlainApiError,
  searchThreadsByStatus,
  type ThreadStatus,
} from "./plain";
import {
  formatListAsTsv,
  type ListResult,
  parseStatuses,
  parseTimeAnchor,
  toListResult,
} from "./search";

// Load env from cwd first (project-local override), then ~/.plain-ticket.env
// (global config for use anywhere). dotenv won't overwrite already-set vars.
dotenv.config();
const homeEnv = path.join(os.homedir(), ".plain-ticket.env");
if (fs.existsSync(homeEnv)) dotenv.config({ path: homeEnv });

const HELP = `plain-ticket — fetch Plain tickets and emit normalized JSON

USAGE
  plain-ticket <T-XXXX> [<T-XXXX> ...] [options]
  plain-ticket list --since <window> [--status <statuses>] [options]

SUBCOMMANDS
  (default)           Fetch one or more tickets by id and emit normalized JSON.
  list                List tickets whose status last changed within a window.

OPTIONS (fetch mode)
  -o, --output <path> Write JSON to <path> instead of stdout. Use '-' to
                      explicitly mean stdout (same as omitting the flag).
  -h, --help          Show this help and exit.

OPTIONS (list mode)
  --since <window>    REQUIRED. Status-change window lower bound. Accepts a
                      relative duration ("30m", "24h", "7d", "2w") or an
                      absolute ISO date/datetime ("2026-05-01").
  --until <window>    Optional upper bound. Same syntax as --since.
                      Default: now.
  -s, --status <s>    Optional. Comma-separated list of statuses to filter on.
                      Accepts: todo, snoozed, done (case-insensitive).
                      Aliases: open=todo, closed=done.
  --json              Emit a JSON array instead of TSV (default is TSV:
                      <ref>\\t<url>\\t<status>\\t<status_changed_at>\\t<labels>\\t<title>,
                      where <labels> is comma-separated, empty if none).
  -o, --output <path> Write output to <path> instead of stdout.
  -h, --help          Show this help and exit.

OUTPUT (fetch mode)
  Single ticket  → JSON object.
  Multiple ids   → JSON array of ticket objects, in the order given.
  Fail-fast: any single ticket failure aborts the batch.

OUTPUT (list mode)
  Default       → TSV, one row per ticket, sorted by status-change time DESC.
  --json        → JSON array of objects with ticket_id, thread_id, url, title,
                  status, status_changed_at, updated_at, labels.

ENVIRONMENT
  PLAIN_API_KEY              Required. Plain API key with thread read scopes.
  PLAIN_API_URL              Optional. Override the GraphQL endpoint
                             (default: https://core-api.uk.plain.com/graphql/v1).
  PLAIN_THREAD_URL_TEMPLATE  Optional. URL template for list mode. Tokens:
                             {workspaceId}, {threadId}.
                             Default: https://app.plain.com/workspace/{workspaceId}/thread/{threadId}

CONFIG
  Env vars are loaded from (first match wins per variable):
    1. The shell environment
    2. .env in the current working directory
    3. ~/.plain-ticket.env

EXAMPLES
  plain-ticket T-1234
      One ticket as a JSON object.
  plain-ticket T-1234 T-5678 -o batch.json
      JSON array of two tickets, written to a file.
  plain-ticket list --status done --since 7d
      Tickets currently DONE whose status changed in the last 7 days.
  plain-ticket list --status todo,snoozed --since 24h --json
      JSON array of tickets that moved to TODO or SNOOZED in the last day.
  plain-ticket list --since 2026-05-01 --until 2026-05-08 -s done
      Tickets moved to DONE between two absolute dates.
`;

function printHelp(): never {
  process.stdout.write(HELP);
  process.exit(0);
}

function usageError(message: string): never {
  process.stderr.write(`${message}\n\nRun 'plain-ticket --help' for usage.\n`);
  process.exit(2);
}

function requireApiKey(): string {
  const apiKey = process.env.PLAIN_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      `PLAIN_API_KEY not set. Add it to ${homeEnv} or a local .env, or export it in your shell.\n`,
    );
    process.exit(1);
  }
  return apiKey;
}

// --------------------------------------------------------------------------
// Fetch mode (existing behavior)
// --------------------------------------------------------------------------

interface FetchArgs {
  refs: string[];
  output: string | null;
}

function parseFetchArgs(argv: string[]): FetchArgs {
  const refs: string[] = [];
  let output: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
    } else if (arg === "-o" || arg === "--output") {
      const value = argv[++i];
      if (value === undefined) usageError(`${arg} requires a path (or '-')`);
      output = value;
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg.startsWith("-") && arg !== "-") {
      usageError(`Unknown option: ${arg}`);
    } else {
      refs.push(arg);
    }
  }

  if (refs.length === 0) usageError("Missing ticket id.");
  for (const r of refs) {
    if (!/^T-\d+$/i.test(r)) {
      usageError(`Expected a ticket id like T-1234, got: ${r}`);
    }
  }

  // De-dupe while preserving order. Same id given twice = one fetch.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of refs) {
    const upper = r.toUpperCase();
    if (!seen.has(upper)) {
      seen.add(upper);
      unique.push(upper);
    }
  }

  return { refs: unique, output };
}

async function runFetch(argv: string[]): Promise<void> {
  const args = parseFetchArgs(argv);
  const apiKey = requireApiKey();

  // Sequential fetch (Plain may rate-limit; batches are small in practice).
  // Fail-fast: the first thrown error bubbles to the top-level catch and exits.
  const tickets: NormalizedTicket[] = [];
  for (const ref of args.refs) {
    const data = await fetchThread(apiKey, ref);
    tickets.push(normalizeTicket(data));
  }

  // Single id → object; multiple ids → array. Preserves backwards-compatible
  // shape for the common case while keeping multi-id output as valid JSON.
  const payload: unknown = tickets.length === 1 ? tickets[0] : tickets;
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  if (args.output === null || args.output === "-") {
    process.stdout.write(json);
    return;
  }

  const outPath = path.resolve(process.cwd(), args.output);
  fs.writeFileSync(outPath, json, "utf8");
  const totalEntries = tickets.reduce((n, t) => n + t.timeline.length, 0);
  const noun = tickets.length === 1 ? "ticket" : "tickets";
  process.stdout.write(
    `Wrote ${outPath} (${tickets.length} ${noun}, ${totalEntries} timeline entries)\n`,
  );
}

// --------------------------------------------------------------------------
// List mode
// --------------------------------------------------------------------------

interface ListArgs {
  statuses: ThreadStatus[] | null;
  since: string;
  until: string | null;
  json: boolean;
  output: string | null;
}

function parseStatusesOrUsageError(input: string): ThreadStatus[] {
  try {
    return parseStatuses(input);
  } catch (err) {
    usageError((err as Error).message);
  }
}

function parseListArgs(argv: string[]): ListArgs {
  let statuses: ThreadStatus[] | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let json = false;
  let output: string | null = null;

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) usageError(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-o" || arg === "--output") {
      output = takeValue(++i, arg);
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg === "-s" || arg === "--status") {
      statuses = parseStatusesOrUsageError(takeValue(++i, arg));
    } else if (arg.startsWith("--status=")) {
      statuses = parseStatusesOrUsageError(arg.slice("--status=".length));
    } else if (arg === "--since") {
      since = takeValue(++i, arg);
    } else if (arg.startsWith("--since=")) {
      since = arg.slice("--since=".length);
    } else if (arg === "--until") {
      until = takeValue(++i, arg);
    } else if (arg.startsWith("--until=")) {
      until = arg.slice("--until=".length);
    } else if (arg.startsWith("-") && arg !== "-") {
      usageError(`Unknown option: ${arg}`);
    } else {
      usageError(`Unexpected positional argument: ${arg}`);
    }
  }

  if (since === null) usageError("--since is required for 'list'");
  return { statuses, since, until, json, output };
}

async function runList(argv: string[]): Promise<void> {
  const args = parseListArgs(argv);
  const apiKey = requireApiKey();

  const now = new Date();
  let afterIso: string;
  let beforeIso: string | undefined;
  try {
    afterIso = parseTimeAnchor(args.since, now);
    if (args.until !== null) beforeIso = parseTimeAnchor(args.until, now);
  } catch (err) {
    usageError((err as Error).message);
  }

  const workspaceId = await fetchWorkspaceId(apiKey);
  const threads = await searchThreadsByStatus(apiKey, {
    statuses: args.statuses ?? undefined,
    statusChangedAfter: afterIso,
    statusChangedBefore: beforeIso,
  });

  const results: ListResult[] = threads.map((t) => toListResult(t, workspaceId));

  const out = args.json ? `${JSON.stringify(results, null, 2)}\n` : formatListAsTsv(results);

  if (args.output === null || args.output === "-") {
    if (results.length === 0 && !args.json) {
      process.stderr.write("No tickets matched.\n");
      return;
    }
    process.stdout.write(out);
    return;
  }

  const outPath = path.resolve(process.cwd(), args.output);
  fs.writeFileSync(outPath, out, "utf8");
  process.stdout.write(`Wrote ${outPath} (${results.length} tickets)\n`);
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --help / -h before any subcommand routing.
  if (argv[0] === "-h" || argv[0] === "--help") printHelp();

  if (argv[0] === "list") {
    await runList(argv.slice(1));
    return;
  }

  await runFetch(argv);
}

main().catch((err: unknown) => {
  if (err instanceof PlainApiError) {
    process.stderr.write(`${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  process.exit(1);
});

#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { type NormalizedTicket, normalizeTicket } from "./normalize";
import { fetchThread, PlainApiError } from "./plain";

// Load env from cwd first (project-local override), then ~/.plain-ticket.env
// (global config for use anywhere). dotenv won't overwrite already-set vars.
dotenv.config();
const homeEnv = path.join(os.homedir(), ".plain-ticket.env");
if (fs.existsSync(homeEnv)) dotenv.config({ path: homeEnv });

const HELP = `plain-ticket — fetch one or more Plain tickets and emit normalized JSON

USAGE
  plain-ticket <T-XXXX> [<T-XXXX> ...] [options]

ARGUMENTS
  <T-XXXX>            One or more Plain ticket references (e.g. T-1234).
                      Case-insensitive. Duplicates are de-duplicated.

OPTIONS
  -o, --output <path> Write JSON to <path> instead of stdout. Use '-' to
                      explicitly mean stdout (same as omitting the flag).
  -h, --help          Show this help and exit.

OUTPUT
  By default the JSON document is written to stdout so it can be piped into
  other tools. Pass -o <path> to write it to a file instead; in that mode a
  one-line status message is printed on stdout after the write.

  Single ticket  → emits a JSON object (one ticket).
  Multiple ids   → emits a JSON array of ticket objects, in the order given.

  Fetches run sequentially. If any ticket fails, the CLI exits non-zero and
  no output is produced for the batch (fail-fast).

ENVIRONMENT
  PLAIN_API_KEY       Required. Plain API key with thread + timeline read
                      scopes.
  PLAIN_API_URL       Optional. Override the GraphQL endpoint (defaults to
                      https://core-api.uk.plain.com/graphql/v1).

CONFIG
  The CLI loads env vars from these locations (first match wins for any
  given variable):
    1. Variables already set in the shell environment
    2. .env in the current working directory
    3. ~/.plain-ticket.env

EXAMPLES
  plain-ticket T-1234
      Prints one ticket as a JSON object to stdout.

  plain-ticket T-1234 T-5678 T-9012
      Prints a JSON array of three tickets to stdout.

  plain-ticket T-1234 | jq '.title'
      Pipes the single-ticket object into jq.

  plain-ticket T-1234 T-5678 | jq '.[].title'
      Iterates an array of tickets with jq.

  plain-ticket T-1234 T-5678 -o batch.json
      Writes the JSON array to ./batch.json.
`;

interface Args {
  refs: string[];
  output: string | null;
}

function printHelp(): never {
  process.stdout.write(HELP);
  process.exit(0);
}

function usageError(message: string): never {
  process.stderr.write(`${message}\n\nRun 'plain-ticket --help' for usage.\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.PLAIN_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      `PLAIN_API_KEY not set. Add it to ${homeEnv} or a local .env, or export it in your shell.\n`,
    );
    process.exit(1);
  }

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

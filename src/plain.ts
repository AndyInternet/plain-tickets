import type { PlainThread, PlainThreadData, PlainTimelineEntry } from "./normalize";

const DEFAULT_ENDPOINT = "https://core-api.uk.plain.com/graphql/v1";
const PAGE_SIZE = 50;

function endpoint(): string {
  return process.env.PLAIN_API_URL || DEFAULT_ENDPOINT;
}

const THREAD_FIELDS = `
  id
  ref
  title
  status
  priority
  createdAt { iso8601 }
  updatedAt { iso8601 }
  labels { labelType { name } }
  customer {
    fullName
    email { email }
    company { name }
  }
`;

const ACTOR_FRAGMENT = `
  __typename
  ... on UserActor {
    user { fullName email }
  }
  ... on MachineUserActor {
    machineUser { fullName }
  }
  ... on CustomerActor {
    customer { fullName email { email } }
  }
`;

const ENTRY_FRAGMENT = `
  __typename
  ... on EmailEntry { textContent markdownContent }
  ... on ChatEntry { chatText: text }
  ... on NoteEntry { noteText: text markdown }
  ... on SlackMessageEntry { slackText: text }
  ... on SlackReplyEntry { slackReplyText: text }
  ... on CustomEntry {
    components {
      __typename
      ... on ComponentText { text }
      ... on ComponentPlainText { plainText }
      ... on ComponentBadge { badgeLabel }
      ... on ComponentCopyButton { copyButtonValue }
      ... on ComponentLinkButton { linkButtonLabel linkButtonUrl }
    }
  }
  ... on ThreadStatusTransitionedEntry { previousStatus nextStatus }
  ... on ThreadPriorityChangedEntry { previousPriority nextPriority }
  ... on ThreadLabelsChangedEntry {
    previousLabels { labelType { name } }
    nextLabels { labelType { name } }
  }
  ... on ServiceLevelAgreementStatusTransitionedEntry {
    slaPreviousStatus: previousStatus
    slaNextStatus: nextStatus
  }
`;

const TIMELINE_PAGE_QUERY = `
  query TimelinePage($threadId: ID!, $after: String, $first: Int!) {
    thread(threadId: $threadId) {
      timelineEntries(first: $first, after: $after) {
        edges {
          node {
            id
            timestamp { iso8601 }
            actor { ${ACTOR_FRAGMENT} }
            entry { ${ENTRY_FRAGMENT} }
            llmText
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const THREAD_BY_REF_QUERY = `
  query ThreadByRef($ref: String!) {
    threadByRef(ref: $ref) {
      ${THREAD_FIELDS}
    }
  }
`;

export class PlainApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainApiError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: unknown[] }>;
}

async function graphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new PlainApiError(
      "Plain API rejected the key (check it has thread + timeline read scopes)",
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new PlainApiError(`Plain API HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new PlainApiError(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new PlainApiError("GraphQL response had no data");
  return json.data;
}

export async function fetchThread(apiKey: string, ref: string): Promise<PlainThreadData> {
  const threadData = await graphql<{ threadByRef: PlainThread | null }>(
    apiKey,
    THREAD_BY_REF_QUERY,
    { ref },
  );

  if (!threadData.threadByRef) {
    throw new PlainApiError(`No thread found for ${ref}`);
  }
  const thread = threadData.threadByRef;

  interface TimelinePage {
    thread: {
      timelineEntries: {
        edges: Array<{ node: PlainTimelineEntry }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  }

  const timeline: PlainTimelineEntry[] = [];
  let after: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const page: TimelinePage = await graphql<TimelinePage>(apiKey, TIMELINE_PAGE_QUERY, {
      threadId: thread.id,
      first: PAGE_SIZE,
      after,
    });

    for (const edge of page.thread.timelineEntries.edges) {
      timeline.push(edge.node);
    }
    const { hasNextPage, endCursor } = page.thread.timelineEntries.pageInfo;
    // Guard against pathological responses (hasNextPage=true with no cursor)
    // that would otherwise re-request the first page forever.
    if (hasNextPage && !endCursor) break;
    hasNext = hasNextPage;
    after = endCursor;
  }

  return { thread, timeline };
}

/** Test helper: a fetch recorder that impersonates the Worker API. */

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

export interface FetchMock {
  requests: RecordedRequest[];
  /** Queue of canned responses; when empty, requests get a generic 200. */
  queue: Array<(req: RecordedRequest) => Response>;
}

let realFetch: typeof fetch | null = null;

/** Install a fetch mock that records requests and pops canned responses. */
export function installFetchMock(): FetchMock {
  const mock: FetchMock = { requests: [], queue: [] };
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? safeJson(init.body) : init?.body,
    };
    mock.requests.push(req);
    const next = mock.queue.shift();
    if (!next) {
      return jsonResponse(200);
    }
    return next(req);
  }) as typeof fetch;
  return mock;
}

export function restoreFetch(): void {
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = null;
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

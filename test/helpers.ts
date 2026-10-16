import type { Fetch } from "../src/okta.js";
import type { SavedSession, SessionStore } from "../src/store.js";

/** An id_token whose only meaningful claim is exp (seconds). */
export function idToken(exp: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp, sub: "example" })}.sig`;
}

export function memoryStore(initial?: SavedSession): SessionStore & { saved?: SavedSession } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(s: SavedSession) {
      store.saved = s;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

export interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a route table and records every call. */
export function fakeFetch(routes: (call: Call) => Response | undefined): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const res = routes(call);
    if (!res) return new Response("not found", { status: 404 });
    return res;
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

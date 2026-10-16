/**
 * The signed-in side of the server: one IEC session kept fresh in this
 * process, and a small sign-in page that starts it.
 *
 * Settings (environment):
 *   IEC_CONFIG_DIR  where the session is saved (default ~/.config/iec-mcp)
 *   IEC_LOGIN_HOST  address the sign-in page listens on (default 127.0.0.1)
 *   IEC_LOGIN_PORT  its port (default 8766; a free port if that one is taken)
 *   IEC_LOGIN_URL   the link handed out, when the page is reached through a
 *                   reverse proxy (default http://localhost:<port>/); when set,
 *                   the page starts with the server
 *
 * The ID number and the one-time code are typed on that page only. The model
 * is only ever given its link.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { IecApi, Unauthorized } from "./api.js";
import { SessionKeeper, SignInRequired, type KeeperStatus } from "./keeper.js";
import { finishLogin, IecLoginError, startLogin, type Fetch, type PendingLogin } from "./okta.js";
import { DEFAULT_SESSION_LENGTH, PAGE_HEADERS, SESSION_LENGTHS, codePage, idPage, messagePage, statusPage } from "./pages.js";
import { fileStore, type SessionStore } from "./store.js";

const log = (line: string): void => console.error(`[iec-mcp] ${line}`);

/** A started sign-in waiting for its code. */
const PENDING_TTL_MS = 10 * 60_000;

export interface SessionStatus extends KeeperStatus {
  signInUrl?: string;
}

export interface SessionManagerOptions {
  store?: SessionStore;
  fetch?: Fetch;
  host?: string;
  port?: number;
  url?: string;
}

export class SessionManager {
  readonly keeper: SessionKeeper;
  readonly api: IecApi;
  readonly #fetch: Fetch;
  readonly #csrf = randomBytes(16).toString("hex");
  readonly #host: string;
  readonly #port: number;
  readonly #fixedUrl: string | undefined;
  #server: Promise<string> | undefined;
  #http: Server | undefined;
  #pending: { login: PendingLogin; lengthMs: number; at: number } | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#host = options.host ?? (process.env.IEC_LOGIN_HOST || "127.0.0.1");
    this.#port = options.port ?? Number(process.env.IEC_LOGIN_PORT || 8766);
    this.#fixedUrl = options.url ?? (process.env.IEC_LOGIN_URL || undefined);
    this.keeper = new SessionKeeper({ store: options.store ?? fileStore() });
    this.api = new IecApi(() => this.#idToken(), (input, init) => this.#apiFetch(input, init));
  }

  async start(): Promise<void> {
    await this.keeper.start();
    if (this.#fixedUrl) await this.signInUrl();
  }

  stop(): void {
    this.keeper.stop();
    this.#http?.close();
  }

  /** Starts the sign-in page if it is not up yet and returns its link. */
  signInUrl(): Promise<string> {
    this.#server ??= this.#listen().catch((err: unknown) => {
      this.#server = undefined;
      throw err;
    });
    return this.#server;
  }

  async status(): Promise<SessionStatus> {
    const status = this.keeper.status();
    if (status.state === "signed_in") return status;
    return { ...status, signInUrl: await this.signInUrl() };
  }

  async #idToken(): Promise<string> {
    try {
      return await this.keeper.idToken();
    } catch (err) {
      if (err instanceof SignInRequired) {
        const url = await this.signInUrl();
        throw new SignInRequired(
          `Not signed in to IEC (the session ended, or nobody has signed in yet). ` +
            `Ask the user to open ${url} and sign in there with their ID number and the one-time code IEC sends, then try again. ` +
            `Never ask the user for these in the chat.`,
        );
      }
      throw err;
    }
  }

  /** A rejected token gets one refresh and one retry. */
  async #apiFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    const res = await this.#fetch(input, init);
    if (res.status !== 401) return res;
    await this.keeper.rejected();
    const token = await this.#idToken();
    const headers = { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` };
    const retry = await this.#fetch(input, { ...init, headers });
    if (retry.status === 401) {
      await this.keeper.rejected();
      throw new Unauthorized();
    }
    return retry;
  }

  async #listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        log(`sign-in page failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) page(res, 500, messagePage("Something went wrong", "Reload the page and try again."));
        else res.end();
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.#host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await bind(this.#port);
    } catch (err) {
      // Another client's copy of this server holds the port: any free one will do locally.
      if ((err as { code?: string }).code !== "EADDRINUSE" || this.#fixedUrl) throw err;
      port = await bind(0);
    }
    server.unref();
    this.#http = server;
    const url = this.#fixedUrl ?? `http://localhost:${port}/`;
    log(`sign-in page on ${this.#host}:${port}, linked as ${url}`);
    return url;
  }

  /** Only the hosts the link names: a page another site rebinds to 127.0.0.1 gets nothing. */
  #hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
    if (!this.#fixedUrl) return false;
    return host === new URL(this.#fixedUrl).host.toLowerCase();
  }

  #livePending(): { login: PendingLogin; lengthMs: number; at: number } | undefined {
    if (this.#pending && Date.now() - this.#pending.at > PENDING_TTL_MS) this.#pending = undefined;
    return this.#pending;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req)) {
      page(res, 421, messagePage("Wrong address", "Open the sign-in link exactly as it was given."));
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, iec: this.keeper.status().state }));
      return;
    }
    if (req.method === "GET" && path === "/") {
      const status = this.keeper.status();
      const pending = this.#livePending();
      if (pending) page(res, 200, codePage(pending.login.channel, this.#csrf));
      else page(res, 200, status.state === "signed_in" ? statusPage(status, this.#csrf) : idPage(status, this.#csrf));
      return;
    }
    if (req.method !== "POST" || !["/start", "/code", "/cancel", "/sign-out"].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get("csrf") !== this.#csrf) {
      page(res, 400, messagePage("Form expired", "Reload the page and try again."));
      return;
    }
    if (path === "/cancel") {
      this.#pending = undefined;
    } else if (path === "/sign-out") {
      this.#pending = undefined;
      await this.keeper.signOut();
    } else if (path === "/start") {
      const id = (form.get("id") ?? "").trim();
      const length = SESSION_LENGTHS[form.get("length") ?? DEFAULT_SESSION_LENGTH];
      if (!/^\d{1,9}$/.test(id) || !length) {
        page(res, 400, idPage(this.keeper.status(), this.#csrf, "Enter your ID number (digits only) and pick a length."));
        return;
      }
      try {
        const login = await startLogin(id.padStart(9, "0"), this.#fetch);
        this.#pending = { login, lengthMs: length[1], at: Date.now() };
      } catch (err) {
        page(res, 200, idPage(this.keeper.status(), this.#csrf, `IEC did not send a code: ${messageOf(err)}`));
        return;
      }
    } else {
      const pending = this.#livePending();
      if (!pending) {
        page(res, 200, idPage(this.keeper.status(), this.#csrf, "That sign-in timed out. Start again."));
        return;
      }
      const code = (form.get("code") ?? "").trim();
      try {
        const tokens = await finishLogin(pending.login, code, this.#fetch);
        this.#pending = undefined;
        await this.keeper.signedIn(tokens, pending.lengthMs);
      } catch (err) {
        if (!(err instanceof IecLoginError)) throw err;
        page(res, 200, codePage(pending.login.channel, this.#csrf, `IEC did not accept the code: ${err.message}`));
        return;
      }
    }
    res.writeHead(303, { location: "/", "cache-control": "no-store" }).end();
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS).end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16 * 1024) throw new Error("form too large");
  }
  return body;
}

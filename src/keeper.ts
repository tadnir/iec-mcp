import { IecLoginError, idTokenExpiry, refreshTokens, type Tokens } from "./okta.js";
import type { SavedSession, SessionStore } from "./store.js";

/**
 * Keeps one IEC sign-in usable for as long as the person chose.
 *
 * IEC hands out short-lived tokens plus a refresh token. The keeper refreshes
 * shortly before the id_token expires (on a timer, and before any call that
 * would otherwise send an expired one), saves the new tokens after every
 * refresh so a restart picks them up, and drops the session at the end of the
 * length chosen at sign-in. When IEC refuses the refresh token, the session
 * is gone and a person has to sign in again.
 */

export type KeeperState = "signed_out" | "signed_in" | "expired";

export interface KeeperStatus {
  state: KeeperState;
  signedInAt?: string;
  endsAt?: string;
  lastRefreshAt?: string;
  endedAt?: string;
  lastError?: string;
}

export interface KeeperOptions {
  store: SessionStore;
  refresh?: (tokens: Tokens) => Promise<Tokens>;
  /** Between timer rounds. */
  tickMs?: number;
  /** Refresh when the id_token has less than this left. */
  marginMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_TICK_MS = 5 * 60_000;
export const DEFAULT_MARGIN_MS = 10 * 60_000;
export const LENGTH_ENDED = "The session length chosen at sign-in ran out.";

export class SignInRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequired";
  }
}

export class SessionKeeper {
  readonly #store: SessionStore;
  readonly #refresh: (tokens: Tokens) => Promise<Tokens>;
  readonly #tickMs: number;
  readonly #marginMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #session: SavedSession | undefined;
  #status: KeeperStatus = { state: "signed_out" };
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  signInHint = "Sign in to IEC again.";

  constructor(options: KeeperOptions) {
    this.#store = options.store;
    this.#refresh = options.refresh ?? ((t) => refreshTokens(t));
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#marginMs = options.marginMs ?? DEFAULT_MARGIN_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(`[keeper] ${line}`));
  }

  status(): KeeperStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    await this.reload();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Takes a fresh sign-in: saves it and starts keeping it. */
  async signedIn(tokens: Tokens, lengthMs: number): Promise<void> {
    await this.#serial(async () => {
      const now = this.#now();
      this.#session = { version: 1, tokens, signedInAt: new Date(now).toISOString(), endsAt: now + lengthMs };
      await this.#store.save(this.#session);
      this.#status = { ...this.#fromSession(this.#session), state: "signed_in" };
      this.#log("signed in");
    });
  }

  /** Re-reads the saved session, e.g. one another process signed in. */
  async reload(): Promise<void> {
    await this.#serial(async () => {
      const saved = await this.#store.load();
      if (!saved) {
        this.#session = undefined;
        this.#status = { state: this.#status.state === "expired" ? "expired" : "signed_out" };
        return;
      }
      this.#session = saved;
      this.#status = { ...this.#fromSession(saved), state: "signed_in" };
      await this.#refreshIfDue();
    });
  }

  /** One timer round: drop the session past its length, refresh when due. */
  async tick(): Promise<void> {
    await this.#serial(() => this.#refreshIfDue());
  }

  /** The id_token to call IEC with. Throws SignInRequired when there is none. */
  async idToken(): Promise<string> {
    if (!this.#session) await this.reload();
    await this.#serial(() => this.#refreshIfDue());
    const session = this.#session;
    if (!session) throw new SignInRequired(this.signInHint);
    return session.tokens.id_token;
  }

  /** IEC rejected the token outright: refresh once, else the session is gone. */
  async rejected(): Promise<void> {
    await this.#serial(async () => {
      if (!this.#session) return;
      await this.#doRefresh(true);
    });
  }

  async signOut(): Promise<void> {
    await this.#serial(async () => {
      this.#session = undefined;
      await this.#store.clear();
      this.#status = { state: "signed_out" };
      this.#log("signed out");
    });
  }

  #fromSession(session: SavedSession): KeeperStatus {
    return {
      state: "signed_in",
      signedInAt: session.signedInAt,
      ...(session.endsAt ? { endsAt: new Date(session.endsAt).toISOString() } : {}),
      ...(this.#status.lastRefreshAt ? { lastRefreshAt: this.#status.lastRefreshAt } : {}),
    };
  }

  async #refreshIfDue(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    if (session.endsAt !== undefined && this.#now() >= session.endsAt) {
      await this.#lost(LENGTH_ENDED);
      return;
    }
    const exp = idTokenExpiry(session.tokens);
    if (exp !== undefined && exp * 1000 - this.#now() > this.#marginMs) return;
    await this.#doRefresh(false);
  }

  async #doRefresh(afterRejection: boolean): Promise<void> {
    const session = this.#session!;
    try {
      const tokens = await this.#refresh(session.tokens);
      this.#session = { ...session, tokens };
      await this.#store.save(this.#session);
      this.#status = { ...this.#status, lastRefreshAt: new Date(this.#now()).toISOString() };
      delete this.#status.lastError;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Another copy of this server may have used the refresh token first.
      const saved = await this.#store.load();
      if (saved && saved.tokens.refresh_token !== session.tokens.refresh_token) {
        this.#session = saved;
        return;
      }
      if (err instanceof IecLoginError || afterRejection) {
        await this.#lost(message);
        return;
      }
      // A network error: keep the session and try again on the next round.
      this.#status = { ...this.#status, lastError: message };
      this.#log(`refresh failed, will retry: ${message}`);
    }
  }

  async #lost(reason: string): Promise<void> {
    const signedInAt = this.#session?.signedInAt ?? this.#status.signedInAt;
    this.#session = undefined;
    await this.#store.clear();
    this.#status = {
      state: "expired",
      ...(signedInAt ? { signedInAt } : {}),
      endedAt: new Date(this.#now()).toISOString(),
      lastError: reason,
    };
    this.#log(reason === LENGTH_ENDED ? "the chosen session length ran out; signed out" : `IEC ended the session: ${reason}`);
  }

  /** Refreshes, reloads and saves never overlap (a refresh token is single-use). */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => undefined);
    return run;
  }
}

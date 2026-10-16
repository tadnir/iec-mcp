import { describe, expect, test, vi } from "vitest";
import { LENGTH_ENDED, SessionKeeper, SignInRequired } from "../src/keeper.js";
import { IecLoginError, type Tokens } from "../src/okta.js";
import { idToken, memoryStore } from "./helpers.js";

const HOUR = 3_600_000;
const tokensExpiringAt = (ms: number, refresh = "r1"): Tokens => ({ access_token: "a", refresh_token: refresh, id_token: idToken(Math.floor(ms / 1000)) });
const quiet = () => undefined;

describe("SessionKeeper", () => {
  test("signed out: tools get the sign-in hint", async () => {
    const keeper = new SessionKeeper({ store: memoryStore(), log: quiet });
    keeper.signInHint = "go sign in";
    await keeper.reload();
    expect(keeper.status().state).toBe("signed_out");
    await expect(keeper.idToken()).rejects.toThrow(new SignInRequired("go sign in"));
  });

  test("a sign-in is saved with its end time and used without refreshing", async () => {
    const now = 1_000 * HOUR;
    const store = memoryStore();
    const refresh = vi.fn();
    const keeper = new SessionKeeper({ store, refresh, now: () => now, log: quiet });
    const tokens = tokensExpiringAt(now + HOUR);
    await keeper.signedIn(tokens, 24 * HOUR);
    expect(store.saved?.endsAt).toBe(now + 24 * HOUR);
    expect(await keeper.idToken()).toBe(tokens.id_token);
    expect(refresh).not.toHaveBeenCalled();
    expect(keeper.status()).toMatchObject({ state: "signed_in", endsAt: new Date(now + 24 * HOUR).toISOString() });
  });

  test("refreshes near expiry and saves the new tokens", async () => {
    let now = 1_000 * HOUR;
    const store = memoryStore();
    const fresh = tokensExpiringAt(now + 2 * HOUR, "r2");
    const refresh = vi.fn(async () => fresh);
    const keeper = new SessionKeeper({ store, refresh, now: () => now, log: quiet });
    await keeper.signedIn(tokensExpiringAt(now + HOUR), 24 * HOUR);
    now += 55 * 60_000;
    await keeper.tick();
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.saved?.tokens.refresh_token).toBe("r2");
    expect(await keeper.idToken()).toBe(fresh.id_token);
  });

  test("a refused refresh token ends the session", async () => {
    let now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({
      store,
      refresh: async () => {
        throw new IecLoginError("invalid_grant");
      },
      now: () => now,
      log: quiet,
    });
    await keeper.signedIn(tokensExpiringAt(now + HOUR), 24 * HOUR);
    now += HOUR;
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: "invalid_grant" });
    expect(store.saved).toBeUndefined();
  });

  test("a network error keeps the session for the next round", async () => {
    let now = 1_000 * HOUR;
    const keeper = new SessionKeeper({
      store: memoryStore(),
      refresh: async () => {
        throw new TypeError("fetch failed");
      },
      now: () => now,
      log: quiet,
    });
    await keeper.signedIn(tokensExpiringAt(now + HOUR), 24 * HOUR);
    now += 55 * 60_000;
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "signed_in", lastError: "fetch failed" });
  });

  test("another process that refreshed first is adopted, not treated as a sign-out", async () => {
    let now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({
      store,
      refresh: async () => {
        // Meanwhile the other copy rotated the refresh token.
        store.saved = { ...store.saved!, tokens: tokensExpiringAt(now + 2 * HOUR, "r-other") };
        throw new IecLoginError("invalid_grant");
      },
      now: () => now,
      log: quiet,
    });
    await keeper.signedIn(tokensExpiringAt(now + HOUR), 24 * HOUR);
    now += 55 * 60_000;
    await keeper.tick();
    expect(keeper.status().state).toBe("signed_in");
    expect(store.saved?.tokens.refresh_token).toBe("r-other");
  });

  test("the chosen length runs out: signed out on the next round", async () => {
    let now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, refresh: async (t) => t, now: () => now, log: quiet });
    await keeper.signedIn(tokensExpiringAt(now + 100 * HOUR), HOUR);
    now += HOUR;
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: LENGTH_ENDED });
    await expect(keeper.idToken()).rejects.toBeInstanceOf(SignInRequired);
  });

  test("a sign-in written by another process is picked up on the next call", async () => {
    const now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, now: () => now, log: quiet });
    await keeper.reload();
    const tokens = tokensExpiringAt(now + HOUR);
    store.saved = { version: 1, tokens, signedInAt: new Date(now).toISOString(), endsAt: now + HOUR * 2 };
    expect(await keeper.idToken()).toBe(tokens.id_token);
  });

  test("sign out clears the store", async () => {
    const now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, now: () => now, log: quiet });
    await keeper.signedIn(tokensExpiringAt(now + HOUR), HOUR * 2);
    await keeper.signOut();
    expect(store.saved).toBeUndefined();
    expect(keeper.status()).toEqual({ state: "signed_out" });
  });
});

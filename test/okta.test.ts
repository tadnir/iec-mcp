import { describe, expect, test } from "vitest";
import { finishLogin, formPostValue, idTokenExpiry, refreshTokens, startLogin, IecLoginError } from "../src/okta.js";
import { fakeFetch, idToken, json } from "./helpers.js";

const tokens = { access_token: "a", refresh_token: "r1", id_token: idToken(2_000_000_000), token_type: "Bearer" };

function okta() {
  return fakeFetch((call) => {
    if (call.url.endsWith("/api/v1/authn")) {
      return json({
        stateToken: "st",
        _embedded: {
          factors: [
            { id: "f-email", factorType: "email", profile: { email: "someone@example.com" } },
            { id: "f-sms", factorType: "email", profile: { email: "0500000000@sns.iec.co.il" } },
          ],
        },
      });
    }
    if (call.url.includes("/factors/f-sms/verify")) {
      const body = JSON.parse(call.body!) as { passCode?: string };
      if (!body.passCode) return json({ status: "MFA_CHALLENGE" });
      if (body.passCode !== "123456") return json({ errorSummary: "Invalid Passcode/Answer" }, 403);
      return json({ status: "SUCCESS", sessionToken: "sess" });
    }
    if (call.url.includes("/oauth2/default/v1/authorize")) {
      return new Response('<form><input type="hidden" name="code" value="abc\\x2Ddef"/></form>', { status: 200 });
    }
    if (call.url.endsWith("/oauth2/default/v1/token")) return json(tokens);
    return undefined;
  });
}

describe("okta sign-in", () => {
  test("prefers the SMS factor and sends the code", async () => {
    const f = okta();
    const pending = await startLogin("000000018", f);
    expect(pending).toEqual({ stateToken: "st", factorId: "f-sms", channel: "sms" });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ username: "000000018@iec.co.il" });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ stateToken: "st" });
  });

  test("a right code ends in tokens through PKCE", async () => {
    const f = okta();
    const got = await finishLogin({ stateToken: "st", factorId: "f-sms", channel: "sms" }, "123456", f);
    expect(got.refresh_token).toBe("r1");
    const authorize = new URL(f.calls[1]!.url);
    expect(authorize.searchParams.get("sessionToken")).toBe("sess");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const form = new URLSearchParams(f.calls[2]!.body);
    expect(form.get("code")).toBe("abc-def");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a wrong code is a login error with Okta's reason", async () => {
    await expect(finishLogin({ stateToken: "st", factorId: "f-sms", channel: "sms" }, "000000", okta())).rejects.toThrow(
      new IecLoginError("Invalid Passcode/Answer"),
    );
  });

  test("refresh keeps the old refresh token when Okta leaves it out", async () => {
    const f = fakeFetch(() => json({ id_token: idToken(1), access_token: "a2" }));
    const fresh = await refreshTokens(tokens, f);
    expect(fresh.refresh_token).toBe("r1");
    expect(new URLSearchParams(f.calls[0]!.body).get("grant_type")).toBe("refresh_token");
  });

  test("a refused refresh token is a login error", async () => {
    const f = fakeFetch(() => json({ error: "invalid_grant", error_description: "The refresh token is invalid or expired." }, 400));
    await expect(refreshTokens(tokens, f)).rejects.toBeInstanceOf(IecLoginError);
  });

  test("id_token expiry and form_post decoding", () => {
    expect(idTokenExpiry(tokens)).toBe(2_000_000_000);
    expect(idTokenExpiry({ ...tokens, id_token: "garbage" })).toBeUndefined();
    expect(formPostValue('<input name="code" type="hidden" value="a&#x2d;b&amp;c"/>', "code")).toBe("a-b&c");
    expect(formPostValue("<p>nothing</p>", "code")).toBeUndefined();
  });
});

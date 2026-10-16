/**
 * Sign-in to IEC's customer account, the way IEC's own mobile app does it.
 *
 * IEC accounts live in an Okta tenant. A sign-in is: the ID number starts an
 * Okta "authn" transaction, Okta sends a one-time code by SMS or email, the
 * code completes it with a session token, and an authorization-code + PKCE
 * exchange turns that into tokens. The refresh token (offline_access) keeps
 * the account signed in without another code; the API takes the id_token as
 * its Bearer token.
 *
 * Endpoints and the app's public client id as documented by the community
 * py-iec-api project (https://github.com/GuyKh/py-iec-api, MIT).
 */
import { createHash, randomBytes } from "node:crypto";

export const OKTA_BASE_URL = process.env.IEC_OKTA_BASE_URL || "https://iec-ext.okta.com";
/** The IEC mobile app's public client id (a PKCE public client, not a secret). */
export const CLIENT_ID = process.env.IEC_CLIENT_ID || "0oaqf6zr7yEcQZqqt2p7";
export const REDIRECT_URI = process.env.IEC_REDIRECT_URI || "com.iecrn:/";
const SCOPE = "openid email profile offline_access";

export interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** A sign-in waiting for the one-time code. */
export interface PendingLogin {
  stateToken: string;
  factorId: string;
  /** Where the code went: "sms" or "email". */
  channel: string;
}

export class IecLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IecLoginError";
  }
}

export type Fetch = typeof fetch;

interface OktaFactor {
  id: string;
  factorType?: string;
  profile?: { email?: string };
}

/** IEC sends SMS codes through an Okta email factor at its own SMS gateway domain. */
function channelOf(factor: OktaFactor): string {
  if (factor.factorType === "email" && factor.profile?.email?.endsWith("@sns.iec.co.il")) return "sms";
  return factor.factorType ?? "unknown";
}

async function postJson(f: Fetch, url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await f(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const summary = typeof json.errorSummary === "string" ? json.errorSummary : `HTTP ${res.status}`;
    throw new IecLoginError(summary);
  }
  return json;
}

async function postForm(f: Fetch, url: string, form: Record<string, string>): Promise<Tokens> {
  const res = await f(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.id_token !== "string") {
    const why = typeof json.error_description === "string" ? json.error_description : `HTTP ${res.status}`;
    throw new IecLoginError(why);
  }
  return json as unknown as Tokens;
}

/** Starts a sign-in for an Israeli ID number and has IEC send the one-time code. */
export async function startLogin(idNumber: string, f: Fetch = fetch): Promise<PendingLogin> {
  const authn = await postJson(f, `${OKTA_BASE_URL}/api/v1/authn`, { username: `${idNumber}@iec.co.il` });
  const stateToken = typeof authn.stateToken === "string" ? authn.stateToken : "";
  const factors = ((authn._embedded as { factors?: OktaFactor[] } | undefined)?.factors ?? []).filter((x) => x.id);
  if (!stateToken || factors.length === 0) throw new IecLoginError("IEC did not offer a way to send a code for this ID.");
  const factor = factors.find((x) => channelOf(x) === "sms") ?? factors[0]!;
  // Verifying without a passCode is what makes Okta send the code.
  await postJson(f, `${OKTA_BASE_URL}/api/v1/authn/factors/${encodeURIComponent(factor.id)}/verify`, { stateToken });
  return { stateToken, factorId: factor.id, channel: channelOf(factor) };
}

/** Completes a sign-in with the one-time code and returns the tokens. */
export async function finishLogin(pending: PendingLogin, code: string, f: Fetch = fetch): Promise<Tokens> {
  const verified = await postJson(
    f,
    `${OKTA_BASE_URL}/api/v1/authn/factors/${encodeURIComponent(pending.factorId)}/verify`,
    { stateToken: pending.stateToken, passCode: code },
  );
  const sessionToken = typeof verified.sessionToken === "string" ? verified.sessionToken : "";
  if (!sessionToken) throw new IecLoginError("The code was not accepted.");

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorize = new URL(`${OKTA_BASE_URL}/oauth2/default/v1/authorize`);
  for (const [k, v] of Object.entries({
    client_id: CLIENT_ID,
    response_type: "id_token code",
    response_mode: "form_post",
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state: base64url(randomBytes(9)),
    nonce: base64url(randomBytes(9)),
    code_challenge_method: "S256",
    code_challenge: challenge,
    sessionToken,
  })) {
    authorize.searchParams.set(k, v);
  }
  const res = await f(authorize, { headers: { accept: "text/html" } });
  const authCode = formPostValue(await res.text(), "code");
  if (!authCode) throw new IecLoginError("IEC did not complete the sign-in.");

  return postForm(f, `${OKTA_BASE_URL}/oauth2/default/v1/token`, {
    client_id: CLIENT_ID,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code: authCode,
  });
}

/** Trades the refresh token for fresh tokens. */
export async function refreshTokens(tokens: Tokens, f: Fetch = fetch): Promise<Tokens> {
  const fresh = await postForm(f, `${OKTA_BASE_URL}/oauth2/default/v1/token`, {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
    scope: SCOPE,
  });
  // Okta may keep the same refresh token and leave it out of the answer.
  return { ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token };
}

/** Seconds-since-epoch expiry of the id_token, which is what the API checks. */
export function idTokenExpiry(tokens: Tokens): number | undefined {
  const payload = tokens.id_token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** A hidden input's value in Okta's form_post page; Okta escapes it as HTML entities or \xNN. */
export function formPostValue(html: string, name: string): string | undefined {
  const re = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "i");
  const raw = re.exec(html)?.[1];
  if (raw === undefined) return undefined;
  return raw
    .replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

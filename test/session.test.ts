import { afterEach, describe, expect, test } from "vitest";
import { request } from "node:http";
import { SessionManager } from "../src/session.js";
import { createMcpServer } from "../src/server.js";
import { fakeFetch, idToken, json, memoryStore } from "./helpers.js";

const exp = Math.floor(Date.now() / 1000) + 3600;

/** IEC and Okta, answered from fixtures; ids are made up. */
function world() {
  return fakeFetch((call) => {
    if (call.url.endsWith("/api/v1/authn")) {
      return json({ stateToken: "st", _embedded: { factors: [{ id: "f1", factorType: "sms" }] } });
    }
    if (call.url.includes("/factors/f1/verify")) {
      const body = JSON.parse(call.body!) as { passCode?: string };
      if (!body.passCode) return json({ status: "MFA_CHALLENGE" });
      return body.passCode === "123456" ? json({ status: "SUCCESS", sessionToken: "sess" }) : json({ errorSummary: "Invalid Passcode/Answer" }, 403);
    }
    if (call.url.includes("/v1/authorize")) return new Response('<input type="hidden" name="code" value="c1"/>');
    if (call.url.endsWith("/v1/token")) return json({ access_token: "a", refresh_token: "r", id_token: idToken(exp) });
    if (call.url.endsWith("/api/customer")) return json({ bpNumber: "1000", accounts: [] });
    if (call.url.endsWith("/api/customer/contract/1000")) {
      return json({ data: { contracts: [{ contractId: "2000" }] }, reponseDescriptor: { isSuccess: true } });
    }
    if (call.url.includes("/api/BillingCollection/invoices/2000/1000")) {
      return json({ data: { invoices: [{ documentID: "3000", amountToPay: 0 }] }, reponseDescriptor: { isSuccess: true } });
    }
    if (call.url.endsWith("/api/Device/2000")) return json([{ deviceNumber: "M1", deviceCode: "7", isActive: true }]);
    if (call.url.endsWith("/api/Consumption/RemoteReadingRange/2000")) return json({ reportStatus: 0, meterList: [] });
    return undefined;
  });
}

function http(port: number, method: string, path: string, body?: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; text: string; location?: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/x-www-form-urlencoded" } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, text, location: res.headers.location }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let session: SessionManager | undefined;
afterEach(() => session?.stop());

async function signedOutSession() {
  const f = world();
  session = new SessionManager({ store: memoryStore(), fetch: f, port: 0 });
  await session.start();
  const url = await session.signInUrl();
  return { f, session, port: Number(new URL(url).port) };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;

describe("sign-in page", () => {
  test("ID, then code, then signed in; the ID only goes to Okta", async () => {
    const { f, session, port } = await signedOutSession();
    const first = await http(port, "GET", "/");
    expect(first.text).toContain("Send code");
    const csrf = csrfOf(first.text);

    expect((await http(port, "POST", "/start", `csrf=${csrf}&id=18&length=1d`)).status).toBe(303);
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ username: "000000018@iec.co.il" });
    expect((await http(port, "GET", "/")).text).toContain("by SMS");

    const wrong = await http(port, "POST", "/code", `csrf=${csrf}&code=000000`);
    expect(wrong.text).toContain("Invalid Passcode/Answer");

    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(session.keeper.status().state).toBe("signed_in");
    expect((await http(port, "GET", "/")).text).toContain("Signed in to IEC");
  });

  test("other hosts and forms without the token are refused", async () => {
    const { port } = await signedOutSession();
    expect((await http(port, "GET", "/", undefined, "attacker.example")).status).toBe(421);
    expect((await http(port, "POST", "/start", "csrf=nope&id=18&length=1d")).status).toBe(400);
  });
});

describe("tools", () => {
  async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
    const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
    return (await handler({ method: "tools/call", params: { name, arguments: args } }, {})) as { isError?: boolean; content: { text: string }[] };
  }

  test("signed out: data tools answer with the sign-in link", async () => {
    const { session, port } = await signedOutSession();
    const result = await callTool(createMcpServer(session), "list_invoices");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`http://localhost:${port}/`);
    expect(result.content[0]!.text).toContain("Never ask the user");
  });

  test("signed in: ids default to the first contract and meter", async () => {
    const { f, session } = await signedOutSession();
    await session.keeper.signedIn({ access_token: "a", refresh_token: "r", id_token: idToken(exp) }, 3_600_000);
    const server = createMcpServer(session);
    const invoices = await callTool(server, "list_invoices");
    expect(JSON.parse(invoices.content[0]!.text)).toEqual({ invoices: [{ documentID: "3000", amountToPay: 0 }] });
    const usage = await callTool(server, "get_consumption", { date: "2026-01-01", resolution: "week" });
    expect(usage.isError).toBeUndefined();
    const reading = f.calls.find((c) => c.url.includes("RemoteReadingRange"))!;
    expect(JSON.parse(reading.body!)).toMatchObject({
      contractNumber: "2000",
      fromDate: "2026-01-01",
      resolution: 2,
      smartMetersList: [{ meterKind: "Consumption", meterCode: "7", meterSerial: "M1" }],
    });
    expect(reading.headers.authorization).toBe(`Bearer ${idToken(exp)}`);
  });

  test("bad ids never reach a URL", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn({ access_token: "a", refresh_token: "r", id_token: idToken(exp) }, 3_600_000);
    const result = await callTool(createMcpServer(session), "list_invoices", { contractId: "../x" });
    expect(result.isError).toBe(true);
  });
});

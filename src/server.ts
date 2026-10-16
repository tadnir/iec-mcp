import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RESOLUTIONS, type IecApi, type Meter } from "./api.js";
import type { SessionManager } from "./session.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Unofficial, read-only reader of the user's own Israel Electric Corporation (IEC, חברת החשמל) account. Unaffiliated with IEC.",
  "Tools: get_customer → list_contracts → get_electric_bill / list_invoices → get_invoice_pdf; list_meters → get_last_meter_reading / get_consumption (smart meters only).",
  "contractId and bpNumber default to the account's first contract; pass them when the account has several.",
  "When a tool says the user must sign in, call iec_login and give the user the link it returns; the user signs in on that page (ID number and a one-time code). Never ask for the ID or the code in the chat.",
  "Amounts are in ILS, consumption in kWh. Keep Hebrew text as IEC gives it.",
].join(" ");

const ids = {
  contractId: z.string().regex(/^\d+$/).optional().describe("Contract number; defaults to the first contract."),
  bpNumber: z.string().regex(/^\d+$/).optional().describe("Business partner number; defaults to the signed-in customer's."),
};
const schemas = {
  empty: z.object({}),
  contracts: z.object({ bpNumber: ids.bpNumber }),
  contract: z.object(ids),
  invoices: z.object({ ...ids, onlyOpen: z.boolean().optional().describe("Only unpaid invoices.") }),
  invoicePdf: z.object({ ...ids, invoiceNumber: z.string().regex(/^\d+$/).describe("documentID from list_invoices.") }),
  meters: z.object({ contractId: ids.contractId }),
  consumption: z.object({
    ...ids,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("First day, yyyy-MM-dd."),
    resolution: z
      .enum(Object.keys(RESOLUTIONS) as [keyof typeof RESOLUTIONS, ...(keyof typeof RESOLUTIONS)[]])
      .default("day")
      .describe("day: that day in 15-minute steps; week / month: daily totals from that day."),
    meterSerial: z.string().regex(/^[0-9A-Za-z-]+$/).optional().describe("deviceNumber from list_meters; defaults to the first meter."),
    meterCode: z.string().regex(/^[0-9A-Za-z-]+$/).optional().describe("deviceCode from list_meters."),
  }),
};

function inputSchema(schema: z.ZodObject<z.ZodRawShape>): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    let inner = field;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) inner = inner._def.innerType;
    const type = inner instanceof z.ZodBoolean ? "boolean" : "string";
    properties[key] = {
      type,
      ...(field.description ? { description: field.description } : {}),
      ...(inner instanceof z.ZodEnum ? { enum: inner.options } : {}),
    };
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const TOOLS: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[] = [
  { name: "iec_login", description: "Get the link where the user signs in to IEC (ID number and one-time code are typed on that page, never in the chat). Returns the status when already signed in.", schema: schemas.empty },
  { name: "iec_session_status", description: "Whether this server is signed in to IEC, since when, until when, and the sign-in link when it is not.", schema: schemas.empty },
  { name: "iec_logout", description: "Sign out of IEC here: forget the saved session.", schema: schemas.empty },
  { name: "get_customer", description: "The signed-in IEC customer: BP number, accounts, name and contact details.", schema: schemas.empty },
  { name: "list_contracts", description: "The customer's electricity contracts (one per address) with debt and due date.", schema: schemas.contracts },
  { name: "get_electric_bill", description: "The current bill summary of a contract.", schema: schemas.contract },
  { name: "list_invoices", description: "A contract's invoices: amounts, paid status, billing periods and consumption.", schema: schemas.invoices },
  { name: "get_invoice_pdf", description: "Download one invoice as a PDF (base64).", schema: schemas.invoicePdf },
  { name: "list_meters", description: "The meters on a contract, with deviceNumber and deviceCode.", schema: schemas.meters },
  { name: "get_last_meter_reading", description: "The last reading of each meter on a contract.", schema: schemas.contract },
  { name: "get_consumption", description: "Smart-meter consumption (kWh): one day in 15-minute steps, or a week / month of daily totals.", schema: schemas.consumption },
];

/** Account ids the tools fall back to, read once per sign-in. */
class Defaults {
  #bp: string | undefined;
  #contract: string | undefined;
  #meter: Map<string, Meter> = new Map();
  #signedInAt: string | undefined;
  constructor(readonly api: IecApi) {}

  /** A new sign-in may be another account: forget what was read for the old one. */
  sync(signedInAt: string | undefined): void {
    if (signedInAt !== this.#signedInAt) this.reset();
    this.#signedInAt = signedInAt;
  }

  reset(): void {
    this.#bp = undefined;
    this.#contract = undefined;
    this.#meter.clear();
  }

  async bp(given?: string): Promise<string> {
    if (given) return given;
    if (!this.#bp) {
      const bp = (await this.api.customer()).bpNumber;
      if (typeof bp !== "string" || !bp) throw new Error("IEC did not return a BP number for this customer.");
      this.#bp = bp;
    }
    return this.#bp;
  }

  async contract(bpNumber: string, given?: string): Promise<string> {
    if (given) return given;
    if (!this.#contract) {
      const data = (await this.api.contracts(bpNumber)) as { contracts?: { contractId?: string }[] } | undefined;
      const first = data?.contracts?.find((c) => c.contractId)?.contractId;
      if (!first) throw new Error("No IEC contract found for this customer.");
      this.#contract = first;
    }
    return this.#contract;
  }

  async meter(contractId: string, serial?: string, code?: string): Promise<Meter> {
    if (serial && code) return { serial, code };
    let meter = this.#meter.get(contractId);
    if (!meter) {
      const devices = ((await this.api.devices(contractId)) ?? []) as { deviceNumber?: string; deviceCode?: string; isActive?: boolean }[];
      const found =
        devices.find((d) => d.deviceNumber && d.deviceCode && d.isActive !== false && (!serial || d.deviceNumber === serial)) ??
        devices.find((d) => d.deviceNumber && d.deviceCode);
      if (!found) throw new Error("No meter with a serial and code on this contract.");
      meter = { serial: String(found.deviceNumber), code: String(found.deviceCode) };
      if (!serial) this.#meter.set(contractId, meter);
    }
    return meter;
  }
}

export function createMcpServer(session: SessionManager): Server {
  const api = session.api;
  const defaults = new Defaults(api);
  const server = new Server({ name: "iec-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })),
  }));

  async function call(name: string, raw: Record<string, unknown>): Promise<unknown> {
    defaults.sync(session.keeper.status().signedInAt);
    switch (name) {
      case "iec_login": {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return { ...status, message: `Ask the user to open ${status.signInUrl} and sign in there, then try the request again.` };
      }
      case "iec_session_status":
        return session.status();
      case "iec_logout":
        await session.keeper.signOut();
        defaults.reset();
        return { state: "signed_out", message: "Signed out; the saved session is gone." };
      case "get_customer":
        return api.customer();
      case "list_contracts": {
        const args = schemas.contracts.parse(raw);
        return api.contracts(await defaults.bp(args.bpNumber));
      }
      case "get_electric_bill": {
        const args = schemas.contract.parse(raw);
        const bp = await defaults.bp(args.bpNumber);
        return api.electricBill(bp, await defaults.contract(bp, args.contractId));
      }
      case "list_invoices": {
        const args = schemas.invoices.parse(raw);
        const bp = await defaults.bp(args.bpNumber);
        return api.invoices(bp, await defaults.contract(bp, args.contractId), args.onlyOpen);
      }
      case "get_invoice_pdf": {
        const args = schemas.invoicePdf.parse(raw);
        const bp = await defaults.bp(args.bpNumber);
        const contract = await defaults.contract(bp, args.contractId);
        const bytes = await api.invoicePdf(bp, contract, args.invoiceNumber);
        return {
          filename: `iec-invoice-${args.invoiceNumber}.pdf`,
          mimeType: "application/pdf",
          byteLength: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
        };
      }
      case "list_meters": {
        const args = schemas.meters.parse(raw);
        const contract = args.contractId ?? (await defaults.contract(await defaults.bp()));
        return api.devices(contract);
      }
      case "get_last_meter_reading": {
        const args = schemas.contract.parse(raw);
        const bp = await defaults.bp(args.bpNumber);
        return api.lastMeterReading(bp, await defaults.contract(bp, args.contractId));
      }
      case "get_consumption": {
        const args = schemas.consumption.parse(raw);
        const contract = args.contractId ?? (await defaults.contract(await defaults.bp(args.bpNumber)));
        const meter = await defaults.meter(contract, args.meterSerial, args.meterCode);
        return api.remoteReading(contract, meter, args.date, args.resolution);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : "tool failed" }] };
    }
  });

  return server;
}

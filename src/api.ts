/**
 * IEC's customer API (iecapi.iec.co.il), read-only calls only.
 *
 * Paths and payloads as documented by the community py-iec-api project
 * (https://github.com/GuyKh/py-iec-api, MIT). Most answers wrap their data as
 * { data, reponseDescriptor: { isSuccess, code, description } } (sic).
 */
import type { Fetch } from "./okta.js";

export const API_BASE_URL = process.env.IEC_API_BASE_URL || "https://iecapi.iec.co.il/api/";

const HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "he,en;q=0.9",
  origin: "https://www.iec.co.il",
  referer: "https://www.iec.co.il/",
  "x-iec-idt": "1",
  "x-iec-webview": "1",
};

export class IecApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IecApiError";
  }
}

/** The bearer IEC rejected: a sign-in is needed. */
export class Unauthorized extends IecApiError {
  constructor() {
    super("IEC rejected the session.", 401);
    this.name = "Unauthorized";
  }
}

/** One day of 15-minute readings, a week of daily totals, or a month of daily totals. */
export const RESOLUTIONS = { day: 1, week: 2, month: 3 } as const;
export type Resolution = keyof typeof RESOLUTIONS;

export interface Meter {
  /** deviceNumber: the meter's serial. */
  serial: string;
  /** deviceCode. */
  code: string;
}

export class IecApi {
  readonly #token: () => Promise<string>;
  readonly #fetch: Fetch;

  /** token returns the current id_token (refreshed by the caller as needed). */
  constructor(token: () => Promise<string>, f: Fetch = fetch) {
    this.#token = token;
    this.#fetch = f;
  }

  /** The account holder: BP number, accounts, name and contact details. */
  customer(): Promise<Record<string, unknown>> {
    return this.#get("customer", false);
  }

  /** Electricity contracts (one per address) with debt and due dates. */
  contracts(bpNumber: string): Promise<unknown> {
    return this.#get(`customer/contract/${seg(bpNumber)}`);
  }

  /** The current bill summary for a contract. */
  electricBill(bpNumber: string, contractId: string): Promise<unknown> {
    return this.#get(`ElectricBillsDrawers/ElectricBills/${seg(contractId)}/${seg(bpNumber)}`);
  }

  /** Every invoice of a contract (or only unpaid ones). */
  invoices(bpNumber: string, contractId: string, onlyOpen?: boolean): Promise<unknown> {
    const query = onlyOpen === undefined ? "" : `?onlyOpen=${onlyOpen}`;
    return this.#get(`BillingCollection/invoices/${seg(contractId)}/${seg(bpNumber)}${query}`);
  }

  /** One invoice as a PDF. */
  async invoicePdf(bpNumber: string, contractId: string, invoiceNumber: string): Promise<Uint8Array> {
    const res = await this.#request("BillingCollection/pdf", {
      method: "POST",
      headers: { accept: "application/pdf", "content-type": "application/json" },
      body: JSON.stringify({ invoiceNumber, contractId, bpNumber }),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.headers.get("content-type")?.includes("pdf") && !isPdf(bytes)) {
      throw new IecApiError("IEC did not return a PDF for this invoice.");
    }
    return bytes;
  }

  /** The last reading of each meter on a contract. */
  lastMeterReading(bpNumber: string, contractId: string): Promise<unknown> {
    return this.#get(`Device/LastMeterReading/${seg(contractId)}/${seg(bpNumber)}`);
  }

  /** The meters on a contract. */
  devices(contractId: string): Promise<unknown> {
    return this.#get(`Device/${seg(contractId)}`, false);
  }

  /** Smart-meter consumption from a date (yyyy-MM-dd) at the given resolution. */
  remoteReading(contractId: string, meter: Meter, fromDate: string, resolution: Resolution): Promise<unknown> {
    return this.#post(`Consumption/RemoteReadingRange/${seg(contractId)}`, {
      contractNumber: contractId,
      lastInvoiceDate: fromDate,
      fromDate,
      resolution: RESOLUTIONS[resolution],
      smartMetersList: [{ meterKind: "Consumption", meterCode: meter.code, meterSerial: meter.serial }],
    });
  }

  async #get(path: string, wrapped = true): Promise<never> {
    const res = await this.#request(path, { method: "GET" });
    return unwrap(await res.json(), wrapped) as never;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const res = await this.#request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return unwrap(await res.json(), false);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.#token();
    const res = await this.#fetch(new URL(path, API_BASE_URL), {
      ...init,
      headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) throw new Unauthorized();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IecApiError(`IEC answered HTTP ${res.status}${errorText(text)}`, res.status);
    }
    return res;
  }
}

function seg(value: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(value)) throw new IecApiError(`Not an IEC identifier: ${JSON.stringify(value)}`);
  return value;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function errorText(text: string): string {
  try {
    const json = JSON.parse(text) as { Error?: string; error?: string };
    const message = json.Error ?? json.error;
    return message ? `: ${message}` : "";
  } catch {
    return "";
  }
}

/** Takes data out of IEC's { data, reponseDescriptor } wrapper; a failed descriptor throws. */
export function unwrap(json: unknown, wrapped: boolean): unknown {
  if (!wrapped || typeof json !== "object" || json === null || !("reponseDescriptor" in json)) return json;
  const { data, reponseDescriptor } = json as {
    data?: unknown;
    reponseDescriptor?: { isSuccess?: boolean; code?: string; description?: string };
  };
  if ((data === undefined || data === null) && reponseDescriptor && !reponseDescriptor.isSuccess) {
    throw new IecApiError(reponseDescriptor.description || `IEC error ${reponseDescriptor.code ?? ""}`.trim());
  }
  return data;
}

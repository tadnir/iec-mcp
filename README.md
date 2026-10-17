# iec-mcp

**Read your own Israel Electric Corporation (IEC, חברת החשמל) account from an AI assistant over MCP: bills, invoice PDFs, meter readings and smart-meter consumption.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with IEC. It uses the same customer API as IEC's own website and app, which can change without notice.

Everything runs on your machine. You sign in through your own browser, the session is saved only on your computer, and this project has no hosted backend and collects nothing. Whatever your AI client requests is passed to that client and handled under its provider's privacy terms.

The IEC endpoints and sign-in flow follow the community [py-iec-api](https://github.com/GuyKh/py-iec-api) project (MIT), which documents them for Home Assistant.

## Terms of use

- **Own account only.**
- **Read-only.** No payments, no changes to the account, no requests to IEC.
- **The session file is secret.** It holds a refresh token, is saved with mode `0600` under `~/.config/iec-mcp/`, and must never be committed or pasted.

## Install

```sh
git clone https://github.com/tadnir/iec-mcp.git
cd iec-mcp
npm install
npm test
```

## Use it from an MCP client

```json
{
  "mcpServers": {
    "iec": {
      "command": "npx",
      "args": ["tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/iec-mcp"
    }
  }
}
```

For Claude Desktop, use absolute paths: `"command": "/absolute/path/to/node"` with `"args": ["/absolute/path/to/iec-mcp/node_modules/.bin/tsx", "/absolute/path/to/iec-mcp/src/main.ts"]`.

### Signing in

1. Ask your assistant something, for example "how much was my last electricity bill?".
2. While nobody is signed in, the tools answer with a link to a sign-in page this server serves on `http://localhost:8766/`. `iec_login` returns the same link.
3. Open it, enter your ID number and pick how long to stay signed in (1 hour to 30 days). IEC sends a one-time code by SMS or email; enter it on the page.
4. Ask again.

Your ID number and the code are only ever typed on that page and sent to IEC. The assistant only ever sees the link.

IEC's sign-in gives a refresh token, so the session doesn't depend on activity: the server refreshes the tokens shortly before they expire, saves them, and signs out at the end of the length you picked. A restart picks the saved session back up.

### Tools

| Tool | What it reads |
| --- | --- |
| `get_customer` | The account holder: BP number, accounts, contact details |
| `list_contracts` | Contracts (one per address) with debt and due date |
| `get_electric_bill` | The current bill summary |
| `list_invoices`, `get_invoice_pdf` | Invoices with amounts, periods and consumption; one invoice as a PDF |
| `list_meters`, `get_last_meter_reading` | Meters on a contract and their last readings |
| `get_consumption` | Smart-meter kWh: one day in 15-minute steps, or a week or month of daily totals |
| `iec_login`, `iec_session_status`, `iec_logout` | The sign-in link, whether a session is live and until when, and sign-out |

`bpNumber` and `contractId` default to the signed-in customer and their first contract, and the meter to the contract's first meter.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `IEC_CONFIG_DIR` | `~/.config/iec-mcp` | Where the session is saved |
| `IEC_LOGIN_HOST` | `127.0.0.1` | Address the sign-in page listens on |
| `IEC_LOGIN_PORT` | `8766` | Its port; a free one is used if another copy holds it |
| `IEC_LOGIN_URL` | `http://localhost:<port>/` | The link handed out, when the page sits behind a reverse proxy. When set, the page starts with the server. |

## Hosting one long-lived copy

To share one session between several clients, run a single copy on an always-on machine and put a stdio-to-HTTP MCP proxy in front of it, such as [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy), with a bearer token per client. Keep it on your own network or a private VPN, never on the internet. Put the sign-in page behind your own authentication, either at the root of a host name or under a path your reverse proxy strips (for example `https://mcp.example.com/iec/` to `/`; the page links and posts only to relative paths), and set `IEC_LOGIN_URL` to that address, ending in `/` (and `IEC_LOGIN_HOST=0.0.0.0` inside a container).

The `Dockerfile` builds an image of the stdio server, published as `ghcr.io/tadnir/iec-mcp` from master. Run it with `docker run -i`, or start it from your MCP proxy.

Every token holder reads the account that signed in on the page; the proxy's tokens and the IEC session are unrelated. For a second person, run a second copy with its own `IEC_CONFIG_DIR`, tokens and sign-in page.

The sign-in page answers only to `localhost`, `127.0.0.1` and the host in `IEC_LOGIN_URL`, and each form carries a per-process token. Anyone who can open the page can sign in or out, so keep it on loopback or behind your own authentication.

## License

[MIT](LICENSE)

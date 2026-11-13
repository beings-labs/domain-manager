# @beings-labs/dsh-domain-manager

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for managing a **domain portfolio**: registrations synced from registrars, expiry dates, auto-renewal flags, yearly renewal costs, and domain availability checks.

No bundled portfolio and no credentials — install it, point it at your registrars if you want syncing, and the data stays in a JSON file on your machine.

## Features

- **Portfolio store** — add, update and remove domains; track registrar, expiry, auto-renewal, renewal price, promo price, purpose, group and notes.
- **Cost reporting** — total yearly renewal cost, the part charged automatically (auto-renew on) versus the part that lapses unless renewed manually (auto-renew off), per-registrar subtotals, promo-adjusted totals, and domains expiring soon.
- **Staleness warnings** — registrar-synced facts age between syncs; reports and markdown exports warn when synced domains have not been refreshed for more than `staleAfterDays` (manual domains without a sync are not counted).
- **Registrar sync** — pull registrations from **Cloudflare Registrar** and **Namecheap** (read-only) into the store, keeping your local purpose/group/notes. **Auto mode is the default for both registrars**: Namecheap prefers configured API credentials, otherwise uses MCP; Cloudflare prefers a configured API token, otherwise the Cloudflare MCP browser login. Namecheap API mode is the only mode that refreshes the account's own renewal pricing: regular rate, current promo and per-year ICANN fee.
- **Browser login instead of API keys (Namecheap, opt-in)** — set `providers.namecheap: mcp` to reach Namecheap through its official MCP server after a one-time browser sign-in, with no API key or IP allow-listing. MCP mode cannot get price information for the domains you already own (domain list + availability only), so it is an alternative to the default, not a replacement for it. See [Namecheap without API keys](#namecheap-without-api-keys-browser-login).
- **Cloudflare without an API token (browser login)** — the [`@beings-labs/dsh-cloudflare-connector`](https://github.com/beings-labs/dsh-cloudflare-connector) connector completes Cloudflare's OAuth flow for the official Cloudflare API MCP server, so `providers.cloudflare: mcp` needs no API token and no token IP allow-listing. Both Cloudflare transports use the same validated API envelopes for registration facts, availability, search and transfer checks. Registration listing does not include renewal pricing; sync preserves stored prices and reports that limitation. See [Cloudflare without an API token](#cloudflare-without-an-api-token-browser-login).
- **Availability checks** — 1–20 domains per call. Uses Cloudflare's registry-accurate `domain-check` (API token or MCP browser login), Namecheap's `domains.check`, or the Namecheap MCP tool when `provider` is `mcp`, and otherwise asks public **RDAP** with no credentials at all. RDAP is registry-first: the domain's own RDAP service is discovered from the IANA bootstrap, with `rdap.org` kept only as a fallback so a rate-limited redirector cannot break lookups.
- **Domain search** — candidate discovery through the Cloudflare Registrar search API (API token or MCP browser login).
- **Registrar transfers** — API-assisted **Namecheap → Cloudflare** transfers: eligibility and fee checks, explicit confirmation before paid submission, and persistent progress tracking. DNS migration, unlocking and authorization-code retrieval stay manual.
- **Markdown interop** — import a portfolio from a markdown table and export the portfolio back to a grouped-by-registrar document.

Registrar sync, availability, search and transfer checks are read-only. Only `domain_manager_transfer_start` submits a registrar change and can incur a non-refundable transfer charge; it requires explicit confirmation of a checked quote. The plugin never registers new domains, manually renews registrations or changes DNS.

## Install

Install from npm:

```sh
dsh plugin --profile <profile> add @beings-labs/dsh-domain-manager
```

Or straight from GitHub:

```sh
dsh plugin --profile <profile> add github:beings-labs/dsh-domain-manager
```

From a local checkout:

```sh
dsh plugin --profile <profile> add /path/to/dsh-domain-manager
```

Restart the Harness app, then check the layer loaded:

```sh
dsh --profile <profile> --dump-config | grep dsh-domain-manager
```

Remove with `dsh plugin --profile <profile> remove @beings-labs/dsh-domain-manager`.

## Configuration

Everything is optional; the local store and RDAP availability work with no configuration.

```yaml
# profile cordis.patch.yml
- id: dsh-domain-manager
  config:
    dataFile: /absolute/path/domains.json   # default: $DSH_HOME/dsh-domain-manager/domains.json
    dueWithinDays: 90                        # default expiry window
    staleAfterDays: 14                       # warn when syncs are older than this
    currency: USD                            # default currency for prices
    namecheap:
      apiUser: your-api-user
      apiKey: your-api-key
      userName: your-namecheap-username      # defaults to apiUser
      clientIp: 203.0.113.10                 # must be allow-listed in Namecheap
      sandbox: false
    cloudflare:
      apiToken: your-api-token              # optional in MCP mode
      accountId: your-account-id            # optional in MCP mode (discovered from the connection)
    providers:                               # how each registrar is reached; auto is the default
      namecheap: auto                        # default | api | mcp — prefer API credentials, otherwise MCP
      cloudflare: auto                       # default | api | mcp — prefer API credentials, otherwise MCP browser login
```

`providers.namecheap` and `providers.cloudflare` both default to `auto`. Namecheap prefers configured API credentials and otherwise uses a connected MCP server; Cloudflare prefers a configured API token and otherwise uses the connected Cloudflare MCP server. Both Cloudflare transports read the same registration facts and preserve stored prices because listing has no renewal-pricing feed. Namecheap API mode is the only mode that refreshes renewal/promo/ICANN prices; Namecheap MCP mode has no price feed for registered domains (see [Namecheap without API keys](#namecheap-without-api-keys-browser-login)). Selection depends on what is configured or connected; an API request failure does not switch a registrar to MCP.

Environment variables are used when the matching config field is absent:

| Config field | Environment variable |
|---|---|
| `namecheap.apiUser` | `NAMECHEAP_API_USER` |
| `namecheap.apiKey` | `NAMECHEAP_API_KEY` |
| `namecheap.userName` | `NAMECHEAP_USERNAME` |
| `namecheap.clientIp` | `NAMECHEAP_CLIENT_IP` |
| `cloudflare.apiToken` | `CLOUDFLARE_API_TOKEN` |
| `cloudflare.accountId` | `CLOUDFLARE_ACCOUNT_ID` |

`cloudflare.accountId` may be omitted in MCP mode: the connector resolves it from the connection when it sees exactly one account, and the plugin remembers it for later calls and persisted transfer quotes.

### Credential setup

**Cloudflare** — two transports reach the same Registrar API. *API token (preferred in `auto` mode):* create a token at <https://dash.cloudflare.com/profile/api-tokens>. Listing your registered domains needs *Registrar* read permission; the availability/search endpoints are part of the Registrar API beta and need Registrar write permission. *MCP browser login:* install [`@beings-labs/dsh-cloudflare-connector`](https://github.com/beings-labs/dsh-cloudflare-connector) and authorize once; no API token is created (see [Cloudflare without an API token](#cloudflare-without-an-api-token-browser-login)).

Transfers also require Registrar write access and access to the Registrar API beta. Set up a default payment method, default registrant contact and the registration agreement in the Cloudflare dashboard before submission. No Namecheap API credentials are required for transfers; the source domain must already be in the local portfolio.

**Namecheap API (preferred in auto mode, and the only path that refreshes renewal pricing)** — enable API access under *Profile → Tools → Namecheap API Access*, generate an API key, and allow-list the public IP you send as `clientIp`. Namecheap's XML API returns the registered-domain list and availability/premium pricing; for renewal prices it exposes the account's **per-TLD** rates through `namecheap.users.getPricing` (regular rate, currently charged promo price, and the per-year ICANN fee). `domain_manager_sync` uses that feed to keep `renewalPrice`, `promoPrice` and `icannFee` current. The feed is ~3 MB and is cached in-process for 6 hours. If you would rather not create API credentials, auto mode can use the MCP browser-login path below to list domains and check availability, but it cannot read prices for the domains you already own.

### Namecheap without API keys (browser login)

> **Auto mode is the default and prefers configured API credentials; MCP mode cannot get price information for registered domains.** MCP lists domains and checks availability only, so stored renewal, promo and ICANN prices are not refreshed. Configure API credentials to keep them current; set `providers.namecheap: api` to require API access.

Namecheap runs an official MCP server (`https://mcp.namecheap.com/mcp`) secured with OAuth. DSH's MCP client cannot complete an interactive OAuth flow by itself, so the [`dsh-namecheap-mcp`](https://github.com/2000lla/dsh-namecheap-mcp) connector bridges it through `mcp-remote` over stdio:

```sh
dsh plugin --profile <profile> add github:2000lla/dsh-namecheap-mcp
```

Restart the app, then leave `providers.namecheap` at its default `auto` when no API credentials are configured, or set it to `mcp` to force browser login, and call any `domain_manager_*` tool that needs Namecheap. The first call opens a browser, you sign in on namecheap.com (password never touches DSH), and the connector caches the OAuth tokens under `~/.mcp-auth/`. After that the Namecheap tools are available as `mcp__namecheap__domains_list` and `mcp__namecheap__domains_check_availability`.

With the connector installed, `providers.namecheap` behaves like this:

| `providers.namecheap` | Behaviour |
|---|---|
| `auto` (default) | Use API credentials when configured, otherwise the connected MCP server |
| `api` | Require the Namecheap XML API with `apiUser`, `apiKey` and `clientIp`; the only mode that refreshes `renewalPrice`, `promoPrice` and `icannFee` from `namecheap.users.getPricing` |
| `mcp` | Require the connected MCP server; fail with install guidance if it is missing. Lists domains and checks availability, but cannot read prices for registered domains |

Notes:

- MCP mode needs no API key and no IP allow-listing; API mode needs both. Auto mode prefers API access when credentials are configured and otherwise uses the connected MCP server.
- **MCP mode cannot read prices for registered domains.** The Namecheap MCP server exposes no per-domain renewal price and no pricing feed, so a sync in `mcp` mode only lists domains (availability checks can also use the MCP server) and keeps the `renewalPrice`, `promoPrice` and `icannFee` already in the store. Configure API credentials to refresh them from `namecheap.users.getPricing` in auto mode, or select `api` to require API access.
- With the default `auto` mode, incomplete API credentials cause Namecheap to use the connected MCP server. If neither integration is configured, a sync fails with setup guidance. Explicit `api` mode requires complete API credentials and does not use MCP.
- `providers.cloudflare` accepts `auto` (default), `api` and `mcp`; see [Cloudflare without an API token](#cloudflare-without-an-api-token-browser-login) for the MCP browser-login path.

### Cloudflare without an API token (browser login)

Cloudflare runs the official API MCP server at `https://mcp.cloudflare.com/mcp`, including Registrar, with OAuth authorization. The published [`@beings-labs/dsh-cloudflare-connector`](https://www.npmjs.com/package/@beings-labs/dsh-cloudflare-connector) connector performs dynamic client registration + PKCE and provides the shared `ctx.cloudflareConnector` service. Domain-manager supports the `^0.1.1` release line and is tested against the published 0.1.1 package. Credentials are stored in `$DSH_HOME/dsh-cloudflare-connector/auth.json` (default `~/.dsh/dsh-cloudflare-connector/auth.json`, mode `0600`).

```sh
# Install or upgrade the compatible connector in the profile you run.
dsh plugin --profile <profile> add @beings-labs/dsh-cloudflare-connector@^0.1.1
```

Install both plugins in the same profile, then restart DSH. The connector is declared as an optional peer dependency: API-token, Namecheap-only and local-portfolio use do not require it, and installing domain-manager alone does not enable browser OAuth. Use DSH Desktop or a local Web profile with `tools`, `systemPrompt` and `webServer`; browser OAuth requires a loopback origin, not a remotely hosted Web server. This integration uses the beings-labs connector's public shared service, not the community connector's private tool interface.

Connector 0.1.1 requires compatible `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-host-webserver` packages in the `>=0.2.2-rc.1 <0.3.0` range. Keep those host services compatible when upgrading; API-only domain-manager use does not require them all.

Restart the app, ask the agent to run `cloudflare_connector_authorize` with `{"scopes":["registrar-domains.read"]}`, and open the returned URL. Explicit read consent is needed because the server's Registrar metadata can omit the scope challenge. No settings panel is required. The browser callback completes the flow automatically; `cloudflare_connector_finish` accepts the full callback URL as a manual fallback. `cloudflare_connector_status` reports the connection and `cloudflare_connector_test` lists the discovered tools. After that, `providers.cloudflare: auto` (the default) uses the MCP service whenever no API token is configured, and `providers.cloudflare: mcp` requires it.

| `providers.cloudflare` | Behaviour |
|---|---|
| `auto` (default) | Use the API token when configured, otherwise the connected Cloudflare MCP server |
| `api` | Require `cloudflare.apiToken` and `cloudflare.accountId`; never use MCP |
| `mcp` | Require the connected Cloudflare MCP server; fail with install guidance if it is missing |

Domain-manager resolves the optional service with `ctx.get('cloudflareConnector')` at call time and calls its public `request({ method, path, query, body }, { accountId, timeoutMs, sensitiveValues })` method directly. The connector owns the official server's Code Mode `execute` contract, JSON decoding, OAuth, and structured authorization errors; domain-manager does not generate JavaScript, discover tool schemas, or invoke model-facing tools. The adapter preserves the published `code`/`status` error fields and authorization challenges' exact `scopes`/`authorizationUrl`, while redacting declared request secrets. Both transports list domains through [`GET /registrar/registrations`](https://developers.cloudflare.com/api/resources/registrar/subresources/registrations/methods/list/) with cursor pagination, not the retired `/registrar/domains` endpoint. The shared validators preserve expiry and auto-renew facts; transfer eligibility and transfer status retain the same paid-transfer safeguards. Listing does not include renewal fees, currency or premium flags, so sync does not manufacture those facts and preserves stored prices with a warning.

Notes:

- No API token, IP allow-listing or `CLOUDFLARE_API_TOKEN` is needed. Authorize once; the connector refreshes the OAuth token as needed.
- The connector initially requests only `user:read account:read`. Listing can require `registrar-domains.read`; availability/search or transfers can require `registrar-domains.admin`, and the advisory transfer zone check can require `zone.read`. Let the server request the precise additional scopes. On `authorization_required`, call `cloudflare_connector_authorize`, approve consent in the browser, then explicitly retry. A profile dedicated to domains can instead pass `{"scopes":["registrar-domains.read"]}` to the initial authorization helper. Plain API `403` errors without a scope challenge do not automatically start consent; check the endpoint's permissions and availability. Writes are never automatically replayed.
- **`invalid_scope` is not a token failure.** `registrar:read` is unsupported; the official server advertises `registrar-domains.read` and `registrar-domains.admin` in its [OAuth metadata](https://mcp.cloudflare.com/.well-known/oauth-authorization-server). The connector validates scopes against that metadata when advertised. Correct the scope list before authorizing again; reconnecting with the same invalid scope will not help. This error does not establish that Registrar is API-token-only.
- **Registrar `Authentication error (10000)` without a scope challenge:** check `cloudflare_connector_status` for the actual grant and selected account. Identity/account sign-in alone is insufficient. Request `registrar-domains.read` if missing and no consent flow is pending; if it is already granted, check account access and endpoint permissions/availability rather than repeatedly reconnecting.
- **An API-token `401` is a separate credential issue.** `auto` prefers complete API credentials captured at startup and never switches to OAuth after rejection. Fix the configured token (config takes precedence over the environment) and restart DSH, or explicitly select `providers.cloudflare: mcp` to use the installed connector's separate OAuth grant. The connector does not read `CLOUDFLARE_API_TOKEN`; MCP still needs its own Registrar consent. Never paste tokens into chat.
- `cloudflare.accountId` is optional. Without it the plugin discovers the account through `GET /accounts`. If the connection sees more than one account, the plugin refuses to guess and asks you to set `cloudflare.accountId`.
- Each API request is one MCP round trip (one `execute`), so a sync costs one call per page of up to 50 registrations — slower than an API token, but with no credential setup. Availability checks cost one call per 20 domains.
- The connector is a separate optional service dependency; without it `mcp` mode fails with install guidance and `auto` mode reports Cloudflare as not connected. Other portfolio and Namecheap functionality remains available.

## Tools

| Tool | Purpose |
|---|---|
| `domain_manager_list` | List domains; filter by `registrar`, `group`, `autoRenew`, `dueWithinDays` |
| `domain_manager_report` | Yearly cost (plus ICANN fees and an all-in figure), auto-renew on/off split, per-registrar subtotals, expiring soon |
| `domain_manager_add` | Add a domain (name, registrar, expires; optional price, ICANN fee and metadata) |
| `domain_manager_update` | Change expiry, price, ICANN fee, auto-renew, registrar, currency, purpose, group, promo, notes |
| `domain_manager_remove` | Remove a domain from the local portfolio |
| `domain_manager_sync` | Sync from `namecheap`, `cloudflare` or `all`; `dryRun` previews. Namecheap API mode refreshes renewal/promo/ICANN prices. Namecheap MCP and both Cloudflare modes preserve stored prices because listing provides no renewal-pricing feed |
| `domain_manager_check_availability` | Check 1–20 domains; `provider`: `auto`, `mcp` (Namecheap browser login), `cloudflare` (API token or MCP), `namecheap`, `rdap`; fallback warnings are included in the result |
| `domain_manager_search` | Cloudflare domain-search candidates for a keyword (API token or MCP browser login) |
| `domain_manager_transfer_check` | Check a stored Namecheap domain's transfer eligibility/fees; explain blockers in plain language; save a quote (keeping the ID when nothing changed); best-effort warn when the Cloudflare zone is missing or not Active |
| `domain_manager_transfer_start` | Submit a **paid, non-refundable** transfer after explicit user approval (`confirm: true` and the checked `quoteId`); recheck eligibility and pricing |
| `domain_manager_transfer_status` | Refresh a submitted transfer; report the stage (awaiting approval, in progress, action required, blocked, failed, succeeded) with the next action, and update the portfolio only after verified completion |
| `domain_manager_import_markdown` | Import portfolio tables from a markdown file (upsert or replace) |
| `domain_manager_export_markdown` | Render the portfolio to a markdown document (`dryRun` to preview) |

Example prompts:

- "Show my domains that expire in the next 90 days and don't auto-renew."
- "Sync my Cloudflare registrations, then report the yearly cost."
- "Is example.dev available, and what does Cloudflare charge for it?"
- "Export my portfolio to ~/domains.md."
- "Check moving example.com from Namecheap to Cloudflare and show me the fee and prerequisites. Don't submit it yet."

## Moving from Namecheap to Cloudflare

This is a registration transfer, not just a DNS-provider change. Only **Namecheap → Cloudflare** is currently supported. The workflow uses Cloudflare's [transfer eligibility](https://developers.cloudflare.com/api/resources/registrar/methods/transfer_check/), [transfer-in](https://developers.cloudflare.com/api/resources/registrar/subresources/transfer_in/methods/create/) and [transfer status](https://developers.cloudflare.com/api/resources/registrar/subresources/transfer_in_status/methods/get/) APIs.

1. Sync or add the domain to the portfolio with `registrar: Namecheap`.
2. Complete the manual [Cloudflare prerequisites](https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/): resolve transfer locks/holds, back up and migrate **all** DNS records (including email), disable old DNSSEC/DS records and allow propagation **before** changing nameservers. Use Cloudflare's assigned nameservers and wait for an **Active** full-setup zone. Cloudflare Registrar requires Cloudflare authoritative DNS.
3. In Namecheap **Domain List → Manage → Sharing & Transfer**, unlock the domain and request the EPP/authorization code by email. For `.uk` namespaces, omit the code and follow the IPS-tag transfer process (`CLOUDFLARE`). Recent registrations, transfers or registrant-contact changes can trigger a 60-day lock. Premium domains and extensions needing additional registry-specific contact fields may require the Cloudflare dashboard.
4. Call `domain_manager_transfer_check` with `name` and the **raw** `authCode` (not base64). Optional `autoRenew` defaults to the current portfolio setting. The result includes a `quoteId`, transfer fee, annual renewal price, auto-renew choice and eligibility reasons such as `domain_locked`, `dnssec_enabled` or `zone_status_invalid`. Checks only read the registrar; the quote is stored locally. The result explains each eligibility reason in plain language and warns if the target account's Cloudflare zone is missing or still `pending`. This advisory lookup requires Zone read permission; permission, network and malformed-response failures appear as warnings rather than silently implying readiness. Re-running a check while eligibility, prices and auto-renew are unchanged keeps the same `quoteId` (mentioned in `message`) and refreshes the check timestamp, so a previous approval stays valid.
5. **Before submitting, remind the user that the transfer may extend registration by one year and bill for that additional year at Cloudflare as part of the quoted transfer fee, even if auto-renew is off.** Registry rules vary, and zero-fee transfers do not incur that charge. Ready quotes return a `confirmationPrompt` containing this reminder, the domain, fee/currency, annual renewal price and auto-renew setting. **Ask that question and wait for explicit approval**; a request to check or prepare a transfer is not approval. Only then call `domain_manager_transfer_start` with `name`, the same `quoteId`, `confirm: true` and the code again. The plugin rejects missing/false confirmation and rechecks eligibility and both prices; changed results require a new check and confirmation. A successful paid transfer charges the account's default payment method and is **non-refundable**.
6. Approve any registrar emails and call `domain_manager_transfer_status` as needed. Transfers typically take 1–10 days; Namecheap may offer expedited release. `action_required` means finish the returned action before checking again; `blocked` can require the losing registrar or registry to respond. Results use plain-language stage labels (for example `submitted, awaiting approval`) plus billing guidance and numbered next steps. Some transfers auto-release after about five days, but registry rules and holds can change that timing. Billing guidance describes the quoted fee, not an independently verified payment; check the Cloudflare dashboard for charges. Expiry extensions depend on registry rules rather than always adding one year. Failures are surfaced and never automatically retried.

Read failures explain the selected transport and next action: an API-token `401` names the credential to fix and notes that credentials are read only at startup (restart DSH after editing config or `~/.dsh/.env`); error `9109` points at the token's Client IP Address Filtering; and a `403` for `zone.create` points at the required Account-scoped "Zone → Edit" policy. In MCP mode, structured authorization challenges preserve the server's exact scopes and consent URL. Unchallenged `401`/`403` or `Authentication error (10000)` failures direct you to inspect actual grants, account access and endpoint permissions rather than assuming another identity-only sign-in will work. Unsupported scopes must be corrected before authorizing again. Neither transport automatically retries transfers or falls back to the other's credentials.

Pending/uncertain transfers survive restarts. The plugin saves submission intent **before** the API request: on a timeout, HTTP 409 conflict or unknown outcome, check status and the Cloudflare dashboard rather than submitting again. A generic HTTP 404 does not prove that no transfer exists; reconciliation only records a missing workflow when Cloudflare explicitly reports that none was found. After a definitive rejection or confirmed missing workflow, run a new check and obtain explicit approval before retrying. Do not edit the transfer record to bypass these safeguards.

Until Cloudflare reports success **and** returns an active registration, the portfolio keeps Namecheap and its existing facts. Completion refreshes expiry and auto-renew from Cloudflare, adopts the quoted Cloudflare renewal price and clears Namecheap-only promo/ICANN fees, while preserving purpose/group/notes. Normal Cloudflare sync preserves that quoted price; the registration listing does not refresh renewal pricing. Active or uncertain transfers cannot be removed, overwritten by a replace import, or manually assigned another registrar; ordinary sync cannot prematurely move them or revert a completed transfer based on stale Namecheap data. Markdown export is a portfolio view, **not** a transfer-state backup; keep the JSON store to resume transfers.

Authorization codes are only sent to Cloudflare over HTTPS and are **not stored** in the portfolio or returned in results; both raw and encoded codes are redacted from request errors. **The host may retain tool arguments in conversation history/logs**, so handle codes as secrets and avoid sharing them in exported conversations. The plugin does not automate DNS changes, Namecheap unlocking/code requests, contact setup or billing setup.

## Data

The store defaults to `$DSH_HOME/dsh-domain-manager/domains.json` (`~/.dsh` when `DSH_HOME` is unset):

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "domains": [
    {
      "name": "example.com",
      "registrar": "Cloudflare",
      "expires": "2027-03-15",
      "autoRenew": true,
      "renewalPrice": 9.15,
      "currency": "USD",
      "promoPrice": null,
      "icannFee": null,
      "purpose": "marketing site",
      "group": "brand",
      "notes": null,
      "source": "cloudflare",
      "syncedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Store writes and markdown exports are atomic (exclusive temp file + rename). New files have owner-only permissions (`0600`), newly created directories use `0700`, and temporary files are cleaned up on failure. Existing directory permissions are not changed. A corrupt file fails loudly instead of silently starting empty. The repository ships no portfolio data.

Domains involved in a transfer also have an optional validated `transfer` object: source/destination, destination account ID, state, quote ID/prices/currency, auto-renew choice, timestamps, eligibility reasons, advisory zone warnings and action/failure messages. It contains no authorization code or API token. Existing version-1 stores without this field remain compatible.

## Markdown format

Import accepts any table with `Domain` and `Expires` columns, plus optional `Registrar`, `Purpose`, `Group`, `Renewal Price`, `Currency`, `Auto-renew` and `Notes`. Prices may look like `$12.20/year + $0.20 ICANN` with an optional `*(promo: $9.99)*`. An unknown regular price stays unknown even when a promo or fee is present. Escaped pipes and literal asterisks in text cells are preserved. If there is no `Registrar` column, the closest `## ` heading (`## Cloudflare`, `## Namecheap`) is used. Tables without Domain/Expires columns (for example a "Domains to Acquire" list) are skipped.

Export writes one `## <Registrar>` section per registrar, explicit registrar and currency columns, per-domain ICANN fees, totals, an ICANN-fee/all-in line when fees apply, and an auto-renew cost split. Totals do not perform currency conversion; use a consistent currency for comparable portfolio totals.

## Security notes

- The plugin stores no credentials; it only reads them from config or environment variables. Namecheap MCP owns its OAuth tokens in `~/.mcp-auth/`; the Cloudflare connector stores its credentials in `$DSH_HOME/dsh-cloudflare-connector/auth.json` (default `~/.dsh/dsh-cloudflare-connector/auth.json`).
- Credential-shaped query parameters, JSON fields and bearer tokens are redacted in errors. HTTP and registrar errors also redact known API keys/tokens echoed by upstream services; invalid JSON errors do not echo response content.
- HTTP timeouts cover the complete response, including reading the body. MCP calls have a deadline even if a tool ignores its abort signal.
- Malformed registrar/MCP responses and duplicate sync rows fail explicitly instead of becoming successful empty or partial syncs. Namecheap refuses a partial sync if its page limit is reached. Availability responses must cover every requested domain exactly once with a boolean answer; auto checks can fall back to the next provider and report the failure in `warnings`.
- XML DTDs and structurally malformed XML are rejected; XML traversal does not depend on JavaScript recursion depth.
- Registrar access is read-only except the explicitly confirmed, billable `domain_manager_transfer_start` call. Transfers never automatically change DNS or unlock the source domain.
- `domain_manager_check_availability` only performs DNS/RDAP or registrar read calls; it cannot register or buy anything.

## Development

```sh
npm test
```

Tests cover the store, markdown round-trips, XML parsing, both registrar clients (mocked HTTP, no network), RDAP availability, registrar transfer confirmation/pricing/status/restart safety, and the plugin's tool wiring. The `test/stubs` + `--import ./test/register-stubs.js` pair stands in for the host-provided `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` packages; they must stay out of `node_modules` so an installed copy resolves the host's real packages.

Load the checkout without installing it into a profile:

```sh
# edit dev/cordis.patch.yml first: replace /absolute/path/to/dsh-domain-manager with your clone path
dsh --profile <profile> --patch /absolute/path/to/dsh-domain-manager/dev/cordis.patch.yml
```

`dev/probe.patch.yml` additionally loads a startup probe that logs the registered tool schemas and dispatches a real `domain_manager_report` call — used to verify registration in a real host.

Portfolio data never belongs in this repository: the store defaults to `$DSH_HOME/dsh-domain-manager/domains.json`, and the dev scratch file `dev/domains.json` is git-ignored.

## Publishing to npm

The [Publish to npm workflow](.github/workflows/publish.yml) publishes the public package `@beings-labs/dsh-domain-manager`. It accepts stable `vX.Y.Z` tags only, requires the tag to match `package.json`, runs the tests and checks the package contents before publishing the exact validated commit. There is no dependency-install step: the tests use the host-package stubs described above.

### First publication

The existing `v0.1.0` tag predates this workflow, so publishing it requires a manual bootstrap:

1. Ensure your npm account can publish packages under the `beings-labs` scope.
2. Create a short-lived [granular npm access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/) with **Read and write (publish and stage)** access to the `beings-labs` package scope and **Bypass two-factor authentication** enabled for unattended publishing. Organization-management permissions alone do not grant package-publishing access.
3. Add it as the repository's **Actions secret** named `NPM_TOKEN`. Never put the token in source files or release notes.
4. Run **Publish to npm** from the `main` branch with the `tag` input set to `v0.1.0`:

   ```sh
   gh workflow run publish.yml --repo beings-labs/dsh-domain-manager --ref main -f tag=v0.1.0
   ```

The bootstrap publishes the contents of the existing tag, not the current branch. It deliberately omits provenance because a manual run from `main` has a different workflow source commit from the release tag. It has no OIDC permission and receives the npm token only in the publish step.

### Subsequent releases: trusted publishing

After the first publication, configure a [trusted publisher](https://docs.npmjs.com/trusted-publishers/) in the npm package's settings:

| Setting | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `beings-labs` |
| Repository | `dsh-domain-manager` |
| Workflow filename | `publish.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct publishing with `npm publish` |

Remove the `NPM_TOKEN` Actions secret and revoke its npm token after bootstrapping. Future tag-push runs use OIDC, not the bootstrap token, and publish with provenance. Restrict token publishing in the npm package settings once trusted publishing is configured. npm requires a newly configured trusted publisher to complete its first successful publish within two days; configure it close to the next release.

For each subsequent release, update `package.json`, commit and push the version change, then create and push a matching annotated tag:

```sh
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

The tag push triggers publication automatically. Published npm versions and release tags are immutable; do not move `v0.1.0` to include this workflow or try to republish an existing npm version.

## License

MIT © Beings Labs

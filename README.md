# @beings-labs/dsh-domain-manager

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for managing a **domain portfolio**: registrations synced from registrars, expiry dates, auto-renewal flags, yearly renewal costs, and domain availability checks.

No bundled portfolio and no credentials — install it, point it at your registrars if you want syncing, and the data stays in a JSON file on your machine.

## Features

- **Portfolio store** — add, update and remove domains; track registrar, expiry, auto-renewal, renewal price, promo price, purpose, group and notes.
- **Cost reporting** — total yearly renewal cost, the part charged automatically (auto-renew on) versus the part that lapses unless renewed manually (auto-renew off), per-registrar subtotals, promo-adjusted totals, and domains expiring soon.
- **Staleness warnings** — registrar-synced facts age between syncs; reports and markdown exports warn when synced domains have not been refreshed for more than `staleAfterDays` (manual domains without a sync are not counted).
- **Registrar sync** — pull registrations from **Cloudflare Registrar** and **Namecheap** (read-only) into the store, keeping your local purpose/group/notes. **Auto mode is the default for both registrars**: Namecheap prefers configured API credentials, otherwise uses MCP; Cloudflare remains API-only. Namecheap API mode is the only mode that refreshes the account's own renewal pricing: regular rate, current promo and per-year ICANN fee.
- **Browser login instead of API keys (Namecheap, opt-in)** — set `providers.namecheap: mcp` to reach Namecheap through its official MCP server after a one-time browser sign-in, with no API key or IP allow-listing. MCP mode cannot get price information for the domains you already own (domain list + availability only), so it is an alternative to the default, not a replacement for it. See [Namecheap without API keys](#namecheap-without-api-keys-browser-login).
- **Availability checks** — 1–20 domains per call. Uses Cloudflare's registry-accurate `domain-check`, Namecheap's `domains.check`, or the Namecheap MCP tool when `provider` is `mcp`, and otherwise asks public **RDAP** with no credentials at all. RDAP is registry-first: the domain's own RDAP service is discovered from the IANA bootstrap, with `rdap.org` kept only as a fallback so a rate-limited redirector cannot break lookups.
- **Domain search** — candidate discovery through the Cloudflare Registrar search API.
- **Markdown interop** — import a portfolio from a markdown table and export the portfolio back to a grouped-by-registrar document.

The plugin is read-only towards registrars: it never registers, transfers or renews anything.

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
      apiToken: your-api-token
      accountId: your-account-id
    providers:                               # how each registrar is reached; auto is the default
      namecheap: auto                        # default | api | mcp — prefer API credentials, otherwise MCP
      cloudflare: auto                       # default (alias for api) — no registrar MCP transport
```

`providers.namecheap` and `providers.cloudflare` both default to `auto`. Namecheap prefers configured API credentials and otherwise uses a connected MCP server. Cloudflare's `auto` is an alias for `api`. Namecheap API mode is the only mode that refreshes renewal/promo/ICANN prices; MCP mode has no price feed for registered domains (see [Namecheap without API keys](#namecheap-without-api-keys-browser-login)). API selection depends on credentials being configured; an API request failure does not switch Namecheap to MCP.

Environment variables are used when the matching config field is absent:

| Config field | Environment variable |
|---|---|
| `namecheap.apiUser` | `NAMECHEAP_API_USER` |
| `namecheap.apiKey` | `NAMECHEAP_API_KEY` |
| `namecheap.userName` | `NAMECHEAP_USERNAME` |
| `namecheap.clientIp` | `NAMECHEAP_CLIENT_IP` |
| `cloudflare.apiToken` | `CLOUDFLARE_API_TOKEN` |
| `cloudflare.accountId` | `CLOUDFLARE_ACCOUNT_ID` |

### Credential setup

**Cloudflare** — Cloudflare is API-only; the default `auto` mode is an alias for `api`. Create an API token at <https://dash.cloudflare.com/profile/api-tokens>. Listing your registered domains needs *Registrar* read permission; the availability/search endpoints are part of the Registrar API beta and need Registrar write permission. The same endpoints back the Cloudflare MCP servers, so an agent workflow you already use through MCP sees identical data.

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
- `providers.cloudflare` defaults to `auto` and accepts `api`/`auto` (`auto` is an alias for `api`); there is no Cloudflare registrar MCP path, so `mcp` is rejected with a clear error. A browser-login path would require the Cloudflare API MCP server through another connector.

## Tools

| Tool | Purpose |
|---|---|
| `domain_manager_list` | List domains; filter by `registrar`, `group`, `autoRenew`, `dueWithinDays` |
| `domain_manager_report` | Yearly cost (plus ICANN fees and an all-in figure), auto-renew on/off split, per-registrar subtotals, expiring soon |
| `domain_manager_add` | Add a domain (name, registrar, expires; optional price, ICANN fee and metadata) |
| `domain_manager_update` | Change expiry, price, ICANN fee, auto-renew, registrar, currency, purpose, group, promo, notes |
| `domain_manager_remove` | Remove a domain from the local portfolio |
| `domain_manager_sync` | Sync from `namecheap` (auto prefers API credentials, otherwise MCP browser login) / `cloudflare` (API) or `all`; Namecheap API mode also refreshes renewal/promo/ICANN-fee prices, while MCP mode cannot read prices for registered domains; `dryRun` previews |
| `domain_manager_check_availability` | Check 1–20 domains; `provider`: `auto`, `mcp`, `cloudflare`, `namecheap`, `rdap`; fallback warnings are included in the result |
| `domain_manager_search` | Cloudflare domain-search candidates for a keyword |
| `domain_manager_import_markdown` | Import portfolio tables from a markdown file (upsert or replace) |
| `domain_manager_export_markdown` | Render the portfolio to a markdown document (`dryRun` to preview) |

Example prompts:

- "Show my domains that expire in the next 90 days and don't auto-renew."
- "Sync my Cloudflare registrations, then report the yearly cost."
- "Is example.dev available, and what does Cloudflare charge for it?"
- "Export my portfolio to ~/domains.md."

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

## Markdown format

Import accepts any table with `Domain` and `Expires` columns, plus optional `Registrar`, `Purpose`, `Group`, `Renewal Price`, `Currency`, `Auto-renew` and `Notes`. Prices may look like `$12.20/year + $0.20 ICANN` with an optional `*(promo: $9.99)*`. An unknown regular price stays unknown even when a promo or fee is present. Escaped pipes and literal asterisks in text cells are preserved. If there is no `Registrar` column, the closest `## ` heading (`## Cloudflare`, `## Namecheap`) is used. Tables without Domain/Expires columns (for example a "Domains to Acquire" list) are skipped.

Export writes one `## <Registrar>` section per registrar, explicit registrar and currency columns, per-domain ICANN fees, totals, an ICANN-fee/all-in line when fees apply, and an auto-renew cost split. Totals do not perform currency conversion; use a consistent currency for comparable portfolio totals.

## Security notes

- The plugin stores no credentials; it only reads them from config or environment variables. In MCP mode the registrar connector owns the OAuth tokens in `~/.mcp-auth/`.
- Credential-shaped query parameters, JSON fields and bearer tokens are redacted in errors. HTTP and registrar errors also redact known API keys/tokens echoed by upstream services; invalid JSON errors do not echo response content.
- HTTP timeouts cover the complete response, including reading the body. MCP calls have a deadline even if a tool ignores its abort signal.
- Malformed registrar/MCP responses and duplicate sync rows fail explicitly instead of becoming successful empty or partial syncs. Namecheap refuses a partial sync if its page limit is reached. Availability responses must cover every requested domain exactly once with a boolean answer; auto checks can fall back to the next provider and report the failure in `warnings`.
- XML DTDs and structurally malformed XML are rejected; XML traversal does not depend on JavaScript recursion depth.
- Registrar access is read-only.
- `domain_manager_check_availability` only performs DNS/RDAP or registrar read calls; it cannot register or buy anything.

## Development

```sh
npm test
```

Tests cover the store, markdown round-trips, XML parsing, both registrar clients (mocked HTTP, no network), RDAP availability, and the plugin's tool wiring. The `test/stubs` + `--import ./test/register-stubs.js` pair stands in for the host-provided `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` packages; they must stay out of `node_modules` so an installed copy resolves the host's real packages.

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

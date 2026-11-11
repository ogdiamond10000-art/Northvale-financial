# Bank directory integration

Northvale resolves recipient names and searches US banks through an external
bank-directory / account-verification provider. The integration is **off until
both variables are set**, and every surface degrades honestly rather than
inventing a name.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `BANK_DIRECTORY_API_URL` | yes | Base URL or full endpoint of the provider |
| `BANK_DIRECTORY_API_KEY` | yes | Bearer/API key sent with every request |

Set them in **Settings → Environment variables**, then redeploy so the container
picks them up. Values live only in the runtime environment — never in the
repository.

## Endpoints the adapter calls

The adapter derives both endpoints from `BANK_DIRECTORY_API_URL`. A URL that
already points at a resource (`…/banks`, `…/accounts/resolve`) is used as-is for
that operation, so either a base URL or a full endpoint works.

**Bank search** — `GET {base}/banks?query=<term>&country=US&limit=<n>`

Retried once with `?q=<term>` if the provider rejects `query` (400/404/422).

```json
{ "banks": [ { "name": "JPMorgan Chase Bank, N.A.", "routing_number": "021000021", "city": "New York", "state": "NY" } ] }
```

Accepted list keys: `banks`, `results`, `institutions`, `items`, `data`, or a
bare array. Accepted field aliases: `name`/`bank_name`/`institution_name`/
`full_name`/`legal_name`, and `routing_number`/`routingNumber`/`aba`/
`aba_number`/`routing`.

**Recipient resolution** — `POST {base}/accounts/resolve`

```json
{ "routing_number": "021000021", "account_number": "123456789", "country": "US" }
```

Response name is read from `account_name`, `name`, `recipient_name`,
`account_holder_name`, `holder_name`, `owner_name` (or the same fields nested
under `data`). A response with `valid: false`, `is_valid: false` or `found:
false` is treated as unverifiable.

Auth headers sent: `Authorization: Bearer <key>` and `X-Api-Key: <key>`.

> If your provider uses a different path or payload, the only file to change is
> `server/services/directory.js` — the rest of the app consumes its normalised
> `{ id, name, shortName, routingNumber }` and
> `{ status, name, source }` shapes.

## Behaviour

| Situation | Bank search | Recipient lookup |
| --- | --- | --- |
| Not configured | Bundled 54-bank list, `source: "local"` | `status: "unavailable"`, `source: "none"` |
| Provider returns results | Live results, `source: "directory"` | `status: "verified"` with the name |
| Provider returns no match | Falls back to bundled list | `status: "not_found"` |
| Provider error / timeout | Falls back to bundled list | `status: "unavailable"` (HTTP status surfaced, never a fabricated name) |

Searches are cached in memory for 5 minutes (max 250 queries) to protect provider
quota. Requests time out after 6 seconds.

Northvale-to-Northvale transfers never call the provider: they resolve against
the internal ledger, so internal names stay exact and free.

## Verification

`tests/directory.test.js` runs the adapter against a local fake provider over
real HTTP, covering search, normalisation, the bundled-list fallback, verified
names, unverifiable accounts, provider outages, session authorization and the
admin diagnostics endpoint.

```bash
npm test
```

In the app, **Admin console → Overview → Bank directory** shows connection
status, the provider host, cached searches and a **Test connection** button that
performs a live search and reports latency plus a sample of results. Every probe
is written to the audit log.

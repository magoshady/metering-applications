# Metering Applications

n8n automation that lodges solar metering applications with electricity retailers when a
HubSpot deal reaches **Metering forms need to be submitted** (`1879662022`) in the
**Post Sale To Completion** pipeline. The full build spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Layout

| Path | What |
|---|---|
| `docs/SPEC.md` | Build spec (single source of truth) |
| `src/normaliseRetailer.js` | Body of the n8n Code node `Normalise Retailer` (spec §4.1) |
| `config/retailers.json` | Retailer route table / kill switches (spec §4.2), body of the `Retailer Config` Code node |
| `config/contractors.json` | Contractor details keyed by HubSpot `installer` value (spec §6.2) |
| `config/hubspot-properties.json` | Phase 0 deal properties and new `metering_status` options |
| `scripts/phase0-hubspot-properties.js` | Creates the property group and properties (plan by default, `--apply` to write) |
| `scripts/phase0-backfill-retailer.js` | Backfills `metering_retailer` / `metering_route` (report by default, `--apply` to write) |
| `forms/` | Retailer PDF forms and fieldmaps |
| `workflows/` | Exported n8n workflow JSON (`MTR – …`) |
| `TESTING.md` | Log of every test run |

## Running

```sh
npm test                                   # normaliser + config consistency tests
node scripts/phase0-hubspot-properties.js  # print the property plan (no writes)
HUBSPOT_TOKEN=... node scripts/phase0-hubspot-properties.js --apply [--status-options]
HUBSPOT_TOKEN=... node scripts/phase0-backfill-retailer.js [--apply]
```

`HUBSPOT_TOKEN` is a HubSpot private app token with `crm.objects.deals.read/write` and
`crm.schemas.deals.read/write`. Never commit it.

## Form filler (Vercel)

`api/ea-form.js` fills and signs the EnergyAustralia Service Works Request.

Deploy once:
1. In Vercel, **Add New → Project**, import `magoshady/metering-applications`. Framework preset **Other**, no build command, root directory `/`.
2. Add the environment variable `FILLER_API_KEY` (a long random string).
3. Deploy. The endpoint is `https://<project>.vercel.app/api/ea-form`.
4. In n8n, create a **Header Auth** credential: name `x-api-key`, value = the same `FILLER_API_KEY`.

Call: `POST /api/ea-form` with the job JSON (see `test/fixtures/ea-job.json`). Returns `application/pdf`, or HTTP 400 `{ "error": "…" }` when the deal data can't produce a valid form.

Preview locally: `node scripts/ea-sample.js` writes `forms/ea-sample-filled.pdf`.

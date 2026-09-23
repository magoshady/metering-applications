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

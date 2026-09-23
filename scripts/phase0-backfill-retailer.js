#!/usr/bin/env node
// Phase 0: backfill metering_retailer + metering_route on every deal in the
// Post Sale To Completion pipeline (spec §10.1).
//
// Usage:
//   HUBSPOT_TOKEN=... node scripts/phase0-backfill-retailer.js          # print raw -> normalised table, no writes
//   HUBSPOT_TOKEN=... node scripts/phase0-backfill-retailer.js --apply  # write the two properties
//
// Needs the properties from phase0-hubspot-properties.js to exist before --apply.

const path = require('path');
const { normaliseRetailer } = require(path.join(__dirname, '..', 'src', 'normaliseRetailer'));
const retailers = require(path.join(__dirname, '..', 'config', 'retailers.json'));

const API = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_TOKEN;
const APPLY = process.argv.includes('--apply');
const PIPELINE = '978394588';

async function hs(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function fetchDeals() {
  const deals = [];
  let after;
  do {
    const page = await hs('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: PIPELINE }] }],
      properties: ['electricity__retailer', 'metering_retailer', 'sf_electricity_distributor'],
      limit: 100,
      after,
    });
    deals.push(...page.results);
    after = page.paging && page.paging.next && page.paging.next.after;
  } while (after);
  return deals;
}

async function main() {
  if (!TOKEN) { console.error('Set HUBSPOT_TOKEN.'); process.exit(1); }
  const deals = await fetchDeals();

  const updates = [];
  const table = new Map();
  for (const d of deals) {
    const raw = d.properties.electricity__retailer;
    const { key, reason } = normaliseRetailer(raw);
    const route = (retailers[key] && retailers[key].route) || 'phone_manual';
    const row = `${JSON.stringify(raw || '')}\t${key}\t${route}\t${reason || ''}`;
    table.set(row, (table.get(row) || 0) + 1);
    if (d.properties.metering_retailer !== key) {
      updates.push({ id: d.id, properties: { metering_retailer: key, metering_route: route } });
    }
  }

  console.log('count\traw\tmetering_retailer\tmetering_route\treason');
  [...table.entries()].sort((a, b) => b[1] - a[1]).forEach(([row, n]) => console.log(`${n}\t${row}`));
  console.log(`\n${deals.length} deals, ${updates.length} need updating.`);

  if (!APPLY) { console.log('No writes. Re-run with --apply to write.'); return; }
  for (let i = 0; i < updates.length; i += 100) {
    await hs('POST', '/crm/v3/objects/deals/batch/update', { inputs: updates.slice(i, i + 100) });
    console.log(`updated ${Math.min(i + 100, updates.length)}/${updates.length}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });

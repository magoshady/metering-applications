#!/usr/bin/env node
// Phase 0: create the Metering Automation property group and deal properties (spec §3.5),
// and optionally add the new metering_status options (spec §3.4).
//
// Usage:
//   node scripts/phase0-hubspot-properties.js                  # plan only, no writes
//   HUBSPOT_TOKEN=... node scripts/phase0-hubspot-properties.js --apply
//   HUBSPOT_TOKEN=... node scripts/phase0-hubspot-properties.js --apply --status-options
//
// Without a token the plan assumes nothing exists yet. With a token it reads the
// current schema first and only creates what is missing. Safe to re-run.

const path = require('path');
const spec = require(path.join(__dirname, '..', 'config', 'hubspot-properties.json'));

const API = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_TOKEN;
const APPLY = process.argv.includes('--apply');
const STATUS_OPTIONS = process.argv.includes('--status-options');
const OBJ = spec.objectType;

async function hs(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function toPayload(p) {
  const payload = {
    name: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
    groupName: spec.group.name,
    description: p.description || '',
  };
  if (p.options) {
    payload.options = p.options.map(([value, label], i) => ({ value, label, displayOrder: i }));
  }
  return payload;
}

async function main() {
  if (APPLY && !TOKEN) {
    console.error('--apply needs HUBSPOT_TOKEN (private app token with crm.schemas.deals.write).');
    process.exit(1);
  }
  const canRead = Boolean(TOKEN);
  const plan = [];

  const group = canRead ? await hs('GET', `/crm/v3/properties/${OBJ}/groups/${spec.group.name}`) : null;
  if (!group) plan.push({ action: 'create group', url: `/crm/v3/properties/${OBJ}/groups`, body: spec.group });

  for (const p of spec.properties) {
    const existing = canRead ? await hs('GET', `/crm/v3/properties/${OBJ}/${p.name}`) : null;
    if (existing) {
      console.log(`skip  ${p.name} (already exists, group=${existing.groupName})`);
      continue;
    }
    plan.push({ action: `create ${p.name}`, url: `/crm/v3/properties/${OBJ}`, body: toPayload(p) });
  }

  if (STATUS_OPTIONS) {
    if (!canRead) {
      console.log('metering_status options: need HUBSPOT_TOKEN to read existing options first.');
    } else {
      const status = await hs('GET', `/crm/v3/properties/${OBJ}/metering_status`);
      const have = new Set(status.options.map(o => o.value));
      const missing = spec.meteringStatusNewOptions.filter(v => !have.has(v));
      if (missing.length) {
        // PATCH replaces the whole option list, so keep every existing option as is.
        const options = [
          ...status.options,
          ...missing.map((v, i) => ({ value: v, label: v, displayOrder: status.options.length + i })),
        ];
        plan.push({ action: `add metering_status options: ${missing.join(', ')}`,
          method: 'PATCH', url: `/crm/v3/properties/${OBJ}/metering_status`, body: { options } });
      }
    }
  }

  if (!plan.length) { console.log('Nothing to do.'); return; }

  for (const step of plan) {
    console.log(`\n${APPLY ? 'APPLY' : 'PLAN '}  ${step.action}\n  ${step.method || 'POST'} ${step.url}`);
    if (!APPLY) { console.log(JSON.stringify(step.body, null, 2).replace(/^/gm, '  ')); continue; }
    await hs(step.method || 'POST', step.url, step.body);
    console.log('  done');
  }
  if (!APPLY) console.log('\nPlan only. Re-run with --apply to make these changes.');
}

main().catch(err => { console.error(err.message); process.exit(1); });

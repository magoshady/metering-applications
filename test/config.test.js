const test = require('node:test');
const assert = require('node:assert');
const { RETAILER_ALIASES } = require('../src/normaliseRetailer');
const retailers = require('../config/retailers.json');
const props = require('../config/hubspot-properties.json');

const KEYS = [...Object.keys(RETAILER_ALIASES), 'invalid', 'blank'];
const ROUTES = ['email_auto', 'portal_manual', 'phone_manual', 'unknown'];

test('every normaliser key has a retailer config entry', () => {
  for (const k of KEYS) assert.ok(retailers[k], `missing config for ${k}`);
});

test('every normaliser key is an option on metering_retailer', () => {
  const opts = props.properties.find(p => p.name === 'metering_retailer').options.map(o => o[0]);
  assert.deepStrictEqual([...opts].sort(), [...KEYS].sort());
});

test('every configured route is a metering_route option', () => {
  const opts = props.properties.find(p => p.name === 'metering_route').options.map(o => o[0]);
  assert.deepStrictEqual([...opts].sort(), [...ROUTES].sort());
  for (const [k, r] of Object.entries(retailers)) assert.ok(ROUTES.includes(r.route), `${k}: ${r.route}`);
});

test('automatic email retailers: EA, AGL, GloBird, Amber, Red Energy', () => {
  const auto = Object.entries(retailers).filter(([, r]) => r.route === 'email_auto' && r.enabled).map(([k]) => k);
  assert.deepStrictEqual(auto.sort(), ['agl', 'amber', 'energyaustralia', 'globird', 'red_energy']);
});

test('every email retailer has a recipient and every form has a filler endpoint', () => {
  const fs = require('fs');
  for (const [k, r] of Object.entries(retailers)) {
    if (r.route !== 'email_auto') continue;
    assert.ok(r.to && r.to.length, `${k} has no recipient`);
    if (r.form) assert.ok(fs.existsSync(`${__dirname}/../api/${r.form}-form.js`), `${k}: api/${r.form}-form.js missing`);
  }
});

test('every automatic email retailer has an email template', () => {
  const templates = require('../config/email-templates.json');
  for (const [k, r] of Object.entries(retailers)) {
    if (r.route === 'email_auto' && r.enabled) assert.ok(templates[k], `no template for ${k}`);
  }
});

const test = require('node:test');
const assert = require('node:assert');
const { normaliseRetailer } = require('../src/normaliseRetailer');

// Every distinct raw value of electricity__retailer in pipeline 978394588
// as of 2026-09-23 (HubSpot group-by), with the expected canonical key.
const REAL_VALUES = [
  ['', 'blank'],
  [null, 'blank'],
  ['agl', 'agl'],
  ['origin', 'origin'],
  ['energy australia', 'energyaustralia'],
  ['red energy', 'red_energy'],
  ['origin energy', 'origin'],
  ['powershop', 'powershop'],
  ['engie', 'engie'],
  ['alinta energy', 'alinta'],
  ['globird', 'globird'],
  ['tbd', 'invalid'],
  ['tbc', 'invalid'],
  ['amber', 'amber'],
  ['energy locals', 'first_energy'],
  ['momentum energy', 'momentum'],
  ['origin ', 'origin'],
  ['tba', 'invalid'],
  ['unknown', 'invalid'],
  ['discover energy', 'discover'],
  ['nectr', 'nectr'],
  ['redenergy', 'red_energy'],
  ['0', 'invalid'],
  ['41024797705', 'invalid'],
  ['agl energy', 'agl'],
  ['amopol energy', 'ampol'],
  ['ampol energy', 'ampol'],
  ['aus grid', 'invalid'],
  ['blue nrg', 'blue_nrg'],
  ['diamond energy', 'diamond'],
  ["doesn't state on the bill she has sent- i'll request another", 'invalid'],
  ['energy aus', 'energyaustralia'],
  ['energy aust', 'energyaustralia'],
  ['energy australia ', 'energyaustralia'],
  ['enerrgy aus', 'energyaustralia'],
  ['k', 'invalid'],
  ['kogan', 'kogan'],
  ['na', 'invalid'],
  ['neca', 'invalid'],
  ['ovo energy', 'ovo'],
  ['red energy ', 'red_energy'],
];

for (const [raw, expected] of REAL_VALUES) {
  test(`"${raw}" -> ${expected}`, () => {
    assert.strictEqual(normaliseRetailer(raw).key, expected);
  });
}

test('case and punctuation are ignored', () => {
  assert.strictEqual(normaliseRetailer('  EnergyAustralia. ').key, 'energyaustralia');
  assert.strictEqual(normaliseRetailer('AGL').key, 'agl');
  assert.strictEqual(normaliseRetailer('1st Energy').key, 'first_energy');
});

test('an NMI in the retailer field is called out', () => {
  assert.match(normaliseRetailer('41024797705').reason, /NMI/);
});

test('matched values have no reason', () => {
  assert.strictEqual(normaliseRetailer('origin').reason, null);
});

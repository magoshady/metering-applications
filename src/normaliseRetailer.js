// Normalise Retailer
// Maps the free-text HubSpot deal property `electricity__retailer` (double underscore)
// to a canonical `metering_retailer` key (spec §4.1).
//
// This file is self-contained so its body can be pasted into the n8n Code node
// "Normalise Retailer". Keep it dependency-free.

const RETAILER_ALIASES = {
  origin: ['origin', 'origin energy'],
  agl: ['agl', 'agl energy'],
  energyaustralia: [
    'energy australia', 'energyaustralia', 'energy aus', 'energy aust',
    'enerrgy aus', 'ea',
  ],
  red_energy: ['red energy', 'redenergy', 'red'],
  powershop: ['powershop', 'power shop'],
  engie: ['engie', 'engie energy', 'simply energy'],
  alinta: ['alinta', 'alinta energy'],
  globird: ['globird', 'globird energy', 'glo bird'],
  amber: ['amber', 'amber electric', 'amber energy'],
  first_energy: ['1st energy', 'first energy', 'energy locals'],
  momentum: ['momentum', 'momentum energy'],
  discover: ['discover', 'discover energy'],
  nectr: ['nectr'],
  ampol: ['ampol', 'ampol energy', 'amopol energy'],
  blue_nrg: ['blue nrg', 'bluenrg'],
  diamond: ['diamond', 'diamond energy'],
  kogan: ['kogan', 'kogan energy'],
  ovo: ['ovo', 'ovo energy'],
};

// Values that are clearly placeholders or not a retailer at all.
const INVALID_VALUES = new Set([
  'tbd', 'tbc', 'tba', 'unknown', 'na', 'n a', 'none', 'k', '0',
  'aus grid', 'ausgrid', 'endeavour', 'endeavour energy', 'essential',
  'essential energy', 'evoenergy', 'neca',
]);

function clean(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lookup keyed by both the spaced and the space-free form, so "redenergy"
// and "red energy" land on the same key.
const LOOKUP = {};
for (const [key, aliases] of Object.entries(RETAILER_ALIASES)) {
  for (const alias of aliases) {
    const c = clean(alias);
    LOOKUP[c] = key;
    LOOKUP[c.replace(/ /g, '')] = key;
  }
}

/**
 * @param {string|null|undefined} raw value of electricity__retailer
 * @returns {{key: string, reason: string|null, raw: string}}
 *   key: canonical key from spec §4.1, or 'invalid' / 'blank'
 *   reason: why the value is invalid (null when matched)
 */
function normaliseRetailer(raw) {
  const rawStr = raw == null ? '' : String(raw);
  const c = clean(rawStr);

  if (!c) return { key: 'blank', reason: 'Retailer is empty', raw: rawStr };

  if (/^[0-9 ]+$/.test(c)) {
    const digits = c.replace(/ /g, '');
    const reason = digits.length === 10 || digits.length === 11
      ? 'Retailer field holds a number that looks like an NMI'
      : 'Retailer field is numeric';
    return { key: 'invalid', reason, raw: rawStr };
  }

  if (INVALID_VALUES.has(c)) {
    return { key: 'invalid', reason: `Placeholder or non-retailer value "${rawStr.trim()}"`, raw: rawStr };
  }

  const hit = LOOKUP[c] || LOOKUP[c.replace(/ /g, '')];
  if (hit) return { key: hit, reason: null, raw: rawStr };

  return { key: 'invalid', reason: `Unrecognised retailer "${rawStr.trim()}"`, raw: rawStr };
}

if (typeof module !== 'undefined') {
  module.exports = { normaliseRetailer, RETAILER_ALIASES };
}

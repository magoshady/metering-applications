// Build the job object (spec §6.2) for one deal and decide what happens to it.
//
// Pure function over data n8n has already fetched from HubSpot, so it can be
// unit-tested here and pasted into the n8n Code node "Build Job" by
// workflows/build.js. Depends on normaliseRetailer (inlined before it).

/* global normaliseRetailer */

const ALLOWED_DISTRIBUTORS = ['Ausgrid', 'Endeavour', 'Essential'];
const STREET_TYPES = new Set(['ST', 'STREET', 'RD', 'ROAD', 'AVE', 'AV', 'AVENUE', 'PL', 'PLACE', 'CRES', 'CR', 'CRESCENT',
  'DR', 'DRIVE', 'CT', 'COURT', 'CL', 'CLOSE', 'PDE', 'PARADE', 'HWY', 'HIGHWAY', 'LANE', 'LN', 'WAY', 'TCE', 'TERRACE',
  'BLVD', 'BOULEVARD', 'CCT', 'CIRCUIT', 'GR', 'GROVE', 'SQ', 'SQUARE', 'ESP', 'ESPLANADE', 'PKWY', 'PARKWAY', 'CIR',
  'CIRCLE', 'GLN', 'GLEN', 'RISE', 'VIEW', 'WALK', 'ROW', 'LOOP', 'MEWS', 'TRL', 'TRAIL', 'GDNS', 'GARDENS', 'CNR', 'CORNER']);
const PORTAL = { id: '441838848', host: 'app-ap1.hubspot.com' };

const blank = (v) => v == null || String(v).trim() === '';

/**
 * "U6 186 Penshurst St", "6/186 Penshurst Street", "Unit 6, 186 X Rd", "186 X St",
 * and full addresses like "2 Slessor Pl, Heathcote NSW 2233" (suburb/state/postcode dropped).
 */
function parseStreet(address, suburb = '') {
  let parts = String(address || '').split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length > 1 && /^(unit|u|apt|apartment|flat|shop)\s*[\w-]+$/i.test(parts[0])) parts = [`${parts[0]} ${parts[1]}`, ...parts.slice(2)];
  let a = parts[0] || '';
  a = a.replace(/\s+(NSW|VIC|QLD|ACT|SA|WA|TAS|NT)\b.*$/i, '').trim();
  if (suburb) a = a.replace(new RegExp(`\\s+${suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim();
  if (!a) return null;
  let m = a.match(/^(?:(?:unit|u|apt|apartment|flat|shop)\s*([\w-]+)\s+|([\w-]+)\s*\/\s*)?(\d+[a-z]?(?:-\d+[a-z]?)?)\s+(.+)$/i);
  if (!m) return null;
  const unit = m[1] || m[2] || '';
  const streetNumber = m[3];
  const words = m[4].trim().split(' ');
  let streetType = '';
  if (words.length > 1 && STREET_TYPES.has(words[words.length - 1].toUpperCase().replace(/\.$/, ''))) {
    streetType = words.pop().replace(/\.$/, '');
  }
  return { unit, streetNumber, streetName: words.join(' '), streetType };
}

/** "+61 422 144 850" / "61422144850" / "0422144850" → "0422 144 850" */
function auMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('61')) d = `0${d.slice(2)}`;
  if (/^04\d{8}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (/^0\d{9}$/.test(d)) return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  return String(raw || '').trim();
}

/** HubSpot date/datetime → Sydney calendar date YYYY-MM-DD. */
function sydneyDate(value) {
  if (blank(value)) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(t));
}

const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** First attachment of the newest note whose text matches `test`. */
function findNoteAttachment(notes, test) {
  const sorted = [...(notes || [])].sort((a, b) =>
    String(b.properties?.hs_createdate || '').localeCompare(String(a.properties?.hs_createdate || '')));
  for (const n of sorted) {
    const p = n.properties || {};
    const ids = String(p.hs_attachment_ids || '').split(';').filter(Boolean);
    if (ids.length && test(stripHtml(p.hs_note_body))) return { noteId: String(n.id), fileId: ids[0] };
  }
  return null;
}

/** Newest attachment whose file name matches the distributor's rule. */
function findLetterFile(files, distributor, letterRules) {
  const rule = letterRules && letterRules[distributor];
  if (!rule || !rule.fileName) return null;
  const re = new RegExp(rule.fileName, 'i');
  const hits = (files || []).filter((f) => re.test(f.name || ''));
  hits.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return hits[0] || null;
}

/**
 * @param {object} input
 * @param {object} input.deal HubSpot deal { id, properties }
 * @param {object|null} input.contact primary contact { id, properties }
 * @param {object[]} input.notes notes on the deal { id, properties: { hs_note_body, hs_attachment_ids, hs_createdate } }
 * @param {object[]} [input.files] attachments on the deal { fileId, noteId, name, createdAt }
 * @param {object} [input.letterRules] config/network-letters.json
 * @param {object} input.retailers config/retailers.json
 * @param {object} input.hubspotLabels { retailer: {key: label}, route: {key: label} } from config/hubspot-properties.json
 * @returns {{ action: 'duplicate'|'skip'|'hold'|'email'|'manual', dealId: string, reasons: string[],
 *   retailerKey: string, retailer: object, job: object, dealUpdates: object }}
 */
function buildJob({ deal, contact, notes, files = [], retailers, hubspotLabels, letterRules = {} }) {
  const p = deal.properties || {};
  const c = (contact && contact.properties) || {};
  const dealId = String(deal.id);
  const reasons = [];

  const norm = normaliseRetailer(p.electricity__retailer);
  const retailerKey = norm.key;
  const retailer = retailers[retailerKey] || retailers.invalid;

  const street = parseStreet(c.address, c.city);
  const site = {
    lot: '',
    unit: street?.unit || '',
    streetNumber: street?.streetNumber || '',
    streetName: street?.streetName || '',
    streetType: street?.streetType || '',
    suburb: (c.city || '').trim(),
    state: (c.state || 'NSW').trim(),
    postcode: String(c.zip || '').trim(),
  };
  site.fullAddress = [
    [site.unit && `${site.unit}/`, site.streetNumber].filter(Boolean).join(''),
    site.streetName, site.streetType ? `${site.streetType},` : ',',
    site.suburb, site.state, site.postcode,
  ].filter(Boolean).join(' ').replace(' ,', ',');

  const receipt = String(p.ccew_receipt_number || '').trim();
  const ccewNote = receipt ? findNoteAttachment(notes, (t) => /^ccew\b/i.test(t) && t.includes(receipt)) : null;
  const letterNote = findLetterFile(files, p.electricity_distributor, letterRules)
    || findNoteAttachment(notes, (t) => /^network approval\b/i.test(t));
  const installDate = sydneyDate(p.installation_date);
  const kwNum = Number(p.sf_system_size_kw_stc);

  const job = {
    dealId,
    dealName: p.dealname || '',
    dealUrl: `https://${PORTAL.host}/contacts/${PORTAL.id}/record/0-3/${dealId}`,
    retailerKey,
    retailerLabel: retailer.label,
    route: retailer.route,
    nmi: String(p.nmi || '').trim().toUpperCase(),
    distributor: p.electricity_distributor || '',
    networkApproval: {
      reference: String(p.network_approval_reference || p.der_register_number || '').trim(),
      fileId: letterNote?.fileId || '',
    },
    ccew: { receipt, fileId: ccewNote?.fileId || '' },
    install: { type: p.installation_type || '', date: installDate, dateDisplay: ddmmyyyy(installDate) },
    kw: Number.isFinite(kwNum) && kwNum > 0 ? String(Math.round(kwNum * 100) / 100) : '',
    dedicatedControlledLoad: p.dedicated_controlled_load || '',
    phases: p.phases || '',
    existingSmartMeter: p.existing_smart_meter || '',
    site,
    accountHolder: {
      firstName: (c.firstname || '').trim(),
      lastName: (c.lastname || '').trim(),
      fullName: `${(c.firstname || '').trim()} ${(c.lastname || '').trim()}`.trim(),
      email: (c.email || '').trim(),
      mobile: auMobile(c.mobilephone || c.phone),
    },
  };

  const dealUpdates = {
    metering_retailer: hubspotLabels.retailer[retailerKey],
    metering_route: hubspotLabels.route[retailer.route] || hubspotLabels.route.unknown,
  };
  const out = (action) => ({ action, dealId, reasons, retailerKey, retailer, job, dealUpdates });

  // 1. Already handled (any status set) → never touch it again.
  if (!blank(p.metering_status)) {
    reasons.push(`metering_status is already "${p.metering_status}"`);
    return out('duplicate');
  }

  // 2. Skip rule: battery only at a site that already has a smart meter.
  if (p.installation_type === 'Battery Only' && String(p.existing_smart_meter || '').startsWith('Yes')) {
    reasons.push('Battery only with an existing smart meter: no metering needed');
    return out('skip');
  }

  // 3. Retailer must be known.
  if (retailerKey === 'blank' || retailerKey === 'invalid') {
    reasons.push(`Retailer: ${norm.reason} (value "${norm.raw}")`);
    return out('hold');
  }

  // 4. Data every route needs.
  if (!/^[A-Z0-9]{10,11}$/.test(job.nmi)) reasons.push(`NMI "${p.nmi || ''}" is not 10–11 letters/digits`);
  if (!ALLOWED_DISTRIBUTORS.includes(job.distributor)) reasons.push(`Distributor "${job.distributor}" is not Ausgrid, Endeavour or Essential`);
  if (!contact) reasons.push('No contact on the deal');
  if (!job.accountHolder.firstName || !job.accountHolder.lastName) reasons.push('Contact first/last name missing');
  if (!street) reasons.push(`Contact address "${c.address || ''}" can't be split into street number and name`);
  if (!site.suburb || !/^\d{4}$/.test(site.postcode)) reasons.push('Contact suburb or postcode missing');

  if (retailer.route !== 'email_auto' || !retailer.enabled) {
    // Manual routes: whatever is missing goes into the task instead of blocking it.
    return reasons.length ? out('hold') : out('manual');
  }

  // 5. Automatic email: every attachment and form field must be there.
  const needs = new Set(retailer.attachments || []);
  if (p.ccew_status !== 'Lodged') reasons.push(`CCEW status is "${p.ccew_status || ''}", not Lodged`);
  if (needs.has('ccew')) {
    if (!receipt) reasons.push('CCEW Receipt Number is empty');
    else if (!ccewNote) reasons.push(`No note with the CCEW ${receipt} attachment`);
  }
  if (needs.has('network_letter')) {
    if (!job.networkApproval.fileId) {
      const rule = letterRules[job.distributor];
      reasons.push(rule && rule.fileName
        ? `No ${job.distributor} network approval letter attached (file name matching "${rule.fileName}")`
        : `No rule yet for finding the ${job.distributor || 'distributor'} network approval letter; attach it as a note starting "Network approval"`);
    }
    if (!job.networkApproval.reference) reasons.push('Network approval reference (or DER register number) is empty');
  }
  if (retailer.form) {
    if (!['Yes - Add', 'Yes - Remove', 'No'].includes(job.dedicatedControlledLoad)) reasons.push('Dedicated Controlled Load is empty');
    if (!installDate) reasons.push('Installation date is empty');
  }
  if (retailer.form === 'ea' && !job.kw) reasons.push('System Size (kW STC) is empty or 0');
  if (retailer.form === 'agl' || retailer.needsCustomerSignature) {
    if (!job.accountHolder.email) reasons.push('Contact email missing (needed for the signature request)');
    if (!job.accountHolder.mobile) reasons.push('Contact mobile missing');
  }

  return reasons.length ? out('hold') : out('email');
}

if (typeof module !== 'undefined') {
  module.exports = { buildJob, parseStreet, auMobile, sydneyDate, findNoteAttachment, findLetterFile };
}

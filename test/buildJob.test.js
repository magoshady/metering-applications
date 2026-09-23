const test = require('node:test');
const assert = require('node:assert');
global.normaliseRetailer = require('../src/normaliseRetailer').normaliseRetailer;
const { buildJob, parseStreet, auMobile, sydneyDate } = require('../src/mtr/buildJob');
const { composeEmail, composeTask } = require('../src/mtr/compose');
const retailers = require('../config/retailers.json');
const templates = require('../config/email-templates.json');
const props = require('../config/hubspot-properties.json');

const labels = {
  retailer: Object.fromEntries(props.properties.find((p) => p.name === 'metering_retailer').options),
  route: Object.fromEntries(props.properties.find((p) => p.name === 'metering_route').options),
};

// Shaped like a real deal in the pipeline (values changed).
const deal = () => ({ id: 287000000001, properties: {
  dealname: 'Jane Citizen - Penshurst - 8.55kW', electricity__retailer: 'Red energy', existing_smart_meter: 'No',
  ptc_status: 'Received No Issues', der_register_number: '220610-2210468', nmi: '41025793315',
  ccew_receipt_number: '26090067213', installation_date: '2026-09-09T22:00:00Z', electricity_distributor: 'Ausgrid',
  dedicated_controlled_load: 'Yes - Add', installation_type: 'Solar & Battery', phases: 'Single Phase',
  ccew_status: 'Lodged', sf_system_size_kw_stc: '8.549999999999999', metering_status: null } });
const contact = { id: 1, properties: { firstname: 'Jane', lastname: 'Citizen', address: 'U6 186 Penshurst St',
  city: 'Penshurst', zip: '2222', state: 'NSW', mobilephone: '+61 422 144 850', email: 'jane@example.com' } };
const notes = [
  { id: 1, properties: { hs_note_body: 'CCEW 26090031210 attached via n8n', hs_attachment_ids: '111', hs_createdate: '2026-09-10T05:18:51Z' } },
  { id: 2, properties: { hs_note_body: 'CCEW 26090067213 attached via n8n', hs_attachment_ids: '222', hs_createdate: '2026-09-23T03:46:18Z' } },
  { id: 3, properties: { hs_note_body: '<p>Network approval 220610-2210468 attached via n8n</p>', hs_attachment_ids: '333', hs_createdate: '2026-09-20T00:00:00Z' } },
];
const run = (d = deal(), extra = {}) => buildJob({ deal: d, contact, notes, retailers, hubspotLabels: labels, ...extra });

test('parses the address shapes we see', () => {
  assert.deepStrictEqual(parseStreet('U6 186 Penshurst St'), { unit: '6', streetNumber: '186', streetName: 'Penshurst', streetType: 'St' });
  assert.deepStrictEqual(parseStreet('6/186 Penshurst Street'), { unit: '6', streetNumber: '186', streetName: 'Penshurst', streetType: 'Street' });
  assert.deepStrictEqual(parseStreet('12 Kings Cross Road'), { unit: '', streetNumber: '12', streetName: 'Kings Cross', streetType: 'Road' });
  assert.deepStrictEqual(parseStreet('Unit 3, 4a Smith Ave'), { unit: '3', streetNumber: '4a', streetName: 'Smith', streetType: 'Ave' });
  assert.strictEqual(parseStreet('Lot 5 somewhere'), null);
  assert.strictEqual(parseStreet(''), null);
});

test('mobile and dates are normalised to Australian formats', () => {
  assert.strictEqual(auMobile('+61 422 144 850'), '0422 144 850');
  assert.strictEqual(auMobile('0422144850'), '0422 144 850');
  assert.strictEqual(sydneyDate('2026-09-09T22:00:00Z'), '2026-09-10');
  assert.strictEqual(sydneyDate(''), '');
});

test('a complete Red Energy deal goes to email with the right files and reference', () => {
  const r = run();
  assert.strictEqual(r.action, 'email', r.reasons.join('; '));
  assert.strictEqual(r.job.ccew.fileId, '222', 'newest CCEW note matching the receipt');
  assert.strictEqual(r.job.networkApproval.fileId, '333');
  assert.strictEqual(r.job.networkApproval.reference, '220610-2210468', 'falls back to DER register number');
  assert.strictEqual(r.job.kw, '8.55');
  assert.strictEqual(r.job.install.dateDisplay, '10/09/2026');
  assert.strictEqual(r.job.site.fullAddress, '6/186 Penshurst St, Penshurst NSW 2222');
  assert.deepStrictEqual(r.dealUpdates, { metering_retailer: 'Red Energy', metering_route: 'Email' });
});

test('an existing metering status is a duplicate', () => {
  const d = deal(); d.properties.metering_status = 'Metering Application Sent';
  assert.strictEqual(run(d).action, 'duplicate');
});

test('battery only with an existing smart meter is skipped', () => {
  const d = deal(); d.properties.installation_type = 'Battery Only'; d.properties.existing_smart_meter = 'Yes - Non Intellihub Smart Meter';
  assert.strictEqual(run(d).action, 'skip');
});

test('missing network letter holds with a clear reason', () => {
  const r = buildJob({ deal: deal(), contact, notes: notes.slice(0, 2), retailers, hubspotLabels: labels });
  assert.strictEqual(r.action, 'hold');
  assert.match(r.reasons.join(), /network approval letter/);
});

test('blank retailer holds; phone retailer goes manual', () => {
  const d1 = deal(); d1.properties.electricity__retailer = '';
  assert.strictEqual(run(d1).action, 'hold');
  const d2 = deal(); d2.properties.electricity__retailer = 'Alinta Energy';
  assert.strictEqual(run(d2).action, 'manual');
  const d3 = deal(); d3.properties.electricity__retailer = 'Energy Locals';
  assert.strictEqual(run(d3).action, 'manual');
});

test('EA needs kW and controlled load', () => {
  const d = deal(); d.properties.electricity__retailer = 'Energy Australia'; d.properties.sf_system_size_kw_stc = '0'; d.properties.dedicated_controlled_load = '';
  const r = run(d);
  assert.strictEqual(r.action, 'hold');
  assert.match(r.reasons.join(), /kW/);
  assert.match(r.reasons.join(), /Controlled Load/);
});

test('dry-run email goes to the test inbox and says where it would have gone', () => {
  const r = run();
  const e = composeEmail(r.job, r.retailer, templates, { dryRun: true, testInbox: 'test@example.com' });
  assert.strictEqual(e.to, 'test@example.com');
  assert.match(e.subject, /^\[DRY RUN → solarenquiries@redenergy\.com\.au\] Solar installed – NMI 41025793315 – 6\/186 Penshurst St, Penshurst$/);
  assert.match(e.body, /We have installed solar at 6\/186 Penshurst St, Penshurst NSW 2222, NMI 41025793315/);
  assert.match(e.body, /Impressive Team/);
  const live = composeEmail(r.job, r.retailer, templates, { dryRun: false, testInbox: 'x' });
  assert.strictEqual(live.to, 'solarenquiries@redenergy.com.au');
});

test('hold task lists every reason', () => {
  const r = buildJob({ deal: deal(), contact: null, notes: [], retailers, hubspotLabels: labels });
  const t = composeTask('hold', r.job, r.retailer, r.reasons, { dryRun: false });
  assert.match(t.subject, /^Metering blocked/);
  assert.match(t.body, /No contact on the deal/);
});

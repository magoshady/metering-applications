const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { fillAglForm, buildAglJob } = require('../src/fillAglForm');

const fieldmap = require('../forms/agl-fieldmap.json');
const { impressive } = require('../config/contractors.json');
const job = require('./fixtures/ea-job.json');
const template = fs.readFileSync(path.join(__dirname, '../forms/agl.pdf'));
const today = new Date('2026-09-23T00:00:00Z');

test('every AGL box is on a real page and inside it', async () => {
  const doc = await PDFDocument.load(template);
  for (const f of [...fieldmap.text, ...fieldmap.checkbox, fieldmap.signature]) {
    const page = doc.getPages()[f.page];
    assert.ok(page, f.label);
    const { width, height } = page.getSize();
    assert.ok(f.x >= 0 && f.x + (f.w ?? f.size) <= width && f.y >= 0 && f.y + (f.h ?? f.size) <= height, f.label);
  }
});

test('controlled load: Add ticks the box, Remove uses Other with a description', () => {
  const add = buildAglJob(job, fieldmap, impressive, today);
  assert.deepStrictEqual([add.addControlledLoad, add.removeControlledLoad, add.otherWorks], [true, false, '']);
  const rem = buildAglJob({ ...job, dedicatedControlledLoad: 'Yes - Remove' }, fieldmap, impressive, today);
  assert.deepStrictEqual([rem.addControlledLoad, rem.removeControlledLoad, rem.otherWorks], [false, true, 'Remove controlled load']);
  const no = buildAglJob({ ...job, dedicatedControlledLoad: 'No' }, fieldmap, impressive, today);
  assert.deepStrictEqual([no.addControlledLoad, no.removeControlledLoad], [false, false]);
});

test('blank controlled load is refused', () => {
  assert.throws(() => buildAglJob({ ...job, dedicatedControlledLoad: undefined }, fieldmap, impressive, today), /dedicated_controlled_load/);
});

test('Rodrigo is the authorised contact; network approval goes in the PV SEG line', () => {
  const j = buildAglJob(job, fieldmap, impressive, today);
  assert.strictEqual(j.applicant.fullName, 'Rodrigo Candi');
  assert.strictEqual(j.pvSegLine, 'Ausgrid network approval A12345');
  assert.deepStrictEqual(j.today, { day: '23', month: '09', year: '2026' });
});

test('fillAglForm returns the 4-page form', async () => {
  const bytes = await fillAglForm(template, fieldmap, buildAglJob(job, fieldmap, impressive, today), impressive.signatory);
  assert.strictEqual((await PDFDocument.load(bytes)).getPageCount(), 4);
});

test('text too long for its box fails loudly', async () => {
  const long = { ...job, site: { ...job.site, suburb: 'X'.repeat(80) } };
  await assert.rejects(
    fillAglForm(template, fieldmap, buildAglJob(long, fieldmap, impressive, today), impressive.signatory),
    /too long/,
  );
});

test('consent form: filled, then signed with a drawn signature and an audit line', async () => {
  const { fillAglConsent, signAglConsent } = require('../src/fillAglForm');
  const consentMap = require('../forms/agl-consent-fieldmap.json');
  const tpl = fs.readFileSync(path.join(__dirname, '../forms/agl-consent.pdf'));
  const j = buildAglJob(job, fieldmap, impressive, today);
  assert.strictEqual((await PDFDocument.load(await fillAglConsent(tpl, consentMap, j))).getPageCount(), 2);
  // 1x1 transparent PNG stands in for the drawn signature.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const signed = await signAglConsent(tpl, consentMap, j, png, { name: 'Jane Citizen', email: 'jane@example.com', signedAt: '2026-09-24T00:14:00Z', ip: '1.2.3.4', dealId: '1' });
  assert.strictEqual((await PDFDocument.load(signed)).getPageCount(), 2);
});

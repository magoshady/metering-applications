const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { fillEaForm, buildEaJob, wrap } = require('../src/fillEaForm');

const fieldmap = require('../forms/ea-fieldmap.json');
const { impressive } = require('../config/contractors.json');
const job = require('./fixtures/ea-job.json');
const template = fs.readFileSync(path.join(__dirname, '../forms/ea.pdf'));
const today = new Date('2026-09-23T00:00:00Z');

test('every mapped field exists on the EA form with the right type', async () => {
  const form = (await PDFDocument.load(template)).getForm();
  for (const name of Object.keys(fieldmap.text)) assert.ok(form.getTextField(name), name);
  for (const name of Object.keys(fieldmap.checkbox)) assert.ok(form.getCheckBox(name), name);
});

test('buildEaJob maps dedicated_controlled_load to the off-peak ticks', () => {
  const add = buildEaJob(job, fieldmap, impressive, today);
  assert.strictEqual(add.offPeakChange, true);
  assert.strictEqual(add.offPeakSpecify, 'ADD DEDICATED CONTROLLED LOAD');
  const no = buildEaJob({ ...job, dedicatedControlledLoad: 'No' }, fieldmap, impressive, today);
  assert.deepStrictEqual([no.offPeakChange, no.offPeakNoChange, no.offPeakSpecify], [false, true, '']);
});

test('buildEaJob refuses a blank dedicated_controlled_load', () => {
  assert.throws(() => buildEaJob({ ...job, dedicatedControlledLoad: '' }, fieldmap, impressive, today), /dedicated_controlled_load/);
});

test('buildEaJob formats dates as DD/MM/YYYY in Sydney time', () => {
  const j = buildEaJob(job, fieldmap, impressive, new Date('2026-09-22T15:00:00Z')); // 01:00 AEST on the 23rd
  assert.strictEqual(j.todayDisplay, '23/09/2026');
  assert.strictEqual(j.install.dateDisplay, '18/09/2026');
});

test('Impressive is the applicant and Sam Husband the electrician', () => {
  const j = buildEaJob(job, fieldmap, impressive, today);
  assert.strictEqual(`${j.applicant.firstName} ${j.applicant.lastName}`, 'Rodrigo Candi');
  assert.strictEqual(j.contractor.contactName, 'Sam Husband');
  assert.strictEqual(j.contractor.recLicence, '279684C');
});

test('wrap never splits words and respects the line limit', async () => {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const lines = wrap('ONE TWO THREE FOUR FIVE', font, 9, 60, 3);
  assert.ok(lines && lines.length <= 3);
  assert.strictEqual(lines.join(' '), 'ONE TWO THREE FOUR FIVE');
  assert.strictEqual(wrap('A '.repeat(200), font, 9, 60, 3), null);
});

test('fillEaForm produces a flattened 3-page PDF', async () => {
  const bytes = await fillEaForm(template, fieldmap, buildEaJob(job, fieldmap, impressive, today), impressive.signatory);
  const out = await PDFDocument.load(bytes);
  assert.strictEqual(out.getPageCount(), 3);
  assert.strictEqual(out.getForm().getFields().length, 0);
});

test('fillEaForm fails loudly when the description cannot fit', async () => {
  const long = { ...job, networkApproval: { reference: 'X'.repeat(400) } };
  await assert.rejects(
    fillEaForm(template, fieldmap, buildEaJob(long, fieldmap, impressive, today), impressive.signatory),
    /too long/,
  );
});

// POST /api/ea-form
// Body: §6.2 job object (JSON). Header: x-api-key = FILLER_API_KEY.
// Returns the filled, signed, flattened EA Service Works Request as application/pdf.
// 400 with { error } when the job can't be filled (e.g. blank
// dedicated_controlled_load, description too long) so n8n can hold the deal.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fillEaForm, buildEaJob } = require('../src/fillEaForm');
const fieldmap = require('../forms/ea-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'ea.pdf'));

const REQUIRED = ['nmi', 'kw', 'dedicatedControlledLoad', 'distributor', 'networkApproval.reference',
  'ccew.receipt', 'install.date', 'site.streetNumber', 'site.streetName', 'site.suburb', 'site.state',
  'site.postcode', 'accountHolder.firstName', 'accountHolder.lastName'];

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

function authorised(req) {
  const expected = process.env.FILLER_API_KEY || '';
  const given = String(req.headers['x-api-key'] || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });

  const job = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const missing = REQUIRED.filter((p) => get(job, p) == null || String(get(job, p)).trim() === '');
  if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(', ')}` });

  try {
    const pdf = await fillEaForm(template, fieldmap, buildEaJob(job, fieldmap, impressive), impressive.signatory);
    const name = `EA Service Works Request - NMI ${job.nmi}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};

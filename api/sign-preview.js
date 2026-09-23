// GET /api/sign-preview?t=TOKEN → { name, address, pdf (base64 filled consent) }.
// Public, but only works with a valid, unexpired link.
const fs = require('fs');
const path = require('path');
const { readToken } = require('../src/signToken');
const { fillAglConsent, buildAglJob } = require('../src/fillAglForm');
const fieldmap = require('../forms/agl-fieldmap.json');
const consentFieldmap = require('../forms/agl-consent-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'agl-consent.pdf'));

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  let p;
  try { p = readToken(req.query.t); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const pdf = await fillAglConsent(template, consentFieldmap, buildAglJob(p, fieldmap, impressive));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ name: p.accountHolder.fullName || `${p.accountHolder.firstName} ${p.accountHolder.lastName}`, address: p.site.fullAddress, pdf: Buffer.from(pdf).toString('base64') });
};

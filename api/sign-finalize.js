// POST /api/sign-finalize (x-api-key, called by n8n):
// { t, signature, typedName, ip, signedAt } → { dealId, fileName, pdf (base64 signed consent), signerEmail }.
// Re-checks the link so a forged webhook call can't produce a signed form.
const fs = require('fs');
const path = require('path');
const { authorised } = require('../src/formEndpoint');
const { readToken } = require('../src/signToken');
const { signAglConsent, buildAglJob } = require('../src/fillAglForm');
const fieldmap = require('../forms/agl-fieldmap.json');
const consentFieldmap = require('../forms/agl-consent-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'agl-consent.pdf'));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let p;
  try { p = readToken(b.t); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const png = Buffer.from(String(b.signature || '').replace(/^data:image\/png;base64,/, ''), 'base64');
  const pdf = await signAglConsent(template, consentFieldmap, buildAglJob(p, fieldmap, impressive), png, {
    name: b.typedName, email: p.signerEmail, signedAt: b.signedAt || new Date().toISOString(), ip: b.ip, dealId: p.dealId,
  });
  return res.status(200).json({ dealId: p.dealId, signerEmail: p.signerEmail, fileName: `AGL consent form (signed) - ${p.accountHolder.lastName}.pdf`, pdf: Buffer.from(pdf).toString('base64') });
};

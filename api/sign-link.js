// POST /api/sign-link (x-api-key): job JSON → { url, token, expiresAt }.
// n8n calls this, then emails the link to the homeowner.
const { authorised } = require('../src/formEndpoint');
const { createToken, readToken } = require('../src/signToken');

const BASE = 'https://metering-applications.vercel.app/sign';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });
  const job = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const need = [job.dealId, job.accountHolder?.firstName, job.accountHolder?.lastName, job.accountHolder?.email, job.site?.streetNumber, job.dedicatedControlledLoad];
  if (need.some((v) => v == null || String(v).trim() === '')) return res.status(400).json({ error: 'job is missing deal id, homeowner name/email, address or controlled load' });
  const payload = {
    dealId: String(job.dealId), nmi: job.nmi, distributor: job.distributor, dedicatedControlledLoad: job.dedicatedControlledLoad,
    site: job.site, accountHolder: job.accountHolder, signerEmail: job.signerEmail || job.accountHolder.email,
  };
  const token = createToken(payload, job.days || undefined);
  return res.status(200).json({ url: `${BASE}?t=${token}`, token, expiresAt: new Date(readToken(token).exp).toISOString() });
};

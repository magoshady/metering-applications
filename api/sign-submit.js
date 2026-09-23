// POST /api/sign-submit (public, from the signing page):
// { t, signature (PNG data URL), typedName, agree } → forwards to n8n, which
// asks /api/sign-finalize for the signed PDF and sends the AGL application.
const { readToken } = require('../src/signToken');

const N8N_WEBHOOK = 'https://n8n.nuevaenergy.com.au/webhook/mtr-consent-signed';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  let p;
  try { p = readToken(b.t); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!b.agree) return res.status(400).json({ error: 'Please tick the box to agree to sign electronically.' });
  if (!b.typedName || String(b.typedName).trim().length < 2) return res.status(400).json({ error: 'Please type your full name.' });
  if (!/^data:image\/png;base64,/.test(b.signature || '') || b.signature.length < 1500) return res.status(400).json({ error: 'Please draw your signature.' });
  if (b.signature.length > 2e6) return res.status(400).json({ error: 'Signature image too large.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  const r = await fetch(N8N_WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: b.t, dealId: p.dealId, signature: b.signature, typedName: String(b.typedName).trim(), ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300), signedAt: new Date().toISOString() }),
  });
  if (!r.ok) return res.status(502).json({ error: 'We could not record your signature just now. Please try again in a few minutes.' });
  return res.status(200).json({ ok: true });
};

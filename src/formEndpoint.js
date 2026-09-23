// Shared Vercel handler for the form-filling endpoints (api/ea-form.js, api/agl-form.js).
// POST, header x-api-key = FILLER_API_KEY, body = job JSON → application/pdf,
// or 400 { error } when the job can't produce a valid form (n8n holds the deal).

const crypto = require('crypto');

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

function authorised(req) {
  const expected = process.env.FILLER_API_KEY || '';
  const given = String(req.headers['x-api-key'] || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * @param {object} opts
 * @param {string[]} opts.required dotted paths that must be non-blank
 * @param {(job: object) => Promise<Uint8Array>} opts.fill
 * @param {(job: object) => string} opts.fileName
 */
function formEndpoint({ required, fill, fileName }) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });

    let job;
    try {
      job = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'body is not JSON' });
    }
    const missing = required.filter((p) => get(job, p) == null || String(get(job, p)).trim() === '');
    if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(', ')}` });

    try {
      const pdf = await fill(job);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(job)}"`);
      return res.status(200).send(Buffer.from(pdf));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  };
}

module.exports = { formEndpoint };

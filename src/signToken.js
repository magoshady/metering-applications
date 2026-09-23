// Signing links for the homeowner consent page.
//
// The token carries the consent details encrypted (AES-256-GCM), so the link
// can't be read or altered and no database is needed. The key is derived from
// FILLER_API_KEY, which only Vercel and n8n's "EA Filler" credential know.
// Rotating FILLER_API_KEY invalidates every outstanding link.

const crypto = require('crypto');

const DEFAULT_DAYS = 14;

function key() {
  const secret = process.env.FILLER_API_KEY;
  if (!secret) throw new Error('FILLER_API_KEY is not set');
  return crypto.createHash('sha256').update(`mtr-sign:${secret}`).digest();
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * @param {object} payload anything JSON; `exp` (ms epoch) is added
 * @param {number} [days]
 */
function createToken(payload, days = DEFAULT_DAYS, now = Date.now()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: now + days * 864e5 }), 'utf8'), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** @returns {object} payload; throws 'invalid link' / 'link expired' */
function readToken(token, now = Date.now()) {
  let payload;
  try {
    const raw = fromB64url(token);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid link'), { status: 401 });
  }
  if (!payload.exp || payload.exp < now) throw Object.assign(new Error('link expired'), { status: 410 });
  return payload;
}

module.exports = { createToken, readToken };

const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');

process.env.FILLER_API_KEY = 'test-key';
const { createToken, readToken } = require('../src/signToken');
const signLink = require('../api/sign-link');
const signPreview = require('../api/sign-preview');
const signSubmit = require('../api/sign-submit');
const signFinalize = require('../api/sign-finalize');
const fixture = require('./fixtures/ea-job.json');

const job = { ...fixture, accountHolder: { ...fixture.accountHolder, fullName: 'Jane Citizen' }, site: { ...fixture.site, fullAddress: '12 Example St, Miranda NSW 2228' } };
function call(handler, { method = 'POST', key = 'test-key', body, query = {}, headers = {} }) {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, json: b }); },
      send(b) { resolve({ code: this.code, body: b }); } };
    handler({ method, headers: { 'x-api-key': key, ...headers }, body, query, socket: {} }, res);
  });
}

test('tokens round-trip, are opaque, reject tampering and expire', () => {
  const t = createToken({ dealId: '1', secret: 'Jane' });
  assert.ok(!Buffer.from(t, 'base64').toString('utf8').includes('Jane'), 'payload is encrypted');
  assert.strictEqual(readToken(t).dealId, '1');
  const bad = t.slice(0, -3) + (t.endsWith('A') ? 'BBB' : 'AAA');
  assert.throws(() => readToken(bad), /invalid link/);
  const old = createToken({ dealId: '1' }, 1, Date.now() - 2 * 864e5);
  assert.throws(() => readToken(old), /expired/);
});

test('sign-link needs the API key and the homeowner details', async () => {
  assert.strictEqual((await call(signLink, { key: 'nope', body: job })).code, 401);
  assert.strictEqual((await call(signLink, { body: { ...job, accountHolder: { ...job.accountHolder, email: '' } } })).code, 400);
  const r = await call(signLink, { body: { ...job, dealId: '287' } });
  assert.strictEqual(r.code, 200);
  assert.match(r.json.url, /^https:\/\/metering-applications\.vercel\.app\/sign\?t=/);
});

test('preview returns the filled consent for a valid link only', async () => {
  const { json: { token } } = await call(signLink, { body: { ...job, dealId: '287' } });
  const r = await call(signPreview, { method: 'GET', query: { t: token } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.name, 'Jane Citizen');
  assert.strictEqual((await PDFDocument.load(Buffer.from(r.json.pdf, 'base64'))).getPageCount(), 2);
  assert.strictEqual((await call(signPreview, { method: 'GET', query: { t: 'garbage' } })).code, 401);
});

test('submit validates, then forwards to n8n with the IP', async () => {
  const { json: { token } } = await call(signLink, { body: { ...job, dealId: '287' } });
  const sig = 'data:image/png;base64,' + 'A'.repeat(2000);
  assert.match((await call(signSubmit, { body: { t: token, signature: sig, typedName: 'Jane Citizen' } })).json.error, /tick/);
  assert.match((await call(signSubmit, { body: { t: token, signature: 'data:image/png;base64,AA', typedName: 'Jane Citizen', agree: true } })).json.error, /draw/);
  let sent;
  global.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
  const r = await call(signSubmit, { body: { t: token, signature: sig, typedName: 'Jane Citizen', agree: true }, headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(sent.url, 'https://n8n.nuevaenergy.com.au/webhook/mtr-consent-signed');
  assert.strictEqual(sent.body.dealId, '287');
  assert.strictEqual(sent.body.ip, '1.2.3.4');
});

test('finalize stamps the signature and needs the API key and a valid link', async () => {
  const { json: { token } } = await call(signLink, { body: { ...job, dealId: '287' } });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.strictEqual((await call(signFinalize, { key: 'nope', body: { t: token, signature: png } })).code, 401);
  assert.strictEqual((await call(signFinalize, { body: { t: 'forged', signature: png } })).code, 401);
  const r = await call(signFinalize, { body: { t: token, signature: png, typedName: 'Jane Citizen', ip: '1.2.3.4', signedAt: '2026-09-24T00:14:00Z' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.dealId, '287');
  assert.strictEqual((await PDFDocument.load(Buffer.from(r.json.pdf, 'base64'))).getPageCount(), 2);
});

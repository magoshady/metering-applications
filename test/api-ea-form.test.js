const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');

process.env.FILLER_API_KEY = 'test-key';
const handler = require('../api/ea-form');
const job = require('./fixtures/ea-job.json');

function call({ method = 'POST', key = 'test-key', body = job } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, json: b }); },
      send(b) { resolve({ code: this.code, body: b, headers: this.headers }); },
    };
    handler({ method, headers: { 'x-api-key': key }, body }, res);
  });
}

test('rejects a wrong API key', async () => {
  assert.strictEqual((await call({ key: 'nope' })).code, 401);
});

test('rejects GET', async () => {
  assert.strictEqual((await call({ method: 'GET' })).code, 405);
});

test('lists missing fields', async () => {
  const r = await call({ body: { ...job, nmi: '', ccew: {} } });
  assert.strictEqual(r.code, 400);
  assert.match(r.json.error, /nmi/);
  assert.match(r.json.error, /ccew\.receipt/);
});

test('blank dedicated_controlled_load is a 400, not a guess', async () => {
  const r = await call({ body: { ...job, dedicatedControlledLoad: 'Maybe' } });
  assert.strictEqual(r.code, 400);
  assert.match(r.json.error, /dedicated_controlled_load/);
});

test('returns a flattened PDF', async () => {
  const r = await call();
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.headers['content-type'], 'application/pdf');
  const doc = await PDFDocument.load(r.body);
  assert.strictEqual(doc.getPageCount(), 3);
  assert.strictEqual(doc.getForm().getFields().length, 0);
});

// Writes forms/agl-sample-filled.pdf from test/fixtures/ea-job.json (dummy data).
const fs = require('fs');
const path = require('path');
const { fillAglForm, buildAglJob } = require('../src/fillAglForm');

const root = path.join(__dirname, '..');
const fieldmap = require('../forms/agl-fieldmap.json');
const { impressive } = require('../config/contractors.json');
const job = require('../test/fixtures/ea-job.json');

(async () => {
  const bytes = await fillAglForm(
    fs.readFileSync(path.join(root, 'forms/agl.pdf')),
    fieldmap,
    buildAglJob(job, fieldmap, impressive, new Date('2026-09-23T00:00:00Z')),
    impressive.signatory,
  );
  fs.writeFileSync(path.join(root, 'forms/agl-sample-filled.pdf'), bytes);
  console.log('wrote forms/agl-sample-filled.pdf');
})();

const { fillAglConsent } = require('../src/fillAglForm');
(async () => {
  const consent = await fillAglConsent(
    fs.readFileSync(path.join(root, 'forms/agl-consent.pdf')),
    require('../forms/agl-consent-fieldmap.json'),
    buildAglJob(job, fieldmap, impressive, new Date('2026-09-23T00:00:00Z')),
  );
  fs.writeFileSync(path.join(root, 'forms/agl-consent-sample-filled.pdf'), consent);
  console.log('wrote forms/agl-consent-sample-filled.pdf');
})();

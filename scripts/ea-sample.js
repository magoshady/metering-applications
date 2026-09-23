// Writes forms/ea-sample-filled.pdf from test/fixtures/ea-job.json (dummy data).
const fs = require('fs');
const path = require('path');
const { fillEaForm, buildEaJob } = require('../src/fillEaForm');

const root = path.join(__dirname, '..');
const fieldmap = require('../forms/ea-fieldmap.json');
const { impressive } = require('../config/contractors.json');
const job = require('../test/fixtures/ea-job.json');

(async () => {
  const bytes = await fillEaForm(
    fs.readFileSync(path.join(root, 'forms/ea.pdf')),
    fieldmap,
    buildEaJob(job, fieldmap, impressive, new Date('2026-09-23T00:00:00Z')),
    impressive.signatory,
  );
  fs.writeFileSync(path.join(root, 'forms/ea-sample-filled.pdf'), bytes);
  console.log('wrote forms/ea-sample-filled.pdf');
})();

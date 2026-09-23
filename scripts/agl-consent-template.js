// Writes forms/agl-consent-docuseal-template.pdf: the AGL consent form with the
// fixed parts (organiser = Impressive, Electricity, bills by email, model
// standing offer) printed in. Upload it to DocuSeal as the template; the
// per-customer boxes are DocuSeal text fields filled through the API.
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { drawOverlay } = require('../src/overlayForm');

const root = path.join(__dirname, '..');
const map = require('../forms/agl-consent-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const fixed = {
  text: map.text.filter((f) => f.label.startsWith('2.')),
  checkbox: map.checkbox,
};
const job = {
  applicant: { firstName: impressive.signatory.firstName, lastName: impressive.signatory.lastName, mobile: impressive.signatory.mobile },
  contractor: impressive,
};

(async () => {
  const doc = await PDFDocument.load(fs.readFileSync(path.join(root, 'forms/agl-consent.pdf')));
  await drawOverlay(doc, fixed, job);
  fs.writeFileSync(path.join(root, 'forms/agl-consent-docuseal-template.pdf'), await doc.save());
  console.log('wrote forms/agl-consent-docuseal-template.pdf');
})();

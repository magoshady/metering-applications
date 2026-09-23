// POST /api/agl-consent: AGL homeowner consent form (AGL1295), filled but unsigned.
// n8n sends it to DocuSeal for the homeowner's signature (see src/formEndpoint.js).
const fs = require('fs');
const path = require('path');
const { formEndpoint } = require('../src/formEndpoint');
const { fillAglConsent, buildAglJob } = require('../src/fillAglForm');
const fieldmap = require('../forms/agl-fieldmap.json');
const consentFieldmap = require('../forms/agl-consent-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'agl-consent.pdf'));

module.exports = formEndpoint({
  required: ['dedicatedControlledLoad', 'site.streetNumber', 'site.streetName', 'site.suburb', 'site.state',
    'site.postcode', 'accountHolder.firstName', 'accountHolder.lastName', 'accountHolder.mobile', 'accountHolder.email'],
  fill: (job) => fillAglConsent(template, consentFieldmap, buildAglJob(job, fieldmap, impressive)),
  fileName: (job) => `AGL Consent Form - ${job.accountHolder.lastName}.pdf`,
});

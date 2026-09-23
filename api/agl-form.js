// POST /api/agl-form: AGL Application for Electricity (see src/formEndpoint.js).
const fs = require('fs');
const path = require('path');
const { formEndpoint } = require('../src/formEndpoint');
const { fillAglForm, buildAglJob } = require('../src/fillAglForm');
const fieldmap = require('../forms/agl-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'agl.pdf'));

module.exports = formEndpoint({
  required: ['nmi', 'dedicatedControlledLoad', 'distributor', 'networkApproval.reference',
    'site.streetNumber', 'site.streetName', 'site.suburb', 'site.postcode',
    'accountHolder.firstName', 'accountHolder.lastName', 'accountHolder.mobile', 'accountHolder.email'],
  fill: (job) => fillAglForm(template, fieldmap, buildAglJob(job, fieldmap, impressive), impressive.signatory),
  fileName: (job) => `AGL Application for Electricity - NMI ${job.nmi}.pdf`,
});

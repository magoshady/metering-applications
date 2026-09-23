// POST /api/ea-form: EnergyAustralia Service Works Request (see src/formEndpoint.js).
const fs = require('fs');
const path = require('path');
const { formEndpoint } = require('../src/formEndpoint');
const { fillEaForm, buildEaJob } = require('../src/fillEaForm');
const fieldmap = require('../forms/ea-fieldmap.json');
const { impressive } = require('../config/contractors.json');

const template = fs.readFileSync(path.join(__dirname, '..', 'forms', 'ea.pdf'));

module.exports = formEndpoint({
  required: ['nmi', 'kw', 'dedicatedControlledLoad', 'distributor', 'networkApproval.reference',
    'ccew.receipt', 'install.date', 'site.streetNumber', 'site.streetName', 'site.suburb', 'site.state',
    'site.postcode', 'accountHolder.firstName', 'accountHolder.lastName'],
  fill: (job) => fillEaForm(template, fieldmap, buildEaJob(job, fieldmap, impressive), impressive.signatory),
  fileName: (job) => `EA Service Works Request - NMI ${job.nmi}.pdf`,
});

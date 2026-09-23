// Fill AGL "Application for Electricity" (forms/agl.pdf, AGL1629) and the
// homeowner consent form (forms/agl-consent.pdf, AGL1295).
//
// Neither PDF has form fields, so values are drawn at the box positions in
// the fieldmaps (src/overlayForm.js). Impressive lodges as the authorised
// contact person (application section 3b) and Rodrigo signs the application.
// The consent form is signed by the homeowner through DocuSeal.

const { PDFDocument } = require('pdf-lib');
const { drawOverlay, drawSignature, renderTemplate, sydneyToday } = require('./overlayForm');

/**
 * @param {Uint8Array|Buffer} templateBytes forms/agl.pdf
 * @param {object} fieldmap forms/agl-fieldmap.json
 * @param {object} job output of buildAglJob
 * @param {object} signatory contractors.json impressive.signatory
 * @returns {Promise<Uint8Array>}
 */
async function fillAglForm(templateBytes, fieldmap, job, signatory) {
  const doc = await PDFDocument.load(templateBytes);
  await drawOverlay(doc, fieldmap, job);
  drawSignature(doc, fieldmap.signature, signatory.signatureSvgPath);
  return doc.save();
}

/**
 * Consent form, filled but unsigned: the homeowner signs in DocuSeal at
 * consentFieldmap.docuseal.
 */
async function fillAglConsent(templateBytes, consentFieldmap, job) {
  const doc = await PDFDocument.load(templateBytes);
  await drawOverlay(doc, consentFieldmap, job);
  return doc.save();
}

/**
 * Add the AGL-specific keys the fillers need to a §6.2 job object.
 * @param {object} job needs nmi, distributor, networkApproval.reference,
 *   dedicatedControlledLoad ('Yes - Add' | 'Yes - Remove' | 'No'), site, accountHolder
 * @param {object} fieldmap forms/agl-fieldmap.json
 * @param {object} contractor contractors.json impressive
 * @param {Date} [today]
 */
function buildAglJob(job, fieldmap, contractor, today = new Date()) {
  const cl = job.dedicatedControlledLoad;
  if (!['Yes - Add', 'Yes - Remove', 'No'].includes(cl)) {
    throw new Error(`dedicated_controlled_load is "${cl ?? ''}"; expected Yes - Add, Yes - Remove or No`);
  }
  const s = job.site;
  const out = {
    ...job,
    networkApproval: { ...job.networkApproval, text: job.networkApproval?.text || `${job.distributor} network approval ${job.networkApproval?.reference || 'attached'}` },
    contractor,
    applicant: {
      firstName: contractor.signatory.firstName,
      lastName: contractor.signatory.lastName,
      fullName: `${contractor.signatory.firstName} ${contractor.signatory.lastName}`,
      mobile: contractor.signatory.mobile,
    },
    accountHolder: {
      ...job.accountHolder,
      fullName: `${job.accountHolder.firstName} ${job.accountHolder.lastName}`.trim(),
    },
    site: {
      ...s,
      streetLine: [s.streetName, s.streetType].filter(Boolean).join(' '),
      fullStreet: [s.unit && `${s.unit}/`, s.streetNumber, s.streetName, s.streetType].filter(Boolean).join(' ').replace('/ ', '/'),
    },
    addControlledLoad: cl === 'Yes - Add',
    removeControlledLoad: cl === 'Yes - Remove',
    today: sydneyToday(today),
  };
  out.otherWorks = out.removeControlledLoad ? fieldmap.otherWorksTemplate : '';
  out.pvSegLine = renderTemplate(fieldmap.pvSegTemplate, out);
  return out;
}

module.exports = { fillAglForm, fillAglConsent, buildAglJob };

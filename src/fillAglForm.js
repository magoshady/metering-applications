// Fill AGL "Application for Electricity" (forms/agl.pdf, AGL1629) and the
// homeowner consent form (forms/agl-consent.pdf, AGL1295).
//
// Neither PDF has form fields, so values are drawn at the box positions in
// the fieldmaps (src/overlayForm.js). Impressive lodges as the authorised
// contact person (application section 3b) and Rodrigo signs the application.
// The consent form is signed by the homeowner on our signing page (/sign).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
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
 * Consent form, filled but unsigned (the signing page shows this).
 */
async function fillAglConsent(templateBytes, consentFieldmap, job) {
  const doc = await PDFDocument.load(templateBytes);
  await drawOverlay(doc, consentFieldmap, job);
  return doc.save();
}

/**
 * Consent form signed by the homeowner: their drawn signature (PNG), the date
 * and an audit line are stamped onto the filled form.
 * @param {object} audit { name, email, signedAt (Date|ISO), ip, dealId }
 */
async function signAglConsent(templateBytes, consentFieldmap, job, signaturePng, audit) {
  const doc = await PDFDocument.load(templateBytes);
  await drawOverlay(doc, consentFieldmap, job);
  const { signature: sb } = consentFieldmap.homeownerSignature;
  const page = doc.getPages()[sb.page];
  const png = await doc.embedPng(signaturePng);
  const scale = Math.min((sb.w - 6) / png.width, (sb.h + 10) / png.height);
  const w = png.width * scale;
  const h = png.height * scale;
  page.drawImage(png, { x: sb.x + 4, y: sb.y + (sb.h - h) / 2 + 2, width: w, height: h });

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const when = new Date(audit.signedAt);
  const d = sydneyToday(when);
  // The form prints "/ /" in the date box; write day, month and year between them.
  const dp = consentFieldmap.homeownerSignature.dateParts;
  for (const k of ['day', 'month', 'year']) page.drawText(d[k], { x: dp[k], y: dp.y + 5, size: 9, font, color: rgb(0, 0, 0) });
  const t = consentFieldmap.homeownerSignature.acceptTick;
  doc.getPages()[t.page].drawText('X', { x: t.x + 2, y: t.y + 2, size: t.size * 0.95, font: bold, color: rgb(0, 0, 0) });

  const time = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(when);
  const a = consentFieldmap.auditLine;
  const line = `Signed electronically by ${audit.name} (${audit.email}) on ${d.day}/${d.month}/${d.year} ${time} AEST from IP ${audit.ip || 'unknown'}. Ref ${audit.dealId}.`;
  doc.getPages()[a.page].drawText(line, { x: a.x, y: a.y, size: a.size, font, color: rgb(0.25, 0.25, 0.25) });
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

module.exports = { fillAglForm, fillAglConsent, signAglConsent, buildAglJob };

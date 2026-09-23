// Fill AGL "Application for Electricity" (forms/agl.pdf) from a job object
// using forms/agl-fieldmap.json.
//
// The AGL form has no form fields, so values are drawn onto the page at the
// box positions in the fieldmap. Impressive lodges as the authorised contact
// person (section 3b) and Rodrigo signs, as for EnergyAustralia.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const MAX_FONT = 9;
const MIN_FONT = 5;
const PAD = 3;

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function resolve(job, expr) {
  if (expr.startsWith('=')) return JSON.parse(expr.slice(1));
  return get(job, expr);
}

function renderTemplate(template, job) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => {
    const v = get(job, p);
    return v == null ? '' : String(v);
  });
}

function fitSize(text, font, width, label) {
  let size = MAX_FONT;
  while (size > MIN_FONT && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
  if (font.widthOfTextAtSize(text, size) > width) throw new Error(`Text too long for "${label}": "${text}"`);
  return size;
}

/**
 * @param {Uint8Array|Buffer} templateBytes forms/agl.pdf
 * @param {object} fieldmap forms/agl-fieldmap.json
 * @param {object} job output of buildAglJob
 * @param {object} signatory contractors.json impressive.signatory
 * @returns {Promise<Uint8Array>}
 */
async function fillAglForm(templateBytes, fieldmap, job, signatory) {
  const doc = await PDFDocument.load(templateBytes);
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);

  for (const f of fieldmap.text) {
    const raw = resolve(job, f.value);
    if (raw == null || String(raw).trim() === '') continue;
    const text = f.keepCase ? String(raw) : String(raw).toUpperCase();
    const size = fitSize(text, font, f.w - 2 * PAD, f.label);
    pages[f.page].drawText(text, {
      x: f.x + PAD,
      y: f.y + (f.h - size * 0.7) / 2,
      size, font, color: ink,
    });
  }

  for (const c of fieldmap.checkbox) {
    if (!resolve(job, c.value)) continue;
    const size = c.size * 0.95;
    const w = bold.widthOfTextAtSize('X', size);
    pages[c.page].drawText('X', {
      x: c.x + (c.size - w) / 2,
      y: c.y + (c.size - size * 0.72) / 2,
      size, font: bold, color: ink,
    });
  }

  const s = fieldmap.signature;
  pages[s.page].drawSvgPath(signatory.signatureSvgPath, {
    x: s.x + 8,
    y: s.y + s.h - 1,
    scale: 0.7,
    borderColor: rgb(0.05, 0.1, 0.45),
    borderWidth: 1.3,
  });

  return doc.save();
}

/**
 * Add the AGL-specific keys fillAglForm needs to a §6.2 job object.
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
  const [year, month, day] = new Date(today.getTime() + 10 * 3600e3).toISOString().slice(0, 10).split('-');
  const s = job.site;
  const out = {
    ...job,
    contractor,
    applicant: {
      fullName: `${contractor.signatory.firstName} ${contractor.signatory.lastName}`,
      mobile: contractor.signatory.mobile,
    },
    accountHolder: {
      ...job.accountHolder,
      fullName: `${job.accountHolder.firstName} ${job.accountHolder.lastName}`.trim(),
    },
    site: { ...s, streetLine: [s.streetName, s.streetType].filter(Boolean).join(' ') },
    addControlledLoad: cl === 'Yes - Add',
    removeControlledLoad: cl === 'Yes - Remove',
    today: { day, month, year },
  };
  out.otherWorks = out.removeControlledLoad ? fieldmap.otherWorksTemplate : '';
  out.pvSegLine = renderTemplate(fieldmap.pvSegTemplate, out);
  return out;
}

module.exports = { fillAglForm, buildAglJob };

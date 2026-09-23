// Fill EnergyAustralia "Service Works request for electricity" (forms/ea.pdf)
// from a job object (spec §6.2) using forms/ea-fieldmap.json.
//
// Impressive is the applicant and signs: the signatory's vector scribble is
// drawn into the signature box and today's date is filled. The form is
// flattened so every viewer shows the values and the PDF can't be edited.
//
// Pure function: bytes in, bytes out. Runs anywhere pdf-lib runs (Vercel
// function, n8n Code node with pdf-lib allowed, local scripts).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const MAX_FONT = 9;
const MIN_FONT = 6;
const PAD = 4; // horizontal padding inside a text box, in points
const DESCRIPTION_FIELDS = ['Text35', 'Text36', 'Text37'];
const LOWERCASE_FIELDS = new Set(['Text62', 'Text75']); // email addresses

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

// Greedy word wrap into at most `lines` lines that each fit `width` at `size`.
// Returns null if the text doesn't fit.
function wrap(text, font, size, width, lines) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
    if (!cur || font.widthOfTextAtSize(w, size) > width) return null;
    out.push(cur);
    cur = w;
    if (out.length === lines) return null;
  }
  if (cur) out.push(cur);
  return out.length <= lines ? out : null;
}

// Find the largest font size (MAX_FONT..MIN_FONT) at which the text wraps
// into `lines` lines. Throws if it can't fit even at MIN_FONT.
function fitDescription(text, font, width, lines) {
  for (let size = MAX_FONT; size >= MIN_FONT; size -= 0.5) {
    const wrapped = wrap(text, font, size, width, lines);
    if (wrapped) return { size, lines: wrapped };
  }
  throw new Error(`Description of works too long for ${lines} lines: "${text}"`);
}

function fitSize(text, font, width) {
  let size = MAX_FONT;
  while (size > MIN_FONT && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
  if (font.widthOfTextAtSize(text, size) > width) {
    throw new Error(`Text too long for its box: "${text}"`);
  }
  return size;
}

function fieldWidth(field) {
  return field.acroField.getWidgets()[0].getRectangle().width - PAD;
}

/**
 * @param {Uint8Array|Buffer} templateBytes forms/ea.pdf
 * @param {object} fieldmap forms/ea-fieldmap.json
 * @param {object} job job object; see buildEaJob for the extra keys it needs
 * @param {object} signatory contractors.json impressive.signatory
 * @returns {Promise<Uint8Array>} filled, signed, flattened PDF
 */
async function fillEaForm(templateBytes, fieldmap, job, signatory) {
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const values = {};
  for (const [name, { value }] of Object.entries(fieldmap.text)) {
    if (DESCRIPTION_FIELDS.includes(name)) continue;
    const v = resolve(job, value);
    const s = v == null ? '' : String(v);
    values[name] = LOWERCASE_FIELDS.has(name) ? s : s.toUpperCase();
  }

  const description = renderTemplate(fieldmap.descriptionTemplate, job).toUpperCase();
  const descWidth = fieldWidth(form.getTextField(DESCRIPTION_FIELDS[0]));
  const desc = fitDescription(description, font, descWidth, DESCRIPTION_FIELDS.length);
  DESCRIPTION_FIELDS.forEach((name, i) => {
    const t = form.getTextField(name);
    t.setFontSize(desc.size);
    t.setText(desc.lines[i] || '');
  });

  for (const [name, text] of Object.entries(values)) {
    const t = form.getTextField(name);
    t.setFontSize(text ? fitSize(text, font, fieldWidth(t)) : MAX_FONT);
    t.setText(text);
  }

  for (const [name, { value }] of Object.entries(fieldmap.checkbox)) {
    const c = form.getCheckBox(name);
    if (resolve(job, value)) c.check(); else c.uncheck();
  }

  form.updateFieldAppearances(font);
  form.flatten();

  const { page, rect_pt: r } = fieldmap.signature;
  // drawSvgPath's origin is the top-left of the path; SVG y grows downwards.
  doc.getPages()[page].drawSvgPath(signatory.signatureSvgPath, {
    x: r.x + 11,
    y: r.y + r.h - 2,
    borderColor: rgb(0.05, 0.1, 0.45),
    borderWidth: 1.3,
  });

  return doc.save();
}

const ddmmyyyy = (d) => {
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
};

/**
 * Add the EA-specific keys fillEaForm needs to a §6.2 job object.
 * @param {object} job §6.2 job object; also needs kw, accountHolder.fullName
 *   is derived, dedicatedControlledLoad ('Yes - Add' | 'Yes - Remove' | 'No')
 * @param {object} fieldmap forms/ea-fieldmap.json
 * @param {object} contractor contractors.json impressive
 * @param {Date} [today]
 */
function buildEaJob(job, fieldmap, contractor, today = new Date()) {
  const offPeak = fieldmap.offPeak[job.dedicatedControlledLoad];
  if (!offPeak || typeof offPeak !== 'object') {
    throw new Error(`dedicated_controlled_load is "${job.dedicatedControlledLoad ?? ''}"; expected Yes - Add, Yes - Remove or No`);
  }
  const todayIso = new Date(today.getTime() + 10 * 3600e3).toISOString(); // AEST date
  return {
    ...job,
    ...offPeak,
    contractor,
    applicant: {
      firstName: contractor.signatory.firstName,
      lastName: contractor.signatory.lastName,
      mobile: contractor.signatory.mobile,
    },
    accountHolder: {
      ...job.accountHolder,
      fullName: `${job.accountHolder.firstName} ${job.accountHolder.lastName}`.trim(),
    },
    install: { ...job.install, dateDisplay: ddmmyyyy(job.install.date) },
    todayDisplay: ddmmyyyy(todayIso),
  };
}

module.exports = { fillEaForm, buildEaJob, wrap, renderTemplate };

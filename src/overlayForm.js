// Draw values onto a non-fillable PDF at box positions from a fieldmap
// (used for the AGL forms). Boxes are PDF points, origin bottom-left,
// page index 0-based.

const { StandardFonts, rgb } = require('pdf-lib');

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

/** Draw fieldmap.text and fieldmap.checkbox entries onto doc. */
async function drawOverlay(doc, fieldmap, job) {
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);

  for (const f of fieldmap.text) {
    const raw = resolve(job, f.value);
    if (raw == null || String(raw).trim() === '') continue;
    const text = f.keepCase ? String(raw) : String(raw).toUpperCase();
    const size = fitSize(text, font, f.w - 2 * PAD, f.label);
    pages[f.page].drawText(text, { x: f.x + PAD, y: f.y + (f.h - size * 0.7) / 2, size, font, color: ink });
  }

  for (const c of fieldmap.checkbox) {
    if (!resolve(job, c.value)) continue;
    const size = c.size * 0.95;
    const w = bold.widthOfTextAtSize('X', size);
    pages[c.page].drawText('X', { x: c.x + (c.size - w) / 2, y: c.y + (c.size - size * 0.72) / 2, size, font: bold, color: ink });
  }
}

function drawSignature(doc, box, svgPath, scale = 0.7) {
  doc.getPages()[box.page].drawSvgPath(svgPath, {
    x: box.x + 8,
    y: box.y + box.h - 1,
    scale,
    borderColor: rgb(0.05, 0.1, 0.45),
    borderWidth: 1.3,
  });
}

/** Sydney-time today as { day, month, year } strings. */
function sydneyToday(today = new Date()) {
  const [year, month, day] = new Date(today.getTime() + 10 * 3600e3).toISOString().slice(0, 10).split('-');
  return { day, month, year };
}

/**
 * DocuSeal field area for a box: fractions of the page, origin top-left.
 * @param {{page:number,x:number,y:number,w:number,h:number}} box
 */
function docusealArea(box, pageWidth = 595.276, pageHeight = 841.89) {
  const r = (n) => Math.round(n * 10000) / 10000;
  return { page: box.page, x: r(box.x / pageWidth), y: r((pageHeight - box.y - box.h) / pageHeight), w: r(box.w / pageWidth), h: r(box.h / pageHeight) };
}

module.exports = { drawOverlay, drawSignature, renderTemplate, sydneyToday, docusealArea };

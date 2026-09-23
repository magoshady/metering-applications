// Compose the retailer email and the HubSpot task text for a job.
// Pure functions, inlined into n8n Code nodes by workflows/build.js.

const ATTACHMENT_NAMES = {
  ea_form: 'EnergyAustralia Service Works Request (signed)',
  agl_form: 'AGL Application for Electricity (signed)',
  agl_consent_signed: 'AGL consent form (signed by the homeowner)',
  ccew: 'CCEW',
  network_letter: 'Network approval letter',
};

function fill(template, data) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    return v == null ? '' : String(v);
  });
}

/**
 * @param {object} job from buildJob
 * @param {object} retailer config/retailers.json entry
 * @param {object} templates config/email-templates.json
 * @param {object} settings { dryRun, testInbox }
 * @returns {{ to: string, cc: string, subject: string, body: string, realTo: string }}
 */
function composeEmail(job, retailer, templates, settings) {
  const data = {
    ...job,
    street: [job.site.unit && `${job.site.unit}/`, job.site.streetNumber, ' ', job.site.streetName, job.site.streetType && ` ${job.site.streetType}`]
      .join('').replace('/ ', '/').trim(),
    suburb: job.site.suburb,
    attachmentList: (retailer.attachments || []).map((a) => `- ${ATTACHMENT_NAMES[a] || a}`).join('\n'),
  };
  const realTo = (retailer.to || []).join(',');
  let subject = fill(retailer.subjectTemplate, data);
  let body = `${fill(templates[job.retailerKey], data)}\n\n${templates.signature}`;
  let to = realTo;
  let cc = (retailer.cc || []).join(',');
  if (settings.dryRun) {
    subject = `[DRY RUN → ${realTo}] ${subject}`;
    body = `DRY RUN: in live mode this goes to ${realTo}${cc ? ` (cc ${cc})` : ''}.\n\n${body}`;
    to = settings.testInbox;
    cc = '';
  }
  return { to, cc, subject, body, realTo };
}

/**
 * HubSpot task for a manual route or a hold.
 * @param {'manual'|'hold'} kind
 */
function composeTask(kind, job, retailer, reasons, settings) {
  const lines = [];
  if (kind === 'hold') {
    lines.push('The metering automation stopped for this deal. Fix the items below, then clear Metering Status and re-send the trigger email:');
    for (const r of reasons) lines.push(`• ${r}`);
    lines.push('');
  } else {
    const how = retailer.route === 'portal_manual' ? `Portal / web form: ${retailer.portalUrl}` : `Phone: ${retailer.phone || 'unknown: look up'}`;
    lines.push(`Lodge the solar meter request with ${retailer.label} manually. ${how}`);
    if (reasons.length) { lines.push('Also note:'); for (const r of reasons) lines.push(`• ${r}`); }
    lines.push('');
  }
  lines.push(
    `Customer: ${job.accountHolder.fullName}  |  ${job.accountHolder.mobile}  |  ${job.accountHolder.email}`,
    `Site: ${job.site.fullAddress}`,
    `NMI: ${job.nmi}`,
    `Retailer: ${job.retailerLabel}`,
    `Distributor: ${job.distributor}  |  approval ref: ${job.networkApproval.reference || '— (letter attached)'}`,
    `Installed: ${job.install.dateDisplay || '—'} (${job.install.type || '—'}, ${job.kw || '—'} kW)`,
    `CCEW: ${job.ccew.receipt || '—'}  |  Controlled load: ${job.dedicatedControlledLoad || '—'}  |  Phases: ${job.phases || '—'}`,
    `Deal: ${job.dealUrl}`,
    '',
    kind === 'manual' ? 'When lodged: set Metering Status to "Metering Application Sent" and the Metering Application Date.' : '',
  );
  const subject = kind === 'hold'
    ? `Metering blocked – ${job.dealName || job.dealId}`
    : `Lodge metering – ${retailer.label} – NMI ${job.nmi}`;
  return { subject: settings.dryRun ? `[DRY RUN] ${subject}` : subject, body: lines.join('\n').trim() };
}

if (typeof module !== 'undefined') module.exports = { composeEmail, composeTask, ATTACHMENT_NAMES };

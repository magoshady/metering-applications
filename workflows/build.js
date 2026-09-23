// Builds every MTR workflow as n8n public-API JSON.
// Usage: node workflows/build.js  → writes workflows/json/*.json
//        (workflows/deploy.js creates/updates them in n8n)
//
// Workflow ids are needed for Execute Workflow nodes, so they come from
// workflows/ids.json (filled in by deploy.js as workflows are created).

const fs = require('fs');
const path = require('path');
const { workflow, code, hubspot, execWf, src, json, hubspotLabels, CRED } = require('./lib');

const IDS_FILE = path.join(__dirname, 'ids.json');
const ids = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')) : {};
const id = (k) => ids[k] || `__${k}__`;

const HS = 'https://api.hubapi.com';
const DEAL_PROPS = ['dealname', 'nmi', 'electricity__retailer', 'electricity_distributor', 'phases', 'existing_smart_meter',
  'installation_type', 'installation_date', 'ptc_status', 'ccew_status', 'ccew_receipt_number', 'der_register_number',
  'metering_status', 'metering_application_date', 'metering_automation_log', 'network_approval_reference',
  'network_approval_letter_url', 'sf_system_size_kw_stc', 'dedicated_controlled_load', 'dealstage', 'hubspot_owner_id'];

// Shared snippet: append a line to metering_automation_log (keeps the last 30 lines).
const LOG_FN = `
function appendLog(old, line) {
  const stamp = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const lines = String(old || '').split('\\n').filter(Boolean);
  lines.push(stamp + ' ' + line);
  return lines.slice(-30).join('\\n');
}`;

const W = {};

// ───────────────────────── MTR – 00 Settings ─────────────────────────
W.settings = workflow('MTR – 00 Settings', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const s = w.node('Settings', 'n8n-nodes-base.code', 2, code(`// ── EDIT HERE ──────────────────────────────────────────────
const settings = {
  // true: every retailer email and DocuSeal request goes to testInbox, HubSpot
  // tasks are emailed to testInbox instead, and the only HubSpot write is a
  // "[DRY RUN]" line in Metering Automation Log.
  dryRun: true,
  testInbox: 'rodrigo@impressivebatteries.com.au',
  fillerUrl: 'https://metering-applications.vercel.app',
  docusealApi: 'https://docuseal.impressivebatteries.com.au/api',
  alertTo: 'rodrigo@impressivebatteries.com.au',
  taskOwnerId: '360340383',            // Rodrigo Candi
  stageAfterSend: '1509971393',        // Install Complete and metering forms submitted…
  labels: { processed: 'Metering 2.0 - Processed', error: 'Metering 2.0 - Error' },
};
// ───────────────────────────────────────────────────────────
if (settings.dryRun && !settings.testInbox) throw new Error('Set testInbox in MTR – 00 Settings before running in dry run');
return [{ json: settings }];`));
  const l = w.node('Gmail Labels', 'n8n-nodes-base.gmail', 2.1, { resource: 'label', operation: 'getAll', returnAll: true }, { credentials: CRED.gmail });
  const m = w.node('Attach Label IDs', 'n8n-nodes-base.code', 2, code(`const s = $('Settings').first().json;
const byName = Object.fromEntries($input.all().map((i) => [i.json.name, i.json.id]));
const labelIds = {};
for (const [k, name] of Object.entries(s.labels)) {
  if (!byName[name]) throw new Error('Gmail label "' + name + '" not found in the mailbox');
  labelIds[k] = byName[name];
}
return [{ json: { ...s, labelIds } }];`));
  w.chain(t, s, l, m);
});

// ───────────────────────── MTR – 03 Build Job ─────────────────────────
// In: { dealId }  Out: buildJob result + { deal }
W.buildJob = workflow('MTR – 03 Build Job', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const d = w.node('Get Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('GET', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId + '?associations=contacts&properties=${DEAL_PROPS.join(',')}' }}`),
    { credentials: CRED.hubspot });
  const c = w.node('Get Contact', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('GET', `={{ '${HS}/crm/v3/objects/contacts/' + ($json.associations?.contacts?.results?.[0]?.id || 'none') + '?properties=firstname,lastname,email,phone,mobilephone,address,city,zip,state' }}`),
    { credentials: CRED.hubspot, onError: 'continueRegularOutput' });
  const n = w.node('Get Notes', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes/search`,
      `={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'associations.deal', operator: 'EQ', value: String($('Get Deal').first().json.id) }] }], properties: ['hs_note_body', 'hs_attachment_ids', 'hs_createdate'], sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }], limit: 100 }) }}`),
    { credentials: CRED.hubspot });
  const ids = w.node('Attachment IDs', 'n8n-nodes-base.code', 2, code(`const notes = $input.first().json.results || [];
const out = [];
for (const n of notes) for (const f of String(n.properties.hs_attachment_ids || '').split(';').filter(Boolean)) out.push({ json: { fileId: f, noteId: String(n.id) } });
return out.length ? out.slice(0, 60) : [{ json: { fileId: 'none', noteId: '' } }];`));
  const meta = w.node('File Names', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('GET', `={{ '${HS}/files/v3/files/' + $json.fileId }}`),
    { credentials: CRED.hubspot, onError: 'continueRegularOutput' });
  const b = w.node('Build Job', 'n8n-nodes-base.code', 2, code(`${src('src/normaliseRetailer.js')}
${src('src/mtr/buildJob.js')}
const retailers = ${json('config/retailers.json')};
const hubspotLabels = ${hubspotLabels()};
const deal = $('Get Deal').first().json;
const contactRaw = $('Get Contact').first().json;
const contact = contactRaw && contactRaw.id ? contactRaw : null;
const notes = $('Get Notes').first().json.results || [];
const files = $('File Names').all().map((f, i) => ({ ...$('Attachment IDs').itemMatching(i).json, name: f.json.name ? f.json.name + (f.json.extension ? '.' + f.json.extension : '') : '', createdAt: f.json.createdAt || '' })).filter((f) => f.name);
const letterRules = ${json('config/network-letters.json')};
const result = buildJob({ deal, contact, notes, files, retailers, hubspotLabels, letterRules });
result.files = files.map((f) => f.name);
const contacts = deal.associations?.contacts?.results || [];
if (contacts.length > 1) result.reasons.push('Note: deal has ' + contacts.length + ' contacts; used the first');
return [{ json: { ...result, deal: { id: String(deal.id), properties: deal.properties } } }];`));
  w.chain(t, d, c, n, ids, meta, b);
});

// ───────────────────────── MTR – 20 Manual Task ─────────────────────────
// In: { kind: 'manual'|'hold', job, retailer, reasons, deal, settings, dealUpdates }
W.manualTask = workflow('MTR – 20 Manual Task', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const p = w.node('Compose Task', 'n8n-nodes-base.code', 2, code(`${src('src/mtr/compose.js')}
${LOG_FN}
const i = $input.first().json;
const s = i.settings;
const task = composeTask(i.kind, i.job, i.retailer, i.reasons, s);
const status = i.kind === 'hold' ? 'Metering Issues Not Sent On Hold' : 'Awaiting Manual Lodgement';
const logLine = (s.dryRun ? '[DRY RUN] ' : '') + (i.kind === 'hold' ? 'HOLD: ' + i.reasons.join('; ') : 'Manual task: ' + i.retailer.label);
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, logLine) };
if (!s.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: status });
return [{ json: { ...i, task, properties } }];`));
  const iff = w.node('Dry Run?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'dry', leftValue: '={{ $json.settings.dryRun }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  });
  const mail = w.node('Email Task (dry run)', 'n8n-nodes-base.gmail', 2.1, {
    sendTo: '={{ $json.settings.testInbox }}', subject: '={{ $json.task.subject }}', emailType: 'text', message: '={{ $json.task.body }}', options: { appendAttribution: false },
  }, { credentials: CRED.gmail, y: -120 });
  const task = w.node('Create HubSpot Task', 'n8n-nodes-base.httpRequest', 4.2, hubspot('POST', `${HS}/crm/v3/objects/tasks`,
    `={{ JSON.stringify({ properties: { hs_task_subject: $json.task.subject, hs_task_body: $json.task.body, hubspot_owner_id: $json.settings.taskOwnerId, hs_task_status: 'NOT_STARTED', hs_task_priority: $json.kind === 'hold' ? 'HIGH' : 'MEDIUM', hs_task_type: 'TODO', hs_timestamp: new Date(Date.now() + 864e5).toISOString() }, associations: [{ to: { id: $json.job.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }] }) }}`),
  { credentials: CRED.hubspot, y: 120 });
  const upd = w.node('Update Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $('Compose Task').first().json.job.dealId }}`, `={{ JSON.stringify({ properties: $('Compose Task').first().json.properties }) }}`),
    { credentials: CRED.hubspot });
  w.chain(t, p, iff);
  w.connect(iff, mail, 0);
  w.connect(iff, task, 1);
  w.connect(mail, upd);
  w.connect(task, upd);
});

// ───────────────────────── MTR – 10 Send Application ─────────────────────────
// In: { job, retailer, deal, settings, dealUpdates, phase?: 'send', signedConsentUrl? }
W.send = workflow('MTR – 10 Send Application', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const fresh = w.node('Re-read Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('GET', `={{ '${HS}/crm/v3/objects/deals/' + $json.job.dealId + '?properties=metering_application_date,metering_status,metering_automation_log' }}`),
    { credentials: CRED.hubspot });
  const plan = w.node('Plan', 'n8n-nodes-base.code', 2, code(`const i = $('When Called').first().json;
const now = $input.first().json.properties;
if (now.metering_application_date && !i.settings.dryRun) throw new Error('deal ' + i.job.dealId + ': already has a Metering Application Date; not sending again');
const r = i.retailer;
const needsSignature = !!r.needsCustomerSignature && i.phase !== 'send';
const files = [];
if (needsSignature) {
  files.push({ kind: 'filler', form: r.consentForm, name: 'AGL consent form.pdf' });
} else {
  for (const a of r.attachments) {
    if (a === 'ea_form' || a === 'agl_form') files.push({ kind: 'filler', form: r.form + '-form', name: a === 'ea_form' ? 'EA Service Works Request.pdf' : 'AGL Application for Electricity.pdf', upload: true });
    else if (a === 'ccew') files.push({ kind: 'hubspot', fileId: i.job.ccew.fileId, name: 'CCEW ' + i.job.ccew.receipt + '.pdf' });
    else if (a === 'network_letter') files.push({ kind: 'hubspot', fileId: i.job.networkApproval.fileId, name: i.job.distributor + ' network approval.pdf' });
    else if (a === 'agl_consent_signed') files.push({ kind: 'url', url: i.signedConsentUrl, name: 'AGL consent form (signed).pdf', upload: true });
  }
}
return files.map((f, n) => ({ json: { ...f, n, needsSignature, job: i.job, fillerUrl: i.settings.fillerUrl } }));`));
  const sw = w.node('By Source', 'n8n-nodes-base.switch', 3.2, {
    rules: { values: ['filler', 'hubspot', 'url'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json.kind }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
      renameOutput: true, outputKey: k })) },
    options: {},
  });
  const fil = w.node('Fill Form (Vercel)', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.fillerUrl }}/api/{{ $json.form }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.job) }}',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { credentials: CRED.filler, onError: 'continueErrorOutput', y: -160 });
  const sig = w.node('HubSpot Signed URL', 'n8n-nodes-base.httpRequest', 4.2, {
    ...hubspot('GET', `={{ '${HS}/files/v3/files/' + $json.fileId + '/signed-url' }}`),
  }, { credentials: CRED.hubspot, onError: 'continueErrorOutput' });
  const dlh = w.node('Download HubSpot File', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}', options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { onError: 'continueErrorOutput' });
  const dlu = w.node('Download Signed Consent', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}', options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { onError: 'continueErrorOutput', y: 160 });
  const fail = w.node('File Failed', 'n8n-nodes-base.code', 2, code(`const i = $('When Called').first().json;
const e = $input.first().json;
throw new Error('deal ' + i.job.dealId + ': could not get an attachment: ' + (e.error?.message || JSON.stringify(e.error || e).slice(0, 300)));`), { y: 320 });
  const merge = w.node('Collect Files', 'n8n-nodes-base.code', 2, code(`const i = $('When Called').first().json;
const planned = $('Plan').all().map((p) => p.json);
const got = $input.all();
if (got.length !== planned.length) throw new Error('deal ' + i.job.dealId + ': expected ' + planned.length + ' attachments, got ' + got.length);
const binary = {};
const files = [];
got.forEach((item, idx) => {
  const p = $('Plan').itemMatching(idx).json;
  if (!item.binary || !item.binary.data) throw new Error('deal ' + i.job.dealId + ': ' + p.name + ' came back empty');
  const key = 'att' + p.n;
  binary[key] = { ...item.binary.data, fileName: p.name, mimeType: 'application/pdf' };
  files.push({ key, name: p.name, upload: !!p.upload });
});
files.sort((a, b) => a.key.localeCompare(b.key));
return [{ json: { ...i, files, needsSignature: planned[0].needsSignature }, binary }];`), { position: [2160, 0] });
  const route = w.node('Signature First?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'sig', leftValue: '={{ $json.needsSignature }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  }, { position: [2400, 0] });

  // Signature branch (AGL consent → DocuSeal)
  const ds = w.node('Build DocuSeal Request', 'n8n-nodes-base.code', 2, code(`const i = $input.first().json;
const s = i.settings;
const map = ${json('forms/agl-consent-fieldmap.json')}.docuseal;
const W = 595.276, H = 841.89;
const area = (b) => ({ x: +(b.x / W).toFixed(4), y: +((H - b.y - b.h) / H).toFixed(4), w: +(b.w / W).toFixed(4), h: +(b.h / H).toFixed(4), page: b.page + 1 });
const buf = await this.helpers.getBinaryDataBuffer(0, 'att0');
const email = s.dryRun ? s.testInbox : i.job.accountHolder.email;
const body = {
  name: 'AGL consent – ' + i.job.accountHolder.fullName + ' – NMI ' + i.job.nmi,
  send_email: true,
  documents: [{ name: 'AGL consent form', file: buf.toString('base64'), fields: [
    { name: 'Signature', type: 'signature', role: 'Homeowner', required: true, areas: [area(map.signature)] },
    { name: 'Date', type: 'date', role: 'Homeowner', required: true, areas: [area(map.date)] },
  ] }],
  submitters: [{ role: 'Homeowner', email, name: i.job.accountHolder.fullName, external_id: String(i.job.dealId) }],
  message: {
    subject: (s.dryRun ? '[DRY RUN] ' : '') + 'Please sign your AGL solar meter consent – ' + i.job.site.fullAddress,
    body: 'Hi ' + i.job.accountHolder.firstName + ',\\n\\nTo get your meter set up for solar, AGL needs your consent for us to lodge the request on your behalf. It takes a minute:\\n\\n{{submitter.link}}\\n\\nThanks,\\nImpressive Team',
  },
};
return [{ json: { ...i, docusealBody: body } }];`), { position: [2640, -200] });
  const dsPost = w.node('Create DocuSeal Submission', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.settings.docusealApi }}/submissions/pdf',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.docusealBody) }}', options: {},
  }, { credentials: CRED.docuseal, position: [2880, -200] });
  const dsUpd = w.node('Awaiting Signature Updates', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const i = $('Build DocuSeal Request').first().json;
const r = $input.first().json;
const subId = r.id || (Array.isArray(r) ? r[0]?.submission_id : '') || r.submission_id || '';
const line = (i.settings.dryRun ? '[DRY RUN] ' : '') + 'AGL consent sent to DocuSeal (submission ' + subId + ')';
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, line) };
if (!i.settings.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: 'Awaiting Customer Signature' });
return [{ json: { dealId: i.job.dealId, properties } }];`), { position: [3120, -200] });
  const dsPatch = w.node('Update Deal (awaiting signature)', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [3360, -200] });

  // Send branch
  const comp = w.node('Compose Email', 'n8n-nodes-base.code', 2, code(`${src('src/mtr/compose.js')}
const templates = ${json('config/email-templates.json')};
const item = $input.first();
const i = item.json;
const email = composeEmail(i.job, i.retailer, templates, i.settings);
return [{ json: { ...i, email, attachmentKeys: i.files.map((f) => f.key).join(',') }, binary: item.binary }];`), { position: [2640, 160] });
  const send = w.node('Send Email', 'n8n-nodes-base.gmail', 2.1, {
    sendTo: '={{ $json.email.to }}', subject: '={{ $json.email.subject }}', emailType: 'text', message: '={{ $json.email.body }}',
    options: { appendAttribution: false, ccList: '={{ $json.email.cc }}', senderName: 'Impressive Team',
      attachmentsUi: { attachmentsBinary: [{ property: '={{ $json.attachmentKeys }}' }] } },
  }, { credentials: CRED.gmail, position: [2880, 160] });
  const post = w.node('After Send', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const i = $('Compose Email').first().json;
const m = $input.first().json;
const s = i.settings;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const line = (s.dryRun ? '[DRY RUN] ' : '') + 'SENT ' + i.retailer.label + ' to ' + i.email.realTo + ' msgId=' + m.id + ' threadId=' + m.threadId;
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, line) };
if (!s.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: 'Metering Application Sent', metering_application_date: today, dealstage: s.stageAfterSend });
const uploads = s.dryRun ? [] : i.files.filter((f) => f.upload);
return [{ json: { dealId: i.job.dealId, properties, uploads, noteBody: 'Metering application emailed to ' + i.retailer.label + ' (' + i.email.realTo + '): ' + i.email.subject } }];`), { position: [3120, 160] });
  const patch = w.node('Update Deal (sent)', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [3360, 160] });
  const split = w.node('Files To Upload', 'n8n-nodes-base.code', 2, code(`const a = $('After Send').first().json;
const c = $('Compose Email').first();
if (!a.uploads.length) return [];
return a.uploads.map((u) => ({ json: { dealId: a.dealId, name: u.name }, binary: { data: c.binary[u.key] } }));`), { position: [3600, 160] });
  const up = w.node('Upload To HubSpot', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `${HS}/files/v3/files`, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken',
    sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      { name: 'folderPath', value: '/metering/sent-forms' },
      { name: 'fileName', value: '={{ $json.dealId }} {{ $json.name }}' },
      { name: 'options', value: '{"access":"PRIVATE","overwrite":false}' },
    ] }, options: {},
  }, { credentials: CRED.hubspot, position: [3840, 160] });
  const note = w.node('Note On Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes`, `={{ JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: $('After Send').first().json.noteBody, hs_attachment_ids: $input.all().map((x) => x.json.id).join(';') }, associations: [{ to: { id: $('After Send').first().json.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }] }) }}`),
    { credentials: CRED.hubspot, position: [4080, 160], executeOnce: true });

  w.chain(t, fresh, plan, sw);
  w.connect(sw, fil, 0); w.connect(sw, sig, 1); w.connect(sw, dlu, 2);
  w.connect(sig, dlh, 0);
  const wait = w.node('Wait For All Files', 'n8n-nodes-base.merge', 3, { numberInputs: 3 }, { position: [1920, 0] });
  w.connect(fil, wait, 0, 0); w.connect(dlh, wait, 0, 1); w.connect(dlu, wait, 0, 2);
  w.connect(wait, merge);
  w.connect(fil, fail, 1); w.connect(sig, fail, 1); w.connect(dlh, fail, 1); w.connect(dlu, fail, 1);
  w.connect(merge, route);
  w.connect(route, ds, 0); w.chain(ds, dsPost, dsUpd, dsPatch);
  w.connect(route, comp, 1); w.chain(comp, send, post, patch, split, up, note);
});

// ───────────────────────── MTR – 02 Process Deal ─────────────────────────
// In: { dealId, messageId }  (one deal per call)
W.process = workflow('MTR – 02 Process Deal', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const st = w.node('Get Settings', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('settings')));
  const din = w.node('Deal ID', 'n8n-nodes-base.code', 2, code(`return [{ json: { dealId: String($('When Called').first().json.dealId) } }];`));
  const bj = w.node('Build Job', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('buildJob')));
  const prep = w.node('Prepare', 'n8n-nodes-base.code', 2, code(`const r = $input.first().json;
const settings = $('Get Settings').first().json;
const messageId = $('When Called').first().json.messageId;
return [{ json: { ...r, kind: r.action, settings, messageId } }];`));
  const sw = w.node('By Action', 'n8n-nodes-base.switch', 3.2, {
    rules: { values: ['email', 'manual', 'hold', 'skip', 'duplicate'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json.action }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
      renameOutput: true, outputKey: k })) },
    options: {},
  });
  const send = w.node('Send Application', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('send')), { y: -240 });
  const man = w.node('Manual Task', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('manualTask')), { position: [1440, -80] });
  const hold = w.node('Hold Task', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('manualTask')), { position: [1440, 80] });
  const skip = w.node('Skip Updates', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const i = $input.first().json;
const line = (i.settings.dryRun ? '[DRY RUN] ' : '') + 'SKIPPED: ' + i.reasons.join('; ');
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, line) };
if (!i.settings.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: 'Metering Not Needed (Existing Solar)' });
return [{ json: { dealId: i.dealId, properties } }];`), { position: [1440, 240] });
  const skipPatch = w.node('Update Deal (skip)', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [1680, 240] });
  const ok = w.node('Label Processed', 'n8n-nodes-base.gmail', 2.1, {
    operation: 'addLabels', messageId: "={{ $('Prepare').first().json.messageId }}", labelIds: "={{ [$('Get Settings').first().json.labelIds.processed] }}",
  }, { credentials: CRED.gmail, position: [2040, -80], executeOnce: true });
  const bad = w.node('Label Error', 'n8n-nodes-base.gmail', 2.1, {
    operation: 'addLabels', messageId: "={{ $('Prepare').first().json.messageId }}", labelIds: "={{ [$('Get Settings').first().json.labelIds.error] }}",
  }, { credentials: CRED.gmail, position: [2040, 80], executeOnce: true });
  const ifMsg = (name, pos) => w.node(name, 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'msg', leftValue: "={{ $('Prepare').first().json.messageId }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  }, { position: pos, executeOnce: true });
  const okIf = ifMsg('From Email? (ok)', [1800, -80]);
  const badIf = ifMsg('From Email? (error)', [1800, 80]);
  w.chain(t, st, din, bj, prep, sw);
  w.connect(sw, send, 0); w.connect(sw, man, 1); w.connect(sw, hold, 2); w.connect(sw, skip, 3); w.connect(sw, okIf, 4);
  w.connect(send, okIf); w.connect(man, okIf); w.connect(skip, skipPatch); w.connect(skipPatch, okIf);
  w.connect(hold, badIf);
  w.connect(okIf, ok, 0); w.connect(badIf, bad, 0);
});

// ───────────────────────── MTR – 01 Trigger ─────────────────────────
W.trigger = workflow('MTR – 01 Trigger', (w) => {
  const g = w.node('Gmail: Metering 2.0', 'n8n-nodes-base.gmailTrigger', 1.2, {
    pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: false,
    filters: { q: 'label:"Metering 2.0"', readStatus: 'both' }, options: {},
  }, { credentials: CRED.gmail });
  const p = w.node('Deal ID From Subject', 'n8n-nodes-base.code', 2, code(`const out = [];
for (const item of $input.all().slice(0, 10)) {
  const j = item.json;
  const subject = j.subject || j.Subject || j.headers?.subject || '';
  const m = String(subject).match(/\\b(\\d{6,})\\b/);
  out.push({ json: { messageId: j.id, subject, dealId: m ? m[1] : null } });
}
return out;`));
  const iff = w.node('Has Deal ID?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'has', leftValue: '={{ $json.dealId }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  });
  const ex = w.node('Process Deal', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('process'), 'each'), { y: -100 });
  const no = w.node('No Deal ID', 'n8n-nodes-base.code', 2, code(`throw new Error('Trigger email has no deal ID in the subject: "' + $input.first().json.subject + '"');`), { y: 100 });
  w.chain(g, p, iff);
  w.connect(iff, ex, 0); w.connect(iff, no, 1);
});

// ───────────────────────── MTR – 30 DocuSeal Completed ─────────────────────────
W.docuseal = workflow('MTR – 30 DocuSeal Completed', (w) => {
  const h = w.node('DocuSeal Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'mtr-docuseal', responseMode: 'onReceived', options: {} }, { webhookId: 'mtr-docuseal' });
  const p = w.node('Parse Event', 'n8n-nodes-base.code', 2, code(`const b = $input.first().json.body || {};
const ev = b.event_type || '';
const d = b.data || {};
const submissionId = d.submission_id || d.submission?.id || (ev.startsWith('submission') ? d.id : null);
if (!['form.completed', 'submission.completed'].includes(ev) || !submissionId) return [];
return [{ json: { event: ev, submissionId } }];`));
  const g = w.node('Get Submission', 'n8n-nodes-base.httpRequest', 4.2, {
    url: "={{ 'https://docuseal.impressivebatteries.com.au/api/submissions/' + $json.submissionId }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {},
  }, { credentials: CRED.docuseal });
  const v = w.node('Check Completed', 'n8n-nodes-base.code', 2, code(`const s = $input.first().json;
const sub = (s.submitters || [])[0] || {};
if (s.status !== 'completed' && sub.status !== 'completed') return [];
const dealId = sub.external_id;
if (!dealId) throw new Error('DocuSeal submission ' + s.id + ' has no external_id (deal ID)');
const doc = (s.documents || sub.documents || [])[0];
if (!doc || !doc.url) throw new Error('deal ' + dealId + ': signed DocuSeal document URL missing (submission ' + s.id + ')');
return [{ json: { dealId: String(dealId), signedConsentUrl: doc.url } }];`));
  const st = w.node('Get Settings', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('settings')));
  const din = w.node('Deal ID', 'n8n-nodes-base.code', 2, code(`return [{ json: { dealId: $('Check Completed').first().json.dealId } }];`));
  const bj = w.node('Build Job', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('buildJob')));
  const prep = w.node('Prepare Send', 'n8n-nodes-base.code', 2, code(`const r = $input.first().json;
const c = $('Check Completed').first().json;
const settings = $('Get Settings').first().json;
const status = r.deal.properties.metering_status;
if (!settings.dryRun && status !== 'Awaiting Customer Signature') throw new Error('deal ' + c.dealId + ': consent signed but Metering Status is "' + status + '", not Awaiting Customer Signature; not sending');
return [{ json: { ...r, settings, phase: 'send', signedConsentUrl: c.signedConsentUrl } }];`));
  const send = w.node('Send Application', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('send')));
  w.chain(h, p, g, v, st, din, bj, prep, send);
});

// ───────────────────────── MTR – 05 Network Letter Intake ─────────────────────────
const DISTRIBUTORS = [
  { name: 'Endeavour', label: 'Label_5823373004158048354', skip: 'Thank you for your Application Submission', pick: '_PTC_' },
  { name: 'Ausgrid', label: 'Label_3303489167417198909', skip: 'Thank you for your Application Submission', pick: null },
  { name: 'Essential', label: 'Label_592177598515650554', skip: 'Essential Energy Connection Application Approved', pick: null },
];
W.letters = workflow('MTR – 05 Network Letter Intake', (w) => {
  const picks = DISTRIBUTORS.map((d, n) => {
    const g = w.node(`Gmail: ${d.name} letters`, 'n8n-nodes-base.gmailTrigger', 1.2, {
      pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: false,
      filters: { labelIds: [d.label], readStatus: 'both' }, options: { downloadAttachments: true },
    }, { credentials: CRED.gmail, position: [0, (n - 1) * 200] });
    const pk = w.node(`Pick PDF (${d.name})`, 'n8n-nodes-base.code', 2, code(`const rule = ${JSON.stringify(d)};
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const subject = j.subject || j.headers?.subject || '';
  if (rule.skip && subject.includes(rule.skip)) continue;
  const bin = item.binary || {};
  const keys = Object.keys(bin).filter((k) => /pdf/i.test(bin[k].mimeType || '') || /\\.pdf$/i.test(bin[k].fileName || ''));
  const key = rule.pick ? keys.find((k) => (bin[k].fileName || '').toUpperCase().includes(rule.pick)) : (keys.includes('attachment_0') ? 'attachment_0' : keys[0]);
  if (!key) continue;
  out.push({ json: { distributor: rule.name, subject, messageId: j.id, fileName: bin[key].fileName }, binary: { letter: bin[key] } });
}
return out;`), { position: [240, (n - 1) * 200] });
    w.connect(g, pk);
    return pk;
  });
  const ai = w.node('Read Letter (Claude)', '@n8n/n8n-nodes-langchain.anthropic', 1, {
    resource: 'document',
    modelId: { __rl: true, value: 'claude-sonnet-4-5-20250929', mode: 'list', cachedResultName: 'claude-sonnet-4-5-20250929' },
    text: 'This PDF should be an NSW electricity distributor approval for a solar/battery connection (Ausgrid CNL, Endeavour PTC / connection of generator, Essential CSO/connection approval). Reply with JSON only, no prose: {"isApprovalLetter": true|false, "nmi": "<NMI exactly as printed>", "reference": "<the distributor\'s approval / job / reference number>", "distributor": "Ausgrid"|"Endeavour"|"Essential"}',
    inputType: 'binary', binaryPropertyName: 'letter', options: {},
  }, { credentials: CRED.anthropic, position: [480, 0] });
  const letters = w.node('Letters', 'n8n-nodes-base.noOp', 1, {}, { position: [360, 0] });
  for (const pk of picks) w.connect(pk, letters);
  const parse = w.node('Parse Letter', 'n8n-nodes-base.code', 2, code(`const out = [];
$input.all().forEach((item, i) => {
  const src = $('Letters').itemMatching(i);
  const raw = item.json.content?.[0]?.text || item.json.text || '';
  let p;
  try { p = JSON.parse(String(raw).replace(/^\`\`\`json\\s*/, '').replace(/\\s*\`\`\`$/, '').trim()); } catch (e) { throw new Error('Network letter "' + src.json.fileName + '": could not read Claude reply: ' + raw.slice(0, 200)); }
  if (!p.isApprovalLetter) return;
  const nmi = String(p.nmi || '').replace(/\\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{10,11}$/.test(nmi)) throw new Error('Network letter "' + src.json.fileName + '": NMI "' + p.nmi + '" not valid');
  out.push({ json: { ...src.json, nmi, nmi10: nmi.slice(0, 10), reference: String(p.reference || '').trim(), distributor: p.distributor || src.json.distributor }, binary: src.binary });
});
return out;`), { position: [720, 0] });
  const find = w.node('Find Deal By NMI', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/deals/search`, `={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'nmi', operator: 'CONTAINS_TOKEN', value: $json.nmi10 + '*' }, { propertyName: 'pipeline', operator: 'EQ', value: '978394588' }] }], properties: ['dealname', 'nmi', 'network_approval_reference', 'electricity_distributor', 'metering_automation_log'], limit: 5 }) }}`),
    { credentials: CRED.hubspot, position: [960, 0] });
  const one = w.node('Exactly One Deal', 'n8n-nodes-base.code', 2, code(`const out = [];
$input.all().forEach((item, i) => {
  const src = $('Parse Letter').itemMatching(i);
  const hits = (item.json.results || []).filter((d) => String(d.properties.nmi || '').toUpperCase().replace(/\\s/g, '').startsWith(src.json.nmi10));
  if (hits.length !== 1) throw new Error('Network letter NMI ' + src.json.nmi + ' (' + src.json.distributor + ', ref ' + src.json.reference + ') matched ' + hits.length + ' deals in the pipeline; attach it by hand');
  out.push({ json: { ...src.json, dealId: hits[0].id, deal: hits[0].properties }, binary: src.binary });
});
return out;`), { position: [1200, 0] });
  const up = w.node('Upload Letter', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `${HS}/files/v3/files`, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken',
    sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'letter' },
      { name: 'folderPath', value: '/metering/network-letters' },
      { name: 'fileName', value: '={{ $json.dealId }} {{ $json.distributor }} network approval {{ $json.reference }}.pdf' },
      { name: 'options', value: '{"access":"PRIVATE","overwrite":false}' },
    ] }, options: {},
  }, { credentials: CRED.hubspot, position: [1440, 0] });
  const note = w.node('Note On Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes`, `={{ JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: 'Network approval ' + $('Exactly One Deal').item.json.reference + ' (' + $('Exactly One Deal').item.json.distributor + ') attached via n8n', hs_attachment_ids: String($json.id) }, associations: [{ to: { id: $('Exactly One Deal').item.json.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }] }) }}`),
    { credentials: CRED.hubspot, position: [1680, 0] });
  const upd = w.node('Deal Updates', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
return $input.all().map((item, i) => {
  const s = $('Exactly One Deal').itemMatching(i).json;
  const f = $('Upload Letter').itemMatching(i).json;
  const properties = {
    network_approval_reference: s.reference,
    network_approval_letter_url: f.url || '',
    metering_automation_log: appendLog(s.deal.metering_automation_log, 'Network approval ' + s.reference + ' attached (file ' + f.id + ')'),
  };
  if (!s.deal.electricity_distributor && ['Ausgrid', 'Endeavour', 'Essential'].includes(s.distributor)) properties.electricity_distributor = s.distributor;
  return { json: { dealId: s.dealId, properties } };
});`), { position: [1920, 0] });
  const patch = w.node('Update Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [2160, 0] });
  w.chain(letters, ai, parse, find, one, up, note, upd, patch);
});

// ───────────────────────── MTR – T Test Harness ─────────────────────────
// Webhook for Claude to dry-run Build Job on a real deal: POST {dealId} with header x-mtr-test.
// Returns the job and decision only; sends nothing, writes nothing. Keep inactive when not testing.
W.harness = workflow('MTR – T Test Harness', (w) => {
  const token = fs.existsSync(path.join(__dirname, '.test-token')) ? fs.readFileSync(path.join(__dirname, '.test-token'), 'utf8').trim() : 'unset';
  const h = w.node('Test Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'mtr-test', responseMode: 'lastNode', options: {} }, { webhookId: 'mtr-test' });
  const chk = w.node('Check Token', 'n8n-nodes-base.code', 2, code(`const j = $input.first().json;
if ((j.headers || {})['x-mtr-test'] !== ${JSON.stringify(token)}) throw new Error('bad test token');
const b = j.body || {};
return [{ json: { dealId: String(b.dealId), mode: b.mode || 'job', pretendLetter: !!b.pretendLetter, asRetailer: b.asRetailer || '', messageId: '' } }];`));
  const sw = w.node('By Mode', 'n8n-nodes-base.switch', 3.2, {
    rules: { values: ['job', 'process', 'send'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json.mode }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
      renameOutput: true, outputKey: k })) }, options: {},
  });
  // job: read-only
  const bj = w.node('Build Job', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('buildJob')), { position: [960, -200] });
  const out = w.node('Result', 'n8n-nodes-base.code', 2, code(`const r = $input.first().json;
return [{ json: { action: r.action, reasons: r.reasons, retailerKey: r.retailerKey, job: r.job, dealUpdates: r.dealUpdates, files: r.files } }];`), { position: [1200, -200] });
  // process: the real MTR – 02 path without a Gmail message (dry-run settings apply)
  const pr = w.node('Process Deal', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('process')), { position: [960, 0] });
  const prOut = w.node('Process Result', 'n8n-nodes-base.code', 2, code(`return [{ json: { ok: true, items: $input.all().map((i) => i.json) } }];`), { position: [1200, 0] });
  // send: force MTR – 10 on a deal; pretendLetter uses the CCEW file as the network letter (test only)
  const st = w.node('Get Settings', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('settings')), { position: [960, 200] });
  const din = w.node('Deal ID', 'n8n-nodes-base.code', 2, code(`return [{ json: { dealId: $('Check Token').first().json.dealId } }];`), { position: [1200, 200] });
  const bj2 = w.node('Build Job (send)', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('buildJob')), { position: [1440, 200] });
  const pre = w.node('Pretend', 'n8n-nodes-base.code', 2, code(`const r = $input.first().json;
const settings = $('Get Settings').first().json;
if (!settings.dryRun) throw new Error('send test only runs in dry run');
// Test-only: log line marks it so nobody mistakes it for a real send.
r.deal.properties.metering_automation_log = (r.deal.properties.metering_automation_log || '') + '';
if ($('Check Token').first().json.pretendLetter && !r.job.networkApproval.fileId) {
  r.job.networkApproval.fileId = r.job.ccew.fileId;
  r.reasons = r.reasons.filter((x) => !/network approval letter/.test(x));
  if (!r.reasons.length && r.action === 'hold') r.action = 'email';
}
const as = $('Check Token').first().json.asRetailer;
if (as) {
  const retailers = ${json('config/retailers.json')};
  if (!retailers[as]) throw new Error('unknown retailer ' + as);
  r.retailer = retailers[as]; r.retailerKey = as; r.job.retailerKey = as; r.job.retailerLabel = retailers[as].label;
}
if (r.action !== 'email') throw new Error('deal ' + r.dealId + ' is not sendable: ' + r.action + ' ' + r.reasons.join('; '));
return [{ json: { ...r, settings } }];`), { position: [1680, 200] });
  const sd = w.node('Send Application', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('send')), { position: [1920, 200] });
  const sdOut = w.node('Send Result', 'n8n-nodes-base.code', 2, code(`return [{ json: { ok: true, items: $input.all().map((i) => i.json) } }];`), { position: [2160, 200] });
  w.chain(h, chk, sw);
  w.connect(sw, bj, 0); w.connect(bj, out);
  w.connect(sw, pr, 1); w.connect(pr, prOut);
  w.connect(sw, st, 2); w.chain(st, din, bj2, pre, sd, sdOut);
});

// ───────────────────────── write ─────────────────────────
if (require.main === module) {
  const dir = path.join(__dirname, 'json');
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, wf] of Object.entries(W)) fs.writeFileSync(path.join(dir, `${k}.json`), `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`built ${Object.keys(W).length} workflows → workflows/json/`);
}

module.exports = { W };

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
  // true: every retailer email and homeowner signing link goes to testInbox, HubSpot
  // tasks are emailed to testInbox instead, and the only HubSpot write is a
  // "[DRY RUN]" line in Metering Automation Log.
  dryRun: true,
  testInbox: 'rodrigo@impressivebatteries.com.au',
  fillerUrl: 'https://metering-applications.vercel.app',
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
// In: { job, retailer, deal, settings, dealUpdates, phase?: 'send', signedConsentPdf?, consentAudit? }
// Retailers needing the homeowner's signature (AGL) first get a signing link
// emailed to the homeowner; MTR – 30 calls back here with phase 'send'.
W.send = workflow('MTR – 10 Send Application', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const fresh = w.node('Re-read Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('GET', `={{ '${HS}/crm/v3/objects/deals/' + $json.job.dealId + '?properties=metering_application_date,metering_status,metering_automation_log' }}`),
    { credentials: CRED.hubspot });
  const guard = w.node('Guard', 'n8n-nodes-base.code', 2, code(`const i = $('When Called').first().json;
const now = $input.first().json.properties;
if (now.metering_application_date && !i.settings.dryRun) throw new Error('deal ' + i.job.dealId + ': already has a Metering Application Date; not sending again');
return [{ json: { ...i, needsSignature: !!i.retailer.needsCustomerSignature && i.phase !== 'send' } }];`));
  const sigIf = w.node('Needs Signature First?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'sig', leftValue: '={{ $json.needsSignature }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  });

  // ── Signature branch: email the homeowner a signing link ──
  const link = w.node('Get Signing Link (Vercel)', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.settings.fillerUrl }}/api/sign-link',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ ...$json.job, signerEmail: $json.settings.dryRun ? $json.settings.testInbox : $json.job.accountHolder.email }) }}', options: {},
  }, { credentials: CRED.filler, position: [960, -240] });
  const inv = w.node('Compose Invite', 'n8n-nodes-base.code', 2, code(`const i = $('Guard').first().json;
const l = $input.first().json;
const s = i.settings;
const h = i.job.accountHolder;
const expires = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(l.expiresAt));
const to = s.dryRun ? s.testInbox : h.email;
const subject = (s.dryRun ? '[DRY RUN → ' + h.email + '] ' : '') + 'Please sign your AGL solar meter consent – ' + i.job.site.fullAddress;
const body = 'Hi ' + h.firstName + ',\\n\\n'
  + 'To get your meter set up for your new solar at ' + i.job.site.fullAddress + ', AGL needs your consent for us to lodge the request on your behalf.\\n\\n'
  + 'It takes about a minute. Please check your details and sign here:\\n' + l.url + '\\n\\n'
  + 'The link is just for you and works until ' + expires + '.\\n\\n'
  + 'If you have any questions, call us on 1300 797 630.\\n\\n'
  + 'Kind regards,\\nImpressive Team\\nIMPRESSIVE ELECTRICAL & SOLAR PTY LTD | 1300 797 630';
return [{ json: { ...i, invite: { to, subject, body, expiresAt: l.expiresAt } } }];`), { position: [1200, -240] });
  const invSend = w.node('Email Homeowner', 'n8n-nodes-base.gmail', 2.1, {
    sendTo: '={{ $json.invite.to }}', subject: '={{ $json.invite.subject }}', emailType: 'text', message: '={{ $json.invite.body }}',
    options: { appendAttribution: false, senderName: 'Impressive Team' },
  }, { credentials: CRED.gmail, position: [1440, -240] });
  const invUpd = w.node('Awaiting Signature Updates', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const i = $('Compose Invite').first().json;
const m = $input.first().json;
const line = (i.settings.dryRun ? '[DRY RUN] ' : '') + 'AGL consent link emailed to ' + i.invite.to + ' (expires ' + i.invite.expiresAt.slice(0, 10) + ') msgId=' + m.id;
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, line) };
if (!i.settings.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: 'Awaiting Customer Signature' });
return [{ json: { dealId: i.job.dealId, properties } }];`), { position: [1680, -240] });
  const invPatch = w.node('Update Deal (awaiting signature)', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [1920, -240] });

  // ── Send branch ──
  const plan = w.node('Plan', 'n8n-nodes-base.code', 2, code(`const i = $('Guard').first().json;
const r = i.retailer;
const files = [];
for (const a of r.attachments) {
  if (a === 'ea_form' || a === 'agl_form') files.push({ kind: 'filler', form: r.form + '-form', name: a === 'ea_form' ? 'EA Service Works Request.pdf' : 'AGL Application for Electricity.pdf', upload: true });
  else if (a === 'ccew') files.push({ kind: 'hubspot', fileId: i.job.ccew.fileId, name: 'CCEW ' + i.job.ccew.receipt + '.pdf' });
  else if (a === 'network_letter') files.push({ kind: 'hubspot', fileId: i.job.networkApproval.fileId, name: i.job.distributor + ' network approval.pdf' });
  else if (a === 'agl_consent_signed') {
    if (!i.signedConsentPdf) throw new Error('deal ' + i.job.dealId + ': AGL needs the signed consent form but none was passed in');
    files.push({ kind: 'inline', name: 'AGL consent form (signed).pdf', upload: true });
  }
}
return files.map((f, n) => ({ json: { ...f, n, job: i.job, fillerUrl: i.settings.fillerUrl } }));`), { position: [960, 120] });
  const sw = w.node('By Source', 'n8n-nodes-base.switch', 3.2, {
    rules: { values: ['filler', 'hubspot', 'inline'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json.kind }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
      renameOutput: true, outputKey: k })) },
    options: {},
  }, { position: [1200, 120] });
  const fil = w.node('Fill Form (Vercel)', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.fillerUrl }}/api/{{ $json.form }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.job) }}',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { credentials: CRED.filler, onError: 'continueErrorOutput', position: [1440, -40] });
  const sig = w.node('HubSpot Signed URL', 'n8n-nodes-base.httpRequest', 4.2, {
    ...hubspot('GET', `={{ '${HS}/files/v3/files/' + $json.fileId + '/signed-url' }}`),
  }, { credentials: CRED.hubspot, onError: 'continueErrorOutput', position: [1440, 120] });
  const dlh = w.node('Download HubSpot File', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}', options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { onError: 'continueErrorOutput', position: [1680, 120] });
  const inl = w.node('Signed Consent File', 'n8n-nodes-base.code', 2, code(`const i = $('Guard').first().json;
return [{ json: {}, binary: { data: await this.helpers.prepareBinaryData(Buffer.from(i.signedConsentPdf, 'base64'), 'AGL consent form (signed).pdf', 'application/pdf') } }];`), { position: [1440, 280] });
  const fail = w.node('File Failed', 'n8n-nodes-base.code', 2, code(`const i = $('Guard').first().json;
const e = $input.first().json;
throw new Error('deal ' + i.job.dealId + ': could not get an attachment: ' + (e.error?.message || JSON.stringify(e.error || e).slice(0, 300)));`), { position: [1920, 360] });
  const wait = w.node('Wait For All Files', 'n8n-nodes-base.merge', 3, { numberInputs: 3 }, { position: [1920, 120] });
  const merge = w.node('Collect Files', 'n8n-nodes-base.code', 2, code(`const i = $('Guard').first().json;
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
return [{ json: { ...i, files }, binary }];`), { position: [2160, 120] });
  const comp = w.node('Compose Email', 'n8n-nodes-base.code', 2, code(`${src('src/mtr/compose.js')}
const templates = ${json('config/email-templates.json')};
const item = $input.first();
const i = item.json;
const email = composeEmail(i.job, i.retailer, templates, i.settings);
return [{ json: { ...i, email, attachmentKeys: i.files.map((f) => f.key).join(',') }, binary: item.binary }];`), { position: [2400, 120] });
  const send = w.node('Send Email', 'n8n-nodes-base.gmail', 2.1, {
    sendTo: '={{ $json.email.to }}', subject: '={{ $json.email.subject }}', emailType: 'text', message: '={{ $json.email.body }}',
    options: { appendAttribution: false, ccList: '={{ $json.email.cc }}', senderName: 'Impressive Team',
      attachmentsUi: { attachmentsBinary: [{ property: '={{ $json.attachmentKeys }}' }] } },
  }, { credentials: CRED.gmail, position: [2640, 120] });
  const post = w.node('After Send', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const i = $('Compose Email').first().json;
const m = $input.first().json;
const s = i.settings;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
let line = (s.dryRun ? '[DRY RUN] ' : '') + 'SENT ' + i.retailer.label + ' to ' + i.email.realTo + ' msgId=' + m.id + ' threadId=' + m.threadId;
if (i.consentAudit) line = (s.dryRun ? '[DRY RUN] ' : '') + 'Consent signed by ' + i.consentAudit.name + ' at ' + i.consentAudit.signedAt + ' IP ' + i.consentAudit.ip + '\\n' + line;
const properties = { metering_automation_log: appendLog(i.deal.properties.metering_automation_log, line) };
if (!s.dryRun) Object.assign(properties, i.dealUpdates, { metering_status: 'Metering Application Sent', metering_application_date: today, dealstage: s.stageAfterSend });
const uploads = s.dryRun ? [] : i.files.filter((f) => f.upload);
return [{ json: { dealId: i.job.dealId, properties, uploads, noteBody: 'Metering application emailed to ' + i.retailer.label + ' (' + i.email.realTo + '): ' + i.email.subject } }];`), { position: [2880, 120] });
  const patch = w.node('Update Deal (sent)', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [3120, 120] });
  const split = w.node('Files To Upload', 'n8n-nodes-base.code', 2, code(`const a = $('After Send').first().json;
const c = $('Compose Email').first();
if (!a.uploads.length) return [];
return a.uploads.map((u) => ({ json: { dealId: a.dealId, name: u.name }, binary: { data: c.binary[u.key] } }));`), { position: [3360, 120] });
  const up = w.node('Upload To HubSpot', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `${HS}/files/v3/files`, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken',
    sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      { name: 'folderPath', value: '/metering/sent-forms' },
      { name: 'fileName', value: '={{ $json.dealId }} {{ $json.name }}' },
      { name: 'options', value: '{"access":"PRIVATE","overwrite":false}' },
    ] }, options: {},
  }, { credentials: CRED.hubspot, position: [3600, 120] });
  const note = w.node('Note On Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes`, `={{ JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: $('After Send').first().json.noteBody, hs_attachment_ids: $input.all().map((x) => x.json.id).join(';') }, associations: [{ to: { id: $('After Send').first().json.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }] }) }}`),
    { credentials: CRED.hubspot, position: [3840, 120], executeOnce: true });

  w.chain(t, fresh, guard, sigIf);
  w.connect(sigIf, link, 0); w.chain(link, inv, invSend, invUpd, invPatch);
  w.connect(sigIf, plan, 1); w.connect(plan, sw);
  w.connect(sw, fil, 0); w.connect(sw, sig, 1); w.connect(sw, inl, 2);
  w.connect(sig, dlh, 0);
  w.connect(fil, wait, 0, 0); w.connect(dlh, wait, 0, 1); w.connect(inl, wait, 0, 2);
  w.connect(fil, fail, 1); w.connect(sig, fail, 1); w.connect(dlh, fail, 1);
  w.chain(wait, merge, comp, send, post, patch, split, up, note);
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

// ───────────────────────── MTR – 30 Consent Signed ─────────────────────────
// Called by the signing page (Vercel /api/sign-submit). Vercel /api/sign-finalize
// re-checks the link and returns the signed PDF, then the AGL application is sent.
W.consent = workflow('MTR – 30 Consent Signed', (w) => {
  const h = w.node('Signing Page Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'mtr-consent-signed', responseMode: 'responseNode', options: {} }, { webhookId: 'mtr-consent-signed' });
  const fin = w.node('Signed PDF (Vercel)', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://metering-applications.vercel.app/api/sign-finalize',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: {},
  }, { credentials: CRED.filler });
  const ok = w.node('Reply To Page', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: true }) }}', options: {} });
  const st = w.node('Get Settings', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('settings')));
  const din = w.node('Deal ID', 'n8n-nodes-base.code', 2, code(`return [{ json: { dealId: String($('Signed PDF (Vercel)').first().json.dealId) } }];`));
  const bj = w.node('Build Job', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('buildJob')));
  const prep = w.node('Prepare Send', 'n8n-nodes-base.code', 2, code(`const r = $input.first().json;
const f = $('Signed PDF (Vercel)').first().json;
const b = $('Signing Page Webhook').first().json.body;
const settings = $('Get Settings').first().json;
const status = r.deal.properties.metering_status;
if (!settings.dryRun && status !== 'Awaiting Customer Signature') throw new Error('deal ' + f.dealId + ': consent signed but Metering Status is "' + status + '", not Awaiting Customer Signature; not sending');
return [{ json: { ...r, settings, phase: 'send', signedConsentPdf: f.pdf, consentAudit: { name: b.typedName, email: f.signerEmail, signedAt: b.signedAt, ip: b.ip } } }];`));
  const send = w.node('Send Application', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('send')));
  w.chain(h, fin, ok, st, din, bj, prep, send);
});

// ───────────────────────── MTR – 05 Network Letter Intake ─────────────────────────
// Distributor approval emails (the three PTC Gmail labels, read-only) → attach the
// letter PDF to the deal under its original file name, unless a file with that
// name is already attached. If the deal was on hold only for the missing letter,
// clear the hold and run MTR – 02 again.
const DISTRIBUTORS = [
  { name: 'Endeavour', label: 'Label_5823373004158048354', skip: 'Thank you for your Application Submission' },
  { name: 'Ausgrid', label: 'Label_3303489167417198909', skip: 'Thank you for your Application Submission' },
  { name: 'Essential', label: 'Label_592177598515650554', skip: 'Essential Energy Connection Application Approved' },
];
W.letters = workflow('MTR – 05 Network Letter Intake', (w) => {
  const rulesJson = json('config/network-letters.json');
  const picks = DISTRIBUTORS.map((d, n) => {
    const g = w.node(`Gmail: ${d.name} letters`, 'n8n-nodes-base.gmailTrigger', 1.2, {
      pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: false,
      filters: { labelIds: [d.label], readStatus: 'both' }, options: { downloadAttachments: true },
    }, { credentials: CRED.gmail, position: [0, (n - 1) * 200] });
    const pk = w.node(`Pick PDF (${d.name})`, 'n8n-nodes-base.code', 2, code(`const d = ${JSON.stringify(d)};
const rule = (${rulesJson})[d.name] || {};
const re = rule.fileName ? new RegExp(rule.fileName, 'i') : null;
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const subject = j.subject || j.headers?.subject || '';
  if (d.skip && subject.includes(d.skip)) continue;
  const bin = item.binary || {};
  const pdfs = Object.keys(bin).filter((k) => /pdf/i.test(bin[k].mimeType || '') || /\\.pdf$/i.test(bin[k].fileName || ''));
  // With a file-name rule, only the matching PDF is the approval; otherwise the first PDF.
  const key = re ? pdfs.find((k) => re.test(bin[k].fileName || '')) : pdfs[0];
  if (!key) continue;
  out.push({ json: { distributor: d.name, subject, messageId: j.id, fileName: bin[key].fileName }, binary: { letter: bin[key] } });
}
return out;`), { position: [240, (n - 1) * 200] });
    w.connect(g, pk);
    return pk;
  });
  const letters = w.node('Letters', 'n8n-nodes-base.noOp', 1, {}, { position: [480, 0] });
  for (const pk of picks) w.connect(pk, letters);
  const ai = w.node('Read Letter (Claude)', '@n8n/n8n-nodes-langchain.anthropic', 1, {
    resource: 'document',
    modelId: { __rl: true, value: 'claude-sonnet-4-5-20250929', mode: 'list', cachedResultName: 'claude-sonnet-4-5-20250929' },
    text: 'This PDF should be an NSW electricity distributor approval for a solar/battery connection (Ausgrid Notification Letter, Endeavour PTC / connection of generator, Essential connection approval). Reply with JSON only, no prose: {"isApprovalLetter": true|false, "nmi": "<NMI exactly as printed>", "reference": "<the distributor\'s approval / job / reference number>", "distributor": "Ausgrid"|"Endeavour"|"Essential"}',
    inputType: 'binary', binaryPropertyName: 'letter', options: {},
  }, { credentials: CRED.anthropic, position: [720, 0] });
  const parse = w.node('Parse Letter', 'n8n-nodes-base.code', 2, code(`const out = [];
$input.all().forEach((item, i) => {
  const src = $('Letters').itemMatching(i);
  const raw = item.json.content?.[0]?.text || item.json.text || '';
  let p;
  try { p = JSON.parse(String(raw).replace(/^\`\`\`json\\s*/, '').replace(/\\s*\`\`\`$/, '').trim()); } catch (e) { throw new Error('Network letter "' + src.json.fileName + '": could not read Claude reply: ' + raw.slice(0, 200)); }
  if (!p.isApprovalLetter) return;
  const nmi = String(p.nmi || '').replace(/\\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{10,11}$/.test(nmi)) throw new Error('Network letter "' + src.json.fileName + '": NMI "' + p.nmi + '" not valid');
  out.push({ json: { ...src.json, nmi, nmi10: nmi.slice(0, 10), reference: String(p.reference || '').trim() }, binary: src.binary });
});
return out;`), { position: [960, 0] });
  const each = w.node('Attach Letter (each)', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('attachLetter'), 'each'), { position: [1200, 0] });
  w.chain(letters, ai, parse, each);
});

// ───────────────────────── MTR – 06 Attach Letter ─────────────────────────
// In: one letter { distributor, fileName, nmi, nmi10, reference, messageId } + binary.letter
W.attachLetter = workflow('MTR – 06 Attach Letter', (w) => {
  const t = w.node('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  const find = w.node('Find Deal By NMI', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/deals/search`, `={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'nmi', operator: 'CONTAINS_TOKEN', value: $json.nmi10 + '*' }, { propertyName: 'pipeline', operator: 'EQ', value: '978394588' }] }], properties: ['dealname', 'nmi', 'network_approval_reference', 'electricity_distributor', 'metering_status', 'metering_automation_log'], limit: 5 }) }}`),
    { credentials: CRED.hubspot, position: [1200, 0] });
  const one = w.node('Exactly One Deal', 'n8n-nodes-base.code', 2, code(`const out = [];
$input.all().forEach((item) => {
  const src = $('When Called').first();
  const hits = (item.json.results || []).filter((d) => String(d.properties.nmi || '').toUpperCase().replace(/\\s/g, '').startsWith(src.json.nmi10));
  if (hits.length !== 1) throw new Error('Network letter NMI ' + src.json.nmi + ' (' + src.json.distributor + ', ref ' + src.json.reference + ', file ' + src.json.fileName + ') matched ' + hits.length + ' deals in the pipeline; attach it by hand');
  out.push({ json: { ...src.json, dealId: String(hits[0].id), deal: hits[0].properties }, binary: src.binary });
});
return out;`), { position: [1440, 0] });
  const notes = w.node('Deal Notes', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes/search`, `={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'associations.deal', operator: 'EQ', value: $json.dealId }] }], properties: ['hs_attachment_ids'], limit: 100 }) }}`),
    { credentials: CRED.hubspot, position: [1680, 0] });
  const ids = w.node('Attached File IDs', 'n8n-nodes-base.code', 2, code(`const src = $('Exactly One Deal').first();
const out = [];
for (const n of $input.first().json.results || []) for (const f of String(n.properties.hs_attachment_ids || '').split(';').filter(Boolean)) out.push({ json: { fileId: f } });
return out.length ? out.slice(0, 80) : [{ json: { fileId: 'none' } }];`), { position: [1920, 0], executeOnce: true });
  const names = w.node('Attached File Names', 'n8n-nodes-base.httpRequest', 4.2, hubspot('GET', `={{ '${HS}/files/v3/files/' + $json.fileId }}`),
    { credentials: CRED.hubspot, onError: 'continueRegularOutput', position: [2160, 0] });
  const dup = w.node('Already Attached?', 'n8n-nodes-base.code', 2, code(`const src = $('Exactly One Deal').first();
const norm = (s) => String(s || '').toLowerCase().replace(/\\.pdf$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const want = norm(src.json.fileName);
const have = $input.all().map((f) => norm((f.json.name || '') + (f.json.extension ? '.' + f.json.extension : '')));
const duplicate = have.includes(want);
// testOnly (test harness): report and stop before any write.
if (src.json.testOnly) return [{ json: { testOnly: true, duplicate, dealId: src.json.dealId, checked: have.length } }];
if (duplicate) return [];
return [src];`), { position: [2400, 0] });
  const stopTest = w.node('Test Only?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 't', leftValue: '={{ $json.testOnly }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  }, { position: [2520, 160] });
  const up = w.node('Upload Letter', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `${HS}/files/v3/files`, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken',
    sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'letter' },
      { name: 'folderPath', value: '/metering/network-letters' },
      { name: 'fileName', value: '={{ $json.fileName }}' },
      { name: 'options', value: '{"access":"PRIVATE","overwrite":false,"duplicateValidationStrategy":"NONE"}' },
    ] }, options: {},
  }, { credentials: CRED.hubspot, position: [2640, 0] });
  const note = w.node('Note On Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('POST', `${HS}/crm/v3/objects/notes`, `={{ JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: 'Network approval ' + $('Already Attached?').first().json.reference + ' (' + $('Already Attached?').first().json.distributor + ') attached via n8n', hs_attachment_ids: String($json.id) }, associations: [{ to: { id: $('Already Attached?').first().json.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }] }) }}`),
    { credentials: CRED.hubspot, position: [2880, 0] });
  const upd = w.node('Deal Updates', 'n8n-nodes-base.code', 2, code(`${LOG_FN}
const s = $('Already Attached?').first().json;
const f = $('Upload Letter').first().json;
const properties = {
  network_approval_reference: s.reference || s.deal.network_approval_reference || '',
  network_approval_letter_url: f.url || '',
};
if (!s.deal.electricity_distributor && ['Ausgrid', 'Endeavour', 'Essential'].includes(s.distributor)) properties.electricity_distributor = s.distributor;
// Re-run the deal if it is on hold and every reason in the last HOLD line was about the network letter.
const lastHold = String(s.deal.metering_automation_log || '').split('\\n').reverse().find((l) => / HOLD: /.test(l)) || '';
const reasons = lastHold.split(' HOLD: ')[1]?.split('; ') || [];
const onlyLetter = reasons.length > 0 && reasons.every((r) => /network approval/i.test(r));
const retry = s.deal.metering_status === 'Metering Issues Not Sent On Hold' && onlyLetter;
if (retry) properties.metering_status = '';
properties.metering_automation_log = appendLog(s.deal.metering_automation_log, 'Network approval ' + s.reference + ' attached (' + s.fileName + ')' + (retry ? '; hold cleared, re-running' : ''));
return [{ json: { dealId: s.dealId, properties, retry } }];`), { position: [3120, 0] });
  const patch = w.node('Update Deal', 'n8n-nodes-base.httpRequest', 4.2,
    hubspot('PATCH', `={{ '${HS}/crm/v3/objects/deals/' + $json.dealId }}`, '={{ JSON.stringify({ properties: $json.properties }) }}'),
    { credentials: CRED.hubspot, position: [3360, 0] });
  const retry = w.node('Retry?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: 'r', leftValue: "={{ $('Deal Updates').first().json.retry }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true, options: {},
  }, { position: [3600, 0] });
  const again = w.node('Re-run Deal', 'n8n-nodes-base.code', 2, code(`return [{ json: { dealId: $('Deal Updates').first().json.dealId, messageId: '' } }];`), { position: [3840, 0] });
  const proc = w.node('Process Deal', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('process')), { position: [4080, 0] });
  w.chain(t, find, one, notes, ids, names, dup, stopTest);
  w.connect(stopTest, up, 1);
  w.chain(up, note, upd, patch, retry);
  w.connect(retry, again, 0); w.connect(again, proc);
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
return [{ json: { dealId: String(b.dealId), mode: b.mode || 'job', pretendLetter: !!b.pretendLetter, asRetailer: b.asRetailer || '', messageId: '', letter: b.letter || null } }];`));
  const sw = w.node('By Mode', 'n8n-nodes-base.switch', 3.2, {
    rules: { values: ['job', 'process', 'send', 'letter'].map((k) => ({
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
  // letter: run MTR – 06 with a letter described in the body (dummy PDF). Use a file name that is already on the deal to test the duplicate check without writing.
  const lt = w.node('Letter Input', 'n8n-nodes-base.code', 2, code(`const l = $('Check Token').first().json.letter;
const nmi = String(l.nmi).toUpperCase();
return [{ json: { distributor: l.distributor, fileName: l.fileName, nmi, nmi10: nmi.slice(0, 10), reference: l.reference || '', messageId: '', testOnly: true }, binary: { letter: await this.helpers.prepareBinaryData(Buffer.from('%PDF-1.4 test'), l.fileName, 'application/pdf') } }];`), { position: [960, 400] });
  const al = w.node('Attach Letter', 'n8n-nodes-base.executeWorkflow', 1.2, execWf(id('attachLetter')), { position: [1200, 400] });
  const alOut = w.node('Letter Result', 'n8n-nodes-base.code', 2, code(`return [{ json: { ok: true, items: $input.all().map((i) => i.json) } }];`), { position: [1440, 400], alwaysOutputData: true });
  w.connect(sw, lt, 3); w.chain(lt, al, alOut);
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

// Builds workflows/mtr-99-error-handler.json (n8n workflow body for the public API).
// Convention for all MTR workflows: when a Code node throws on purpose, start the
// message with "deal <id>:" so this handler can link the deal.
const fs = require('fs');

const code = String.raw`const d = $input.first().json;
const exec = d.execution || {};
const wf = d.workflow || {};
const err = exec.error || {};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const message = err.message || (err.messages && err.messages[0]) || 'No message';
const node = (err.node && err.node.name) || exec.lastNodeExecuted || 'Unknown node';
const m = String(message).match(/\bdeal\s*(?:id)?\s*[:#]?\s*(\d{6,})/i);
const dealId = m ? m[1] : null;
const dealUrl = dealId ? 'https://app-ap1.hubspot.com/contacts/441838848/record/0-3/' + dealId : null;
const execUrl = exec.url || null;

const row = (k, v) => '<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">' + k + '</td><td style="padding:4px 0">' + v + '</td></tr>';
const html = '<div style="font-family:Arial,sans-serif;font-size:14px">'
  + '<p><b>' + esc(wf.name || 'Unknown workflow') + '</b> failed.</p>'
  + '<table style="border-collapse:collapse">'
  + row('Deal', dealUrl ? '<a href="' + dealUrl + '">' + dealId + '</a>' : 'not known')
  + row('Node', esc(node))
  + row('Error', esc(message))
  + (err.description ? row('Details', esc(err.description)) : '')
  + row('Execution', execUrl ? '<a href="' + esc(execUrl) + '">' + esc(exec.id) + '</a>' : esc(exec.id || 'n/a'))
  + row('Mode', esc(exec.mode || ''))
  + '</table></div>';

return [{ json: {
  subject: 'MTR error: ' + (wf.name || 'workflow') + (dealId ? ' (deal ' + dealId + ')' : ''),
  html,
} }];`;

const wf = {
  name: 'MTR – 99 Error Handler',
  nodes: [
    { parameters: {}, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], id: 'b5f0a4a2-9e0f-4c0e-9a1a-990000000001', name: 'Error Trigger' },
    { parameters: { jsCode: code }, type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], id: 'b5f0a4a2-9e0f-4c0e-9a1a-990000000002', name: 'Build Alert' },
    {
      parameters: {
        sendTo: 'rodrigo@impressivebatteries.com.au',
        subject: '={{ $json.subject }}',
        message: '={{ $json.html }}',
        options: { appendAttribution: false },
      },
      type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [440, 0],
      id: 'b5f0a4a2-9e0f-4c0e-9a1a-990000000003', name: 'Email Rodrigo',
      webhookId: 'b5f0a4a2-9e0f-4c0e-9a1a-990000000004',
      credentials: { gmailOAuth2: { id: 'bBoYFD6eHvB5ixtS', name: "Rod's Impressive Batteries' Email" } },
    },
  ],
  connections: {
    'Error Trigger': { main: [[{ node: 'Build Alert', type: 'main', index: 0 }]] },
    'Build Alert': { main: [[{ node: 'Email Rodrigo', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

fs.writeFileSync(__dirname + '/mtr-99-error-handler.json', JSON.stringify(wf, null, 2) + '\n');
module.exports = { code };

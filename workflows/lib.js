// Helpers for building n8n workflow JSON (public API shape).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const CRED = {
  hubspot: { hubspotAppToken: { id: 'DK6aUhoyZ42IbfNM', name: "Impressive Batterie's Hubspot" } },
  gmail: { gmailOAuth2: { id: 'bBoYFD6eHvB5ixtS', name: "Rod's Impressive Batteries' Email" } },
  filler: { httpHeaderAuth: { id: '4t99N3DNPPhFiej0', name: 'EA Filler' } },
  docuseal: { httpHeaderAuth: { id: '3jRr6HHI4Wx4x1oP', name: 'Docuseal' } },
  anthropic: { anthropicApi: { id: 'Y5pXWsYFFWYhRrox', name: 'Anthropic account' } },
};
const ERROR_WORKFLOW_ID = 'CS7g4VWEMmGhn3DQ';

// Stable node ids so re-deploys don't churn.
const uuid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function workflow(name, build) {
  const nodes = [];
  const connections = {};
  let x = 0;
  const api = {
    node(nodeName, type, typeVersion, parameters, extra = {}) {
      const n = { parameters, type, typeVersion, position: extra.position || [x, extra.y || 0], id: uuid(`${name}/${nodeName}`), name: nodeName, ...extra };
      delete n.y;
      if (!extra.position) x += 240;
      nodes.push(n);
      return nodeName;
    },
    connect(from, to, output = 0, input = 0) {
      connections[from] = connections[from] || { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: input });
    },
    chain(...names) { for (let i = 0; i < names.length - 1; i++) api.connect(names[i], names[i + 1]); },
  };
  build(api);
  return {
    name, nodes, connections,
    settings: { executionOrder: 'v1', errorWorkflow: ERROR_WORKFLOW_ID, saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
  };
}

// ---- node factories ----
const code = (js) => ({ jsCode: js });

const hubspot = (method, url, body) => ({
  method, url,
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'hubspotAppToken',
  ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
  options: {},
});

const execWf = (id, mode = 'once') => ({
  workflowId: { __rl: true, value: id, mode: 'id' },
  workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
  mode,
  options: { waitForSubWorkflow: true },
});

// ---- inlining repo code into Code nodes ----
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/^if \(typeof module[\s\S]*$/m, '') // drop CommonJS export footer
  .replace(/^module\.exports.*$/gm, '');
const json = (rel) => JSON.stringify(require(path.join(ROOT, rel)));

function hubspotLabels() {
  const props = require(path.join(ROOT, 'config/hubspot-properties.json')).properties;
  return JSON.stringify({
    retailer: Object.fromEntries(props.find((p) => p.name === 'metering_retailer').options),
    route: Object.fromEntries(props.find((p) => p.name === 'metering_route').options),
  });
}

module.exports = { workflow, code, hubspot, execWf, src, json, hubspotLabels, CRED, ERROR_WORKFLOW_ID, ROOT };

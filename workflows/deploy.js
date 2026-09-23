// Create or update the MTR workflows in n8n through the public API.
// Usage: node workflows/deploy.js [key ...]   (default: all, in dependency order)
// New workflows are created INACTIVE. ids are saved to workflows/ids.json.
// Auth: the X-N8N-API-KEY header is added by the environment's proxy, or set N8N_API_KEY.

const fs = require('fs');
const path = require('path');

const BASE = 'https://n8n.nuevaenergy.com.au/api/v1';
const IDS_FILE = path.join(__dirname, 'ids.json');
const ORDER = ['settings', 'buildJob', 'manualTask', 'send', 'process', 'trigger', 'consent', 'attachLetter', 'letters', 'harness'];

const { execFileSync } = require('child_process');

// curl rather than fetch: it honours the environment's HTTPS proxy.
async function api(method, url, body) {
  const args = ['-sS', '-X', method, '-H', 'content-type: application/json', '-w', '\n%{http_code}'];
  if (process.env.N8N_API_KEY) args.push('-H', `X-N8N-API-KEY: ${process.env.N8N_API_KEY}`);
  if (body) args.push('--data-binary', '@-');
  const out = execFileSync('curl', [...args, BASE + url], { input: body ? JSON.stringify(body) : undefined, maxBuffer: 64 << 20 }).toString();
  const i = out.lastIndexOf('\n');
  const text = out.slice(0, i); const code = Number(out.slice(i + 1));
  if (code >= 300) throw new Error(`${method} ${url} → ${code} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

(async () => {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : ORDER;
  const ids = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')) : {};
  // Pass 1: create anything missing so every id exists.
  for (const k of ORDER.filter((k) => want.includes(k) && !ids[k])) {
    delete require.cache[require.resolve('./build')];
    const wf = require('./build').W[k];
    const r = await api('POST', '/workflows', wf);
    ids[k] = r.id;
    fs.writeFileSync(IDS_FILE, `${JSON.stringify(ids, null, 2)}\n`);
    console.log(`created ${wf.name} → ${r.id}`);
  }
  // Pass 2: rebuild with real ids and update.
  delete require.cache[require.resolve('./build')];
  const { W } = require('./build');
  for (const k of ORDER.filter((k) => want.includes(k))) {
    const r = await api('PUT', `/workflows/${ids[k]}`, W[k]);
    console.log(`updated ${r.name} (${ids[k]}) active=${r.active}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

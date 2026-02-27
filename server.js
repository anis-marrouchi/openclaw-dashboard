const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const BIND = process.env.DASHBOARD_BIND || '127.0.0.1';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || '/home/clawd/.openclaw/openclaw.json';
const CRON_PATH = process.env.OPENCLAW_CRON_PATH || '/home/clawd/.openclaw/cron/jobs.json';
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || '/home/clawd/.openclaw/agents';
const FORENSICS_PATH = process.env.FORENSICS_LEDGER_PATH || '/home/clawd/agents/qa-forensics-workspace/memory/forensics-pipeline.json';
const SOURCES_PATH = process.env.DASHBOARD_SOURCES_PATH || path.join(__dirname, 'sources.json');

const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.noqta.tn/api/v4';
const GITLAB_PROJECTS = (process.env.GITLAB_PROJECTS || '124:MTGL v1,210:noqta,205:noqta.tn,243:MTGL v2')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(entry => {
    const [id, ...name] = entry.split(':');
    return { id: Number(id), name: name.join(':') || `project-${id}` };
  });

function readJsonSafe(p, fallback = {}) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSources() {
  const cfg = readJsonSafe(SOURCES_PATH, { sources: [{ id: 'server', type: 'local', enabled: true }] });
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  return sources.filter(s => s && s.enabled !== false);
}

function readConfig() {
  return readJsonSafe(CONFIG_PATH, {});
}

function getAgents() {
  const cfg = readConfig();
  return (cfg.agents?.list || []).map(a => ({
    id: a.id,
    name: a.name || a.id,
    workspace: a.workspace,
    skills: a.skills || [],
    toolsProfile: a.tools?.profile || 'default',
    isDefault: !!a.default,
  }));
}

function getCrons() {
  const data = readJsonSafe(CRON_PATH, []);
  if (Array.isArray(data)) return data;
  return data.jobs || data.entries || [];
}

function agentExists(agentId) {
  return getAgents().some(a => a.id === agentId);
}

function getSessions() {
  try {
    const all = [];
    if (!fs.existsSync(AGENTS_DIR)) return [];
    const agentDirs = fs.readdirSync(AGENTS_DIR);
    for (const agentDir of agentDirs) {
      const sessFile = path.join(AGENTS_DIR, agentDir, 'sessions', 'sessions.json');
      if (!fs.existsSync(sessFile)) continue;
      const data = readJsonSafe(sessFile, {});
      for (const [key, meta] of Object.entries(data)) {
        all.push({ key, agentId: agentDir, ...meta });
      }
    }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return all.slice(0, 50);
  } catch {
    return [];
  }
}

function getForensicsLedger() {
  return readJsonSafe(FORENSICS_PATH, { items: [] });
}

function getConversations(agentId, limit = 50) {
  const baseDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(baseDir)) return { agent: agentId, sessions: [] };

  const index = readJsonSafe(path.join(baseDir, 'sessions.json'), {});
  const sessions = [];

  for (const [key, meta] of Object.entries(index)) {
    const sessionId = meta.sessionId;
    if (!sessionId) continue;
    const jsonlPath = path.join(baseDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    try {
      const raw = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = raw ? raw.split('\n').filter(Boolean) : [];
      const messages = [];
      const start = Math.max(0, lines.length - limit);

      for (let i = start; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'message') continue;
        const msg = entry.message || {};
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;
        const content = msg.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('')
            : '';
        if (!text || text.startsWith('[System')) continue;
        messages.push({
          role: msg.role,
          text: text.substring(0, 500),
          ts: entry.timestamp || msg.timestamp || null,
        });
      }

      if (messages.length > 0) {
        sessions.push({
          key,
          sessionId,
          updatedAt: meta.updatedAt || null,
          messageCount: lines.length,
          messages: messages.slice(-limit),
        });
      }
    } catch {
      // ignore broken line/session
    }
  }

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { agent: agentId, sessions: sessions.slice(0, 10) };
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : require('http');
    client.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function runAgentTurn({ agentId, message, timeoutSeconds = 120 }) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', agentId, '--message', message, '--json', '--timeout', String(timeoutSeconds)];
    execFile('openclaw', args, { timeout: Math.max(10, timeoutSeconds) * 1000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'openclaw agent failed').trim()));
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout || '{}'); } catch {}
      resolve({ ok: true, agentId, result: parsed || { raw: (stdout || '').trim() } });
    });
  });
}

async function fetchGitlabIssues() {
  if (!GITLAB_TOKEN) return [];
  const all = [];
  for (const p of GITLAB_PROJECTS) {
    try {
      const issues = await fetchJson(`${GITLAB_URL}/projects/${p.id}/issues?state=opened&per_page=100`, { 'PRIVATE-TOKEN': GITLAB_TOKEN });
      if (!Array.isArray(issues)) continue;
      for (const i of issues) {
        all.push({
          id: i.id,
          iid: i.iid,
          title: i.title,
          state: i.state,
          labels: i.labels || [],
          assignee: i.assignee?.username || null,
          project: p.name,
          projectId: p.id,
          webUrl: i.web_url,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
        });
      }
    } catch {
      // ignore one project failure
    }
  }
  return all;
}

async function fetchFromSource(source, routeWithQuery) {
  const base = (source.baseUrl || '').replace(/\/$/, '');
  if (!base) return { error: `Source ${source.id} missing baseUrl` };
  try {
    return await fetchJson(`${base}${routeWithQuery}`);
  } catch (e) {
    return { error: e.message };
  }
}

async function localRoute(route, url) {
  if (route === '/api/agents') return getAgents();
  if (route === '/api/crons') return getCrons();
  if (route === '/api/sessions') return getSessions();
  if (route === '/api/issues') return await fetchGitlabIssues();
  if (route === '/api/forensics') return getForensicsLedger();
  if (route === '/api/conversations') {
    const agentId = url.searchParams.get('agent') || 'main';
    const limit = Number(url.searchParams.get('limit') || '50');
    return getConversations(agentId, limit);
  }
  if (route === '/api/overview') {
    const agents = getAgents();
    const crons = getCrons();
    const sessions = getSessions();
    return {
      agents,
      crons,
      sessions,
      counts: {
        agents: agents.length,
        crons: crons.length,
        activeCrons: crons.filter(c => c.enabled).length,
        sessions: sessions.length,
      },
    };
  }
  return null;
}

function withSourceTag(data, sourceId) {
  if (Array.isArray(data)) return data.map(x => ({ ...x, sourceId }));
  if (data && typeof data === 'object') return { ...data, sourceId };
  return data;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (route === '/api/sources') {
    const sources = loadSources();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sources));
    return;
  }

  if (route === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agentId = String(body.agentId || '').trim();
      const message = String(body.message || '').trim();
      const timeoutSeconds = Number(body.timeoutSeconds || 120);
      const sourceId = String(body.source || '').trim();

      if (!agentId || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agentId and message are required' }));
        return;
      }

      if (sourceId && sourceId !== 'server') {
        const sources = loadSources();
        const source = sources.find(s => s.id === sourceId);
        if (!source) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown source: ${sourceId}` }));
          return;
        }
        if (source.type === 'local') {
          if (!agentExists(agentId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Agent not found on source ${source.id}: ${agentId}` }));
            return;
          }
          const out = await runAgentTurn({ agentId, message, timeoutSeconds });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...out, sourceId: source.id }));
          return;
        }

        const base = (source.baseUrl || '').replace(/\/$/, '');
        const remoteRes = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, message, timeoutSeconds, source: 'server' }),
        });
        const data = await remoteRes.json();
        res.writeHead(remoteRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...data, sourceId: source.id }));
        return;
      }

      if (!agentExists(agentId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Agent not found on source server: ${agentId}` }));
        return;
      }
      const out = await runAgentTurn({ agentId, message, timeoutSeconds });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...out, sourceId: 'server' }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'chat failed' }));
      return;
    }
  }

  const apiRoutes = new Set(['/api/agents', '/api/crons', '/api/sessions', '/api/issues', '/api/conversations', '/api/forensics', '/api/overview']);
  if (apiRoutes.has(route)) {
    const sources = loadSources();
    const selectedSource = url.searchParams.get('source');

    // Target one source explicitly
    if (selectedSource) {
      const source = sources.find(s => s.id === selectedSource);
      if (!source) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown source: ${selectedSource}` }));
        return;
      }
      let data;
      if (source.type === 'local') {
        data = await localRoute(route, url);
      } else {
        const qs = new URLSearchParams(url.searchParams);
        qs.delete('source');
        qs.set('source', 'server');
        const q = qs.toString();
        data = await fetchFromSource(source, `${route}${q ? `?${q}` : ''}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(withSourceTag(data, source.id)));
      return;
    }

    // Aggregate overview only (phase 1)
    if (route === '/api/overview') {
      const out = {
        // Backward-compatible fields consumed by current UI
        agents: [],
        crons: [],
        sessions: [],
        counts: { agents: 0, crons: 0, activeCrons: 0, sessions: 0 },
        // New multi-source envelope
        sources: [],
      };

      for (const source of sources) {
        const data = source.type === 'local'
          ? await localRoute(route, url)
          : await fetchFromSource(source, route);

        out.sources.push({ sourceId: source.id, name: source.name || source.id, data });

        if (data && typeof data === 'object') {
          const taggedAgents = Array.isArray(data.agents) ? data.agents.map(a => ({ ...a, sourceId: source.id })) : [];
          const taggedCrons = Array.isArray(data.crons) ? data.crons.map(c => ({ ...c, sourceId: source.id })) : [];
          const taggedSessions = Array.isArray(data.sessions) ? data.sessions.map(s => ({ ...s, sourceId: source.id })) : [];

          out.agents.push(...taggedAgents);
          out.crons.push(...taggedCrons);
          out.sessions.push(...taggedSessions);

          if (data.counts) {
            out.counts.agents += data.counts.agents || taggedAgents.length || 0;
            out.counts.crons += data.counts.crons || taggedCrons.length || 0;
            out.counts.activeCrons += data.counts.activeCrons || taggedCrons.filter(c => c.enabled).length || 0;
            out.counts.sessions += data.counts.sessions || taggedSessions.length || 0;
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    // Default to local source when route not aggregate-ready
    const data = await localRoute(route, url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(withSourceTag(data, 'server')));
    return;
  }

  let filePath = route === '/' ? '/index.html' : route;
  filePath = path.join(__dirname, filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

server.listen(PORT, BIND, () => {
  console.log(`Dashboard running at http://${BIND}:${PORT}`);
  console.log(`Sources config: ${SOURCES_PATH}`);
});

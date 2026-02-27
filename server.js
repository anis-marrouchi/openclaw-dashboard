const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Configuration (via env vars or defaults) ---
const PORT = parseInt(process.env.DASHBOARD_PORT || '8090');
const BIND = process.env.DASHBOARD_BIND || '127.0.0.1';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || path.join(process.env.HOME, '.openclaw/openclaw.json');
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com/api/v4';
const GITLAB_PROJECTS = (process.env.GITLAB_PROJECTS || '').split(',').filter(Boolean);

// --- Helpers ---
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
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
  try {
    const p = path.join(path.dirname(CONFIG_PATH), 'cron/jobs.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(data)) return data;
    return data.jobs || data.entries || [];
  } catch { return []; }
}

function getSessions() {
  try {
    const baseDir = path.join(path.dirname(CONFIG_PATH), 'agents');
    const allSessions = [];
    if (!fs.existsSync(baseDir)) return [];
    const agentDirs = fs.readdirSync(baseDir);
    for (const agentDir of agentDirs) {
      const sessFile = path.join(baseDir, agentDir, 'sessions', 'sessions.json');
      if (!fs.existsSync(sessFile)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
        for (const [key, meta] of Object.entries(data)) {
          allSessions.push({ key, agentId: agentDir, ...meta });
        }
      } catch {}
    }
    allSessions.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
    return allSessions.slice(0, 50);
  } catch { return []; }
}

async function fetchGitlab(urlPath) {
  if (!GITLAB_TOKEN) return [];
  return new Promise((resolve, reject) => {
    const url = new URL(GITLAB_URL + urlPath);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    mod.get(url, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

async function fetchGitlabIssues() {
  if (!GITLAB_TOKEN || GITLAB_PROJECTS.length === 0) return [];
  const all = [];
  for (const projEntry of GITLAB_PROJECTS) {
    const [id, name] = projEntry.split(':');
    try {
      const issues = await fetchGitlab(`/projects/${id}/issues?state=opened&per_page=100`);
      if (Array.isArray(issues)) {
        issues.forEach(i => all.push({
          id: i.id, iid: i.iid, title: i.title, state: i.state,
          labels: i.labels || [], assignee: i.assignee?.username || null,
          project: name || `Project ${id}`, projectId: parseInt(id),
          webUrl: i.web_url, createdAt: i.created_at, updatedAt: i.updated_at,
        }));
      }
    } catch {}
  }
  return all;
}

function getConversations(agentId, limit = 50) {
  const baseDir = path.join(path.dirname(CONFIG_PATH), 'agents', agentId, 'sessions');
  if (!fs.existsSync(baseDir)) return { agent: agentId, sessions: [] };
  const indexPath = path.join(baseDir, 'sessions.json');
  if (!fs.existsSync(indexPath)) return { agent: agentId, sessions: [] };

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const sessions = [];

  for (const [key, meta] of Object.entries(index)) {
    const sessionId = meta.sessionId;
    if (!sessionId) continue;
    const jsonlPath = path.join(baseDir, sessionId + '.jsonl');
    if (!fs.existsSync(jsonlPath)) continue;
    try {
      const raw = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = raw.split('\n').filter(Boolean);
      const messages = [];
      const start = Math.max(0, lines.length - limit);
      for (let i = start; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type !== 'message') continue;
          const msg = entry.message || {};
          if (msg.role === 'user' || msg.role === 'assistant') {
            const content = msg.content;
            const text = typeof content === 'string' ? content :
              Array.isArray(content) ? content.filter(c=>c.type==='text').map(c=>c.text).join('') : '';
            if (text && text.length > 0 && !text.startsWith('[System')) {
              messages.push({ role: msg.role, text: text.substring(0, 500), ts: entry.timestamp || null });
            }
          }
        } catch {}
      }
      if (messages.length > 0) {
        sessions.push({ key, sessionId, updatedAt: meta.updatedAt || null, messageCount: lines.length, messages: messages.slice(-limit) });
      }
    } catch {}
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { agent: agentId, sessions: sessions.slice(0, 10) };
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (route === '/api/agents') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getAgents())); return; }
  if (route === '/api/crons') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getCrons())); return; }
  if (route === '/api/sessions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getSessions())); return; }
  if (route === '/api/issues') {
    try { const issues = await fetchGitlabIssues(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(issues)); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (route === '/api/conversations') {
    const agentId = url.searchParams.get('agent') || 'main';
    const limit = parseInt(url.searchParams.get('limit') || '50');
    try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getConversations(agentId, limit))); }
    catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (route === '/api/overview') {
    const agents = getAgents(); const crons = getCrons(); const sessions = getSessions();
    let issues = [];
    try { issues = await fetchGitlabIssues(); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, crons, sessions, issues, counts: { agents: agents.length, crons: crons.length, activeCrons: crons.filter(c => c.enabled).length, sessions: sessions.length, issues: issues.length } }));
    return;
  }

  // Static files
  let filePath = route === '/' ? '/index.html' : route;
  filePath = path.join(__dirname, filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

server.listen(PORT, BIND, () => {
  console.log(`Dashboard running at http://${BIND}:${PORT}`);
});

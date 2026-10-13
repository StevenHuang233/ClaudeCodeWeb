'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { config, validateCwd } = require('./src/config');
const { Session, listHistory } = require('./src/session');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSIONS = new Map();
const SSE_CLIENTS = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------- 工具函数 ------------------------------- */

function sendJSON(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!config.token) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const direct = req.headers['x-ccweb-token'] || '';
  // EventSource 无法自定义请求头，额外允许通过 query 传 token
  let query = '';
  try {
    query = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch (err) {
    query = '';
  }
  return bearer === config.token || direct === config.token || query === config.token;
}

function broadcast(sessionId, evt) {
  const payload = `data: ${JSON.stringify({ sessionId, event: evt })}\n\n`;
  for (const client of SSE_CLIENTS) {
    if (client.sessionId && client.sessionId !== sessionId) continue;
    try {
      client.res.write(payload);
    } catch (err) {
      SSE_CLIENTS.delete(client);
    }
  }
}

function attachSession(session) {
  session.on('event', (evt) => broadcast(session.id, evt));
  SESSIONS.set(session.id, session);
}

function getSession(req, res, url) {
  const m = String(url.pathname || '').match(/^\/api\/sessions\/([\w-]+)/);
  if (!m) return null;
  const s = SESSIONS.get(m[1]);
  if (!s) sendJSON(res, 404, { error: '会话不存在' });
  return s || null;
}

/* -------------------------------- 静态资源 ------------------------------- */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* --------------------------------- 路由 --------------------------------- */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, sessions: SESSIONS.size, pid: process.pid });
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendJSON(res, 200, {
      cli: config.cli,
      defaultCwd: config.defaultCwd,
      defaultModel: config.defaultModel,
      cheapestModel: config.cheapestModel,
      permissionMode: config.permissionMode,
      permissionModes: config.permissionModes,
      models: config.gatewayModels.models,
      modelsSource: config.gatewayModels.source,
      modelsFetchedAt: config.gatewayModels.fetchedAt,
      allowedRoots: config.allowedRoots,
      tokenRequired: !!config.token,
    });
  }

  if (pathname === '/api/history' && method === 'GET') {
    const cwd = url.searchParams.get('cwd') || config.defaultCwd;
    const check = validateCwd(cwd);
    if (!check.ok) return sendJSON(res, 400, { error: check.error });
    return sendJSON(res, 200, { items: listHistory(config.tclaudeHome, check.cwd) });
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    return sendJSON(res, 200, { items: Array.from(SESSIONS.values()).map((s) => s.toJSON()) });
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    if (config.readOnly) return sendJSON(res, 403, { error: '服务运行在只读模式（CCWEB_READ_ONLY=1）' });
    if (SESSIONS.size >= config.maxSessions) {
      return sendJSON(res, 429, { error: `会话数已达上限 ${config.maxSessions}` });
    }
    const body = await readBody(req);
    const check = validateCwd(body.cwd || config.defaultCwd);
    if (!check.ok) return sendJSON(res, 400, { error: check.error });

    const model = String(body.model || config.defaultModel);
    const permissionMode = String(body.permissionMode || config.permissionMode);
    if (!config.permissionModes.includes(permissionMode)) {
      return sendJSON(res, 400, { error: `不支持的 permission mode: ${permissionMode}` });
    }

    const session = new Session({
      cli: config.cli,
      cwd: check.cwd,
      model,
      permissionMode,
      resumeFrom: body.resumeFrom || null,
      title: body.title || null,
    });
    attachSession(session);
    session.start();
    return sendJSON(res, 201, { session: session.toJSON() });
  }

  if (pathname === '/api/sessions' && method === 'DELETE') {
    for (const s of SESSIONS.values()) s.stop();
    SESSIONS.clear();
    return sendJSON(res, 200, { ok: true });
  }

  const s = getSession(req, res, url);
  if (!s) return;

  if (pathname.endsWith('/events') && method === 'GET') {
    return openSSE(req, res, s);
  }

  if (method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJSON(res, 200, {
      session: s.toJSON(),
      events: s.events.filter((e) => e._seq >= since),
    });
  }

  if (pathname.endsWith('/messages') && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJSON(res, 400, { error: '消息为空' });
    if (config.readOnly) return sendJSON(res, 403, { error: '只读模式' });
    try {
      s.send(text);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 202, { ok: true });
  }

  if (pathname.endsWith('/control') && method === 'POST') {
    const body = await readBody(req);
    if (!body.requestId) return sendJSON(res, 400, { error: '缺少 requestId' });
    try {
      s.respondControl(body.requestId, body.behavior === 'allow' ? 'allow' : 'deny', body.message, body.updatedInput);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 202, { ok: true });
  }

  if (pathname.endsWith('/interrupt') && method === 'POST') {
    try {
      s.interrupt();
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 202, { ok: true });
  }

  if (pathname.endsWith('/permission-mode') && method === 'POST') {
    const body = await readBody(req);
    const mode = String(body.mode || '');
    if (!config.permissionModes.includes(mode)) return sendJSON(res, 400, { error: `不支持的 mode: ${mode}` });
    try {
      s.setPermissionMode(mode);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
    return sendJSON(res, 202, { ok: true });
  }

  if (method === 'DELETE') {
    s.stop();
    SESSIONS.delete(s.id);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: 'Method Not Allowed' });
}

function openSSE(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ session: session.toJSON() })}\n\n`);

  const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
  for (const evt of session.events) {
    if (evt._seq < since) continue;
    res.write(`data: ${JSON.stringify({ sessionId: session.id, event: evt })}\n\n`);
  }

  const client = { res, sessionId: session.id };
  SSE_CLIENTS.add(client);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      /* ignore */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    SSE_CLIENTS.delete(client);
  });
}

/* --------------------------------- 启动 --------------------------------- */

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    return sendJSON(res, 401, { error: '未授权：请提供 CCWEB_TOKEN' });
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`ClaudeCodeWeb 已启动: http://${shown}:${config.port}`);
  console.log(`CLI: ${config.cli} | 默认模型(调试最便宜): ${config.defaultModel}`);
  console.log(`默认工作目录: ${config.defaultCwd}`);
  if (!config.token) {
    console.log('提示: 仅监听 ' + config.host + '，如需对外暴露请设置 CCWEB_TOKEN');
  }
});

function shutdown() {
  for (const s of SESSIONS.values()) s.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

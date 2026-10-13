'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { config, validateCwd } = require('./src/config');
const { Session, listHistory } = require('./src/session');
const local = require('./src/local');
const { LocalSession } = require('./src/localSession');

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

  /* 审视历史会话：只读地把记录渲染出来，不起任何进程 */
  if (pathname === '/api/history/preview' && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) return sendJSON(res, 400, { error: '缺少 sessionId' });
    const cwd = url.searchParams.get('cwd') || config.defaultCwd;
    const check = validateCwd(cwd);

    let file = check.ok ? local.findTranscript(check.cwd, sessionId) : null;
    if (!file) {
      const m = local.listManaged().find((x) => x.sessionId === sessionId || x.name === sessionId);
      if (m && m.logPath && fs.existsSync(m.logPath)) file = m.logPath;
    }
    if (!file || !fs.existsSync(file)) return sendJSON(res, 404, { error: '找不到该会话的记录文件' });

    // 只读最后 4MB，避免大文件把内存吃满
    const size = fs.statSync(file).size;
    const MAX = 4 * 1024 * 1024;
    let raw;
    if (size > MAX) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(MAX);
      fs.readSync(fd, buf, 0, MAX, size - MAX);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      raw = raw.slice(raw.indexOf('\n') + 1);
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }

    const events = [];
    let seq = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(Object.assign({}, JSON.parse(t), { _seq: seq++, _ts: Date.now() }));
      } catch (err) {
        /* 跳过坏行 */
      }
    }
    return sendJSON(res, 200, { file, sessionId, total: events.length, events: events.slice(-800) });
  }

  /* ---------------- 本地已在跑的 tc：发现 / 启动 / 停止 ---------------- */

  if (pathname === '/api/local-sessions' && method === 'GET') {
    const active = local.listActive();

    // 历史 = 我们托管过但已结束的会话 + Claude Code 自己留在 ~/.tclaude/projects 下的会话
    const archived = local.listArchived();
    const cwd = url.searchParams.get('cwd') || config.defaultCwd;
    let cliHistory = [];
    const check = validateCwd(cwd);
    if (check.ok) {
      cliHistory = listHistory(config.tclaudeHome, check.cwd, 30).map((h) => ({
        sessionId: h.sessionId,
        cwd: h.cwd,
        timestamp: h.timestamp,
        source: 'cli',
        name: null,
        model: null,
      }));
    }

    const activeIds = new Set(active.map((m) => m.sessionId).filter(Boolean));
    const seen = new Set();
    const history = [];
    for (const h of archived.concat(cliHistory)) {
      if (!h.sessionId || activeIds.has(h.sessionId) || seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      history.push(h);
    }
    history.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

    // 只列能真正接管的（在 tmux 窗格里的）。不在 tmux 里的只能看个数，避免刷屏
    const allForeign = local.listForeign();
    const foreign = allForeign.filter((f) => f.attachable);

    return sendJSON(res, 200, {
      active,
      history: history.slice(0, 40),
      foreign,
      unattachable: allForeign.length - foreign.length,
      tmuxAvailable: local.tmuxAvailable(),
      runDir: config.runDir,
    });
  }

  if (pathname === '/api/local-sessions' && method === 'POST') {
    if (config.readOnly) return sendJSON(res, 403, { error: '只读模式' });
    const body = await readBody(req);
    const check = validateCwd(body.cwd || config.defaultCwd);
    if (!check.ok) return sendJSON(res, 400, { error: check.error });
    try {
      const started = local.startManaged({
        name: body.name,
        cwd: check.cwd,
        model: String(body.model || config.defaultModel),
        permissionMode: String(body.permissionMode || config.permissionMode),
        resumeFrom: body.resumeFrom || null,
      });
      return sendJSON(res, 201, Object.assign({ resumeFrom: body.resumeFrom || null }, started));
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  const stopMatch = pathname.match(/^\/api\/local-sessions\/([\w.@-]+)$/);
  if (stopMatch && method === 'DELETE') {
    // purge=1 彻底删除（不进归档），默认只是结束并归档
    const purge = url.searchParams.get('purge') === '1';
    return sendJSON(res, 200, purge ? local.purgeManaged(stopMatch[1]) : local.stopManaged(stopMatch[1]));
  }

  const delHist = pathname.match(/^\/api\/history\/([\w.:-]+)$/);
  if (delHist && method === 'DELETE') {
    const cwd = url.searchParams.get('cwd') || config.defaultCwd;
    return sendJSON(res, 200, local.deleteHistory(delHist[1], cwd));
  }

  /* ------------------------------------------------------------------ */

  if (pathname === '/api/sessions' && method === 'POST') {
    if (config.readOnly) return sendJSON(res, 403, { error: '服务运行在只读模式（CCWEB_READ_ONLY=1）' });
    if (SESSIONS.size >= config.maxSessions) {
      return sendJSON(res, 429, { error: `会话数已达上限 ${config.maxSessions}` });
    }
    const body = await readBody(req);

    // 绑定本地已经在跑的 tc，而不是自己起一个
    if (body.source && body.source.kind === 'managed') {
      const items = local.listManaged();
      const meta = items.find((m) => m.name === body.source.name);
      if (!meta) return sendJSON(res, 404, { error: `找不到本地会话 ${body.source.name}` });
      if (!meta.alive) return sendJSON(res, 400, { error: `本地会话 ${body.source.name} 已退出` });

      // 原生 TUI：终端是原生界面，Web 读 Claude Code 的会话记录，两边实时同步
      if (meta.mode === 'tui') {
        const transcript = meta.transcriptPath || local.findTranscript(meta.cwd, meta.sessionId);
        if (!transcript) return sendJSON(res, 400, { error: '还没找到该会话的记录文件，稍等几秒再试' });
        const t = new LocalSession({
          kind: 'tui',
          name: meta.name,
          transcriptPath: transcript,
          tmuxTarget: meta.tmuxTarget || `${meta.name}:0.0`,
          pid: meta.pid,
          cwd: meta.cwd,
          model: meta.model,
          startOffset: meta.startOffset || 0,
        });
        attachSession(t);
        t.start();
        return sendJSON(res, 201, { session: t.toJSON() });
      }

      const s = new LocalSession({
        kind: 'managed',
        name: meta.name,
        logPath: meta.logPath,
        fifoPath: meta.fifoPath,
        pid: meta.pid,
        cwd: meta.cwd,
        model: meta.model,
      });
      attachSession(s);
      s.start();
      return sendJSON(res, 201, { session: s.toJSON() });
    }

    if (body.source && body.source.kind === 'mirror') {
      if (!local.tmuxAvailable()) return sendJSON(res, 400, { error: '本机没有 tmux，无法镜像' });
      const target = String(body.source.tmuxTarget || '');
      if (!/^[\w.@:=%-]+$/.test(target)) return sendJSON(res, 400, { error: '非法 tmux target' });
      const s = new LocalSession({
        kind: 'mirror',
        tmuxTarget: target,
        paneId: body.source.paneId || null,
        pid: body.source.pid || null,
        cwd: body.source.cwd || null,
      });
      attachSession(s);
      s.start();
      return sendJSON(res, 201, { session: s.toJSON() });
    }

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

  if (pathname.endsWith('/keys') && method === 'POST') {
    const body = await readBody(req);
    const key = String(body.key || '');
    if (typeof s.sendKey !== 'function') return sendJSON(res, 400, { error: '仅镜像会话支持按键' });
    try {
      s.sendKey(key);
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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // 静态资源不含秘密，不设防；令牌只保护 /api/*（否则 ?token= 打开后 CSS/JS 会被 401）
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) {
      return sendJSON(res, 401, { error: '未授权：请提供 CCWEB_TOKEN' });
    }
    handleApi(req, res, url).catch((err) => {
      sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

// 安全兜底：对外暴露时必须有令牌，否则拒绝启动
const PUBLIC_BIND = config.host === '0.0.0.0' || config.host === '::';
if (PUBLIC_BIND && !config.token) {
  console.error('拒绝启动：CCWEB_HOST=0.0.0.0 时必须设置 CCWEB_TOKEN（该服务可驱动 AI 执行命令）');
  process.exit(1);
}

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

'use strict';

const state = {
  cfg: null,
  token: localStorage.getItem('ccweb.token') || '',
  sessions: [],
  activeId: null,
  events: [],
  es: null,
  boundName: null,
};

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');

/* ------------------------------ 请求封装 ------------------------------ */

function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (state.token) {
    opts.headers.Authorization = `Bearer ${state.token}`;
    opts.headers['X-CCWeb-Token'] = state.token;
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = state.token ? `${path}${sep}token=${encodeURIComponent(state.token)}` : path;
  return fetch(url, opts).then(async (res) => {
    if (res.status === 401) {
      const t = prompt('该服务设置了访问令牌（CCWEB_TOKEN），请输入：');
      if (t) {
        state.token = t.trim();
        localStorage.setItem('ccweb.token', state.token);
        return api(path, options);
      }
      throw new Error('未授权');
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      body = null;
    }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  });
}

/* ------------------------------ 安全渲染 ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 极简 Markdown：先转义再处理代码块/行内代码/粗体，杜绝 XSS */
function md(text) {
  const src = esc(text);
  const out = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out.push(inline(src.slice(last, m.index)));
    out.push(`<pre><code>${m[2].replace(/\n$/, '')}</code></pre>`);
    last = m.index + m[0].length;
  }
  out.push(inline(src.slice(last)));
  return out.join('');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

function pretty(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

/* --------------------------- 事件 -> 展示块 --------------------------- */

function buildBlocks(events) {
  const blocks = [];
  const byKey = new Map();
  const toolResults = new Map();

  function upsert(key, factory) {
    let b = byKey.get(key);
    if (!b) {
      b = factory();
      b.key = key;
      byKey.set(key, b);
      blocks.push(b);
    }
    return b;
  }

  for (const e of events) {
    if (!e || !e.type) continue;

    if (e.type === 'user') {
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        // 工具结果以 user 消息回传
        let onlyResults = true;
        for (const c of content) {
          if (c && c.type === 'tool_result') {
            toolResults.set(c.tool_use_id, c);
          } else {
            onlyResults = false;
          }
        }
        if (onlyResults && content.length) continue;
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (text.trim()) upsert(`u:${e._seq}`, () => ({ kind: 'user', text }));
      } else if (typeof content === 'string' && content.trim()) {
        upsert(`u:${e._seq}`, () => ({ kind: 'user', text: content }));
      }
      continue;
    }

    if (e.type === 'assistant') {
      const msg = e.message || {};
      const b = upsert(`a:${msg.id || e.uuid || e._seq}`, () => ({ kind: 'assistant', content: [] }));
      b.content = Array.isArray(msg.content) ? msg.content : [];
      b.model = msg.model || b.model;
      continue;
    }

    if (e.type === 'tool_use' && e.name) {
      upsert(`t:${e.id}`, () => ({ kind: 'tool', name: e.name, input: e.input, result: null }));
      continue;
    }

    if (e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool') {
      upsert(`p:${e.request_id}`, () => ({
        kind: 'perm',
        requestId: e.request_id,
        name: e.request.tool_name || 'tool',
        input: e.request.input,
        answered: false,
      }));
      continue;
    }

    if (e.type === 'result') {
      upsert(`r:${e._seq}`, () => ({
        kind: 'result',
        cost: e.total_cost_usd || 0,
        durationMs: e.duration_ms || 0,
        turns: e.num_turns || 0,
        usage: e.usage || null,
        stopReason: e.stop_reason || '',
      }));
      continue;
    }

    if (e.type === 'system' && e.subtype === 'init') {
      upsert('init', () => ({
        kind: 'note',
        level: 'ok',
        text: `已连接 ${e.claude_code_version || ''} · 模型 ${e.model || ''} · 工具 ${(e.tools || []).length} 个`,
      }));
      continue;
    }

    if (e.type === 'ccweb' && e.subtype === 'terminal') {
      const b = upsert('terminal', () => ({ kind: 'terminal', text: '' }));
      b.text += e.data || '';
      continue;
    }

    if (e.type === 'ccweb' && e.subtype === 'exit') {
      upsert('exit', () => ({ kind: 'note', level: 'err', text: `CLI 进程已退出 (code=${e.code})` }));
      continue;
    }
    if (e.type === 'ccweb' && (e.subtype === 'spawn_error' || e.subtype === 'process_error')) {
      upsert(`err:${e._seq}`, () => ({ kind: 'note', level: 'err', text: e.message || '进程错误' }));
    }
  }

  // 把工具结果回填到工具卡片
  for (const b of blocks) {
    if (b.kind === 'assistant') {
      for (const c of b.content) {
        if (c && c.type === 'tool_use' && toolResults.has(c.id)) c._result = toolResults.get(c.id);
      }
    }
    if (b.kind === 'tool' && toolResults.has(b.id)) b.result = toolResults.get(b.id);
  }
  return blocks;
}

/* -------------------------------- 渲染 -------------------------------- */

function toolResultText(res) {
  if (!res) return null;
  const c = res.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) => (typeof x === 'string' ? x : x && x.text ? x.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return pretty(c);
}

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '');
}

function render() {
  const blocks = buildBlocks(state.events);
  const frag = document.createDocumentFragment();

  for (const b of blocks) {
    const div = document.createElement('div');

    if (b.kind === 'user') {
      div.className = 'msg user';
      div.innerHTML = `<div class="bubble">${esc(b.text)}</div>`;
    } else if (b.kind === 'assistant') {
      div.className = 'msg assistant';
      const parts = [];
      for (const c of b.content || []) {
        if (!c) continue;
        if (c.type === 'text') {
          parts.push(`<div>${md(c.text)}</div>`);
        } else if (c.type === 'thinking' || c.type === 'redacted_thinking') {
          parts.push(
            `<details class="thinking"><summary>思考过程</summary><div>${esc(
              c.thinking || c.data || ''
            )}</div></details>`
          );
        } else if (c.type === 'tool_use') {
          const res = toolResultText(c._result);
          const err = c._result && c._result.is_error;
          parts.push(
            `<div class="card tool">
               <div class="head"><span class="name">${esc(c.name)}</span><span class="badge">tool_use</span></div>
               <div class="body"><pre><code>${esc(pretty(c.input))}</code></pre></div>
               ${res ? `<div class="body"><pre><code>${esc(res.slice(0, 8000))}${err ? '\n[执行出错]' : ''}</code></pre></div>` : ''}
             </div>`
          );
        }
      }
      div.innerHTML =
        `<div class="who">assistant${b.model ? ' · ' + esc(b.model) : ''}</div>` +
        `<div class="bubble">${parts.join('') || '<span class="chip">等待输出…</span>'}</div>`;
    } else if (b.kind === 'tool') {
      div.className = 'msg assistant';
      const res = toolResultText(b.result);
      div.innerHTML = `<div class="card tool">
          <div class="head"><span class="name">${esc(b.name)}</span><span class="badge">tool_use</span></div>
          <div class="body"><pre><code>${esc(pretty(b.input))}</code></pre></div>
          ${res ? `<div class="body"><pre><code>${esc(res.slice(0, 8000))}</code></pre></div>` : ''}
        </div>`;
    } else if (b.kind === 'perm') {
      div.className = 'msg assistant';
      div.innerHTML = `<div class="card perm">
          <div class="head"><span class="name">需要授权：${esc(b.name)}</span><span class="badge">permission</span></div>
          <div class="body"><pre><code>${esc(pretty(b.input))}</code></pre></div>
          <div class="actions">
            <button class="primary" data-allow="${esc(b.requestId)}">允许</button>
            <button class="ghost" data-deny="${esc(b.requestId)}">拒绝</button>
          </div>
        </div>`;
    } else if (b.kind === 'terminal') {
      div.className = 'msg assistant';
      div.innerHTML = `<div class="who">终端镜像（tmux）</div>
        <pre class="terminal">${esc(stripAnsi(b.text).slice(-60000))}</pre>`;
    } else if (b.kind === 'note') {
      div.innerHTML = `<span class="chip ${b.level === 'err' ? 'err' : 'ok'}">${esc(b.text)}</span>`;
    } else if (b.kind === 'result') {
      const u = b.usage || {};
      div.innerHTML = `<span class="chip">完成 · ${b.turns} 轮 · ${(b.durationMs / 1000).toFixed(1)}s · $${b.cost.toFixed(
        4
      )} · in ${u.input_tokens || 0} / out ${u.output_tokens || 0}</span>`;
    }

    frag.appendChild(div);
  }

  if (!blocks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '发一条消息开始。调试阶段默认用最便宜的模型。';
    frag.appendChild(empty);
  }

  messagesEl.replaceChildren(frag);
  messagesEl.querySelectorAll('[data-allow]').forEach((el) => {
    el.onclick = () => answerPerm(el.getAttribute('data-allow'), 'allow');
  });
  messagesEl.querySelectorAll('[data-deny]').forEach((el) => {
    el.onclick = () => answerPerm(el.getAttribute('data-deny'), 'deny');
  });
}

/* ------------------------------- 会话管理 ------------------------------- */

async function refreshSessions() {
  const data = await api('/api/sessions');
  state.sessions = data.items || [];
  renderSessionList();
  const active = state.sessions.find((s) => s.id === state.activeId);
  updateHeader(active);
}

function renderSessionList() {
  const el = $('session-list');
  el.replaceChildren();
  for (const s of state.sessions) {
    const d = document.createElement('div');
    d.className = 'item' + (s.id === state.activeId ? ' active' : '');
    d.innerHTML = `<div class="t"><b>${esc(s.title || '会话')}</b><span>${esc(s.status)}</span></div>
      <div class="s">${esc(s.model)} · ${esc(s.cwd)}</div>`;
    d.onclick = () => selectSession(s.id);
    el.appendChild(d);
  }
}

function updateHeader(active) {
  if (!active) {
    $('chat-title').textContent = '未选择会话';
    $('chat-meta').textContent = '';
    return;
  }
  $('chat-title').textContent = active.title || '会话';
  const r = active.lastResult;
  $('chat-meta').innerHTML = [
    esc(active.cwd),
    esc(active.model),
    active.cliSessionId ? `session ${esc(String(active.cliSessionId).slice(0, 8))}` : null,
    active.source && active.source.name ? `终端: tmux attach -t ${esc(active.source.name)}` : null,
    r ? `$${r.cost.toFixed(4)}` : null,
    esc(active.status),
  ]
    .filter(Boolean)
    .join(' · ');
}

function openStream(id) {
  if (state.es) state.es.close();
  const q = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  const es = new EventSource(`/api/sessions/${id}/events${q}`);
  es.onmessage = (msg) => {
    try {
      const payload = JSON.parse(msg.data);
      state.events.push(payload.event);
      render();
      if (payload.event && payload.event.type === 'result') refreshSessions();
    } catch (err) {
      /* ignore */
    }
  };
  es.onerror = () => {
    /* EventSource 会自动重连 */
  };
  state.es = es;
}

async function selectSession(id) {
  state.activeId = id;
  const data = await api(`/api/sessions/${id}`);
  state.events = data.events || [];
  const isMirror = data.session && data.session.kind === 'mirror';
  $('key-row').hidden = !isMirror;
  render();
  openStream(id);
  await refreshSessions();
}

async function createSession(resumeFrom) {
  const body = {
    cwd: $('inp-cwd').value.trim() || (state.cfg && state.cfg.defaultCwd),
    model: $('sel-model').value,
    permissionMode: $('sel-perm').value,
  };
  if (resumeFrom) body.resumeFrom = resumeFrom;
  const data = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  state.events = [];
  render();
  await selectSession(data.session.id);
}

async function answerPerm(requestId, behavior) {
  await api(`/api/sessions/${state.activeId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, behavior }),
  });
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  input.value = '';
  input.style.height = 'auto';
  try {
    await api(`/api/sessions/${state.activeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    alert(err.message);
  }
}

/* ---------------------------- 本机 tc 发现/绑定 ---------------------------- */

async function bindManaged(name) {
  const data = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { kind: 'managed', name } }),
  });
  state.events = [];
  render();
  await selectSession(data.session.id);
}

async function bindMirror(item) {
  const data = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { kind: 'mirror', tmuxTarget: item.tmux.target, paneId: item.tmux.paneId, pid: item.pid },
    }),
  });
  state.events = [];
  render();
  await selectSession(data.session.id);
}

function tsName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `tc-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 新建 = 起一个 tmux 会话跑 tc，同时 Web 绑定上去，两边永远是同一个进程 */
async function startLocal(options) {
  const opts = options || {};
  const data = await api('/api/local-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: opts.name || tsName(),
      cwd: opts.cwd || $('inp-cwd').value.trim() || (state.cfg && state.cfg.defaultCwd),
      model: opts.model || $('sel-model').value,
      permissionMode: $('sel-perm').value,
      resumeFrom: opts.resumeFrom || null,
    }),
  });
  await loadLocal();
  await bindManaged(data.name);
}

async function stopLocal(name) {
  if (!confirm(`结束本地会话 ${name}？（会杀掉对应的 tc 进程）`)) return;
  await api(`/api/local-sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadLocal();
}

async function loadLocal() {
  let data;
  try {
    data = await api('/api/local-sessions');
  } catch (err) {
    return;
  }
  const active = data.active || [];
  const history = data.history || [];
  const foreign = data.foreign || [];

  /* 当前对话：终端和 Web 一一对应 */
  const el = $('active-list');
  el.replaceChildren();
  for (const m of active) {
    const d = document.createElement('div');
    const bound = state.boundName === m.name;
    d.className = 'item' + (bound ? ' active' : '');
    d.innerHTML = `<div class="t"><b>${esc(m.name)}</b><span>${bound ? 'Web 已接入' : '运行中'}</span></div>
      <div class="s">${esc(m.model || '')} · ${esc(m.cwd || '')}${m.mode === 'tui' ? ' · 原生 TUI（Web 镜像）' : ''}</div>
      <div class="s cmd">${esc(m.attachCmd || '（无 tmux）')}</div>`;
    d.title = m.mode === 'tui'
      ? '原生交互界面：Web 只能镜像屏幕，没有工具详情'
      : '点击在 Web 打开这个对话（与终端同一个进程）';
    d.onclick = () => bindManaged(m.name);
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = '结束';
    btn.onclick = (ev) => {
      ev.stopPropagation();
      stopLocal(m.name);
    };
    d.appendChild(btn);
    if (m.attachCmd) {
      const cp = document.createElement('button');
      cp.className = 'ghost small';
      cp.textContent = '复制终端命令';
      cp.title = `复制「${m.attachCmd}」，在 CodeBuddy 的终端里粘贴执行即可看到同一个对话`;
      cp.onclick = (ev) => {
        ev.stopPropagation();
        navigator.clipboard.writeText(m.attachCmd).then(
          () => (cp.textContent = '已复制 ✓'),
          () => alert('复制失败，请手动选中：' + m.attachCmd)
        );
        setTimeout(() => (cp.textContent = '复制终端命令'), 1500);
      };
      d.appendChild(cp);
    }
    el.appendChild(d);
  }
  if (!active.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = '暂无。点上方「新建对话」，或在终端跑 scripts/tc-run.js';
    el.appendChild(p);
  }

  /* 历史记录：点击恢复 = 新开一个终端会话来跑它 */
  const hl = $('history-list');
  hl.replaceChildren();
  for (const h of history) {
    const d = document.createElement('div');
    d.className = 'item';
    const when = String(h.timestamp || '').slice(0, 16).replace('T', ' ');
    d.innerHTML = `<div class="t"><b>${esc(String(h.sessionId).slice(0, 8))}</b><span>${esc(when)}</span></div>
      <div class="s">${h.source === 'managed' && h.name ? esc(h.name) + ' · ' : ''}${esc(h.cwd || '')}</div>`;
    d.title = '点击恢复：会新起一个终端会话（tmux）并接入 Web';
    d.onclick = () =>
      startLocal({
        name: `r-${String(h.sessionId).slice(0, 8)}-${Date.now().toString(36).slice(-4)}`,
        resumeFrom: h.sessionId,
        cwd: h.cwd || undefined,
      });
    hl.appendChild(d);
  }
  if (!history.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = '暂无历史。结束一个对话后它会落到这里';
    hl.appendChild(p);
  }

  const fl = $('foreign-list');
  fl.replaceChildren();
  for (const f of foreign) {
    const d = document.createElement('div');
    d.className = 'item' + (f.attachable ? '' : ' disabled');
    d.innerHTML = `<div class="t"><b>${esc(f.cli)} · pid ${f.pid}</b><span>${
      f.attachable ? '可镜像' : '不可接管'
    }</span></div>
      <div class="s">${esc(f.tmux ? f.tmux.target : f.tty || '')}</div>`;
    d.title = f.attachable ? '点击镜像这个 tmux 窗格' : f.reason || '无法接管';
    if (f.attachable) d.onclick = () => bindMirror(f);
    fl.appendChild(d);
  }
  if (!foreign.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = data.tmuxAvailable ? '没有可接管的（tmux 里没跑 tc）' : '本机没有 tmux';
    fl.appendChild(p);
  }
  if (data.unattachable > 0) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = `另有 ${data.unattachable} 个 tc 不在 tmux 里，无法接管`;
    fl.appendChild(p);
  }
}

/* --------------------------------- 初始化 --------------------------------- */

function fillSelect(el, values, selected) {
  el.replaceChildren();
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v.id || v;
    o.textContent = v.name || v;
    if (o.value === selected) o.selected = true;
    el.appendChild(o);
  }
}

async function boot() {
  state.cfg = await api('/api/config');
  const models = state.cfg.models && state.cfg.models.length ? state.cfg.models : [state.cfg.defaultModel];
  fillSelect($('sel-model'), models, state.cfg.defaultModel);
  fillSelect($('sel-perm'), state.cfg.permissionModes, state.cfg.permissionMode);
  $('inp-cwd').value = state.cfg.defaultCwd;

  const cheap = state.cfg.cheapestModel;
  $('hint').textContent = cheap
    ? `调试默认用最便宜的模型：${cheap}（实测同请求单次约 $0.006）`
    : '';

  $('btn-new').onclick = () => startLocal().catch((err) => alert(err.message));
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };
  $('btn-stop').onclick = async () => {
    if (!state.activeId) return;
    try {
      await api(`/api/sessions/${state.activeId}/interrupt`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('key-row').querySelectorAll('[data-key]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/api/sessions/${state.activeId}/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: el.getAttribute('data-key') }),
        });
      } catch (err) {
        alert(err.message);
      }
    };
  });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('input').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 220) + 'px';
  });
  $('inp-cwd').addEventListener('change', loadLocal);

  state.events = [];
  render();
  await loadLocal();
  setInterval(() => {
    refreshSessions();
    loadLocal();
  }, 5000);
}

boot().catch((err) => {
  document.body.innerHTML = `<div class="empty">初始化失败：${esc(err.message)}</div>`;
});

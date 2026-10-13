'use strict';

const state = {
  cfg: null,
  token: localStorage.getItem('ccweb.token') || '',
  sessions: [],
  activeId: null,
  events: [],
  es: null,
  boundName: null,
  review: null,
};

const $ = (id) => document.getElementById(id);

/**
 * 复制文本。用 http://<IP> 访问时不是安全上下文，navigator.clipboard 不可用，
 * 所以要有 execCommand 回退，再不行就弹窗让用户手动复制。
 */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    ok ? resolve() : reject(new Error('浏览器禁止了自动复制'));
  });
}

/** 安全绑定：元素缺失时只告警，不让整个页面初始化失败 */
function on(id, ev, fn) {
  const el = $(id);
  if (!el) {
    console.warn('[ccweb] 缺少元素 #' + id + '，已跳过绑定 ' + ev);
    return null;
  }
  el.addEventListener(ev, fn);
  return el;
}
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
      // 原生 TUI 不会产生 control_request，计划直接从 tool_use 里认出来
      for (const c of b.content) {
        if (c && c.type === 'tool_use' && c.name === 'ExitPlanMode') {
          const p = upsert(`plan:${c.id}`, () => ({ kind: 'plan', text: '', file: null, requestId: null }));
          if (c.input && c.input.plan) p.text = c.input.plan;
          if (c.input && c.input.planFilePath) p.file = c.input.planFilePath;
        }
      }
      continue;
    }

    if (e.type === 'tool_use' && e.name) {
      upsert(`t:${e.id}`, () => ({ kind: 'tool', name: e.name, input: e.input, result: null }));
      continue;
    }

    if (e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool') {
      const tn = e.request.tool_name || 'tool';
      // 计划审批单独渲染成计划卡片
      if (tn === 'ExitPlanMode') {
        upsert(`plan:${e.request_id}`, () => ({
          kind: 'plan',
          text: (e.request.input && e.request.input.plan) || '',
          requestId: e.request_id,
        }));
        continue;
      }
      upsert(`p:${e.request_id}`, () => ({
        kind: 'perm',
        requestId: e.request_id,
        name: tn,
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

  if (state.review) {
    const bar = document.createElement('div');
    bar.className = 'review-bar';
    bar.innerHTML = `<span>审视模式（只读，未启动任何进程）· 会话 ${esc(
      String(state.review.sessionId).slice(0, 8)
    )} · ${state.review.total} 条记录</span>`;
    const open = document.createElement('button');
    open.className = 'primary small';
    open.textContent = '打开此对话（新终端）';
    open.onclick = () =>
      startLocal({
        name: `r-${String(state.review.sessionId).slice(0, 8)}-${Date.now().toString(36).slice(-4)}`,
        resumeFrom: state.review.sessionId,
        cwd: state.review.cwd || undefined,
      });
    const exit = document.createElement('button');
    exit.className = 'ghost small';
    exit.textContent = '退出审视';
    exit.onclick = exitReview;
    bar.appendChild(open);
    bar.appendChild(exit);
    frag.appendChild(bar);
  }

  if (state.configView) {
    frag.appendChild(buildConfigPanel());
    messagesEl.replaceChildren(frag);
    wireConfigPanel();
    return;
  }

  // 审视模式下禁掉输入
  const ro = !!state.review;
  $('input').disabled = ro;
  $('btn-send').disabled = ro;
  $('btn-stop').disabled = ro;
  const dis = (id, v) => {
    const el = $(id);
    if (el) el.disabled = v;
  };
  dis('chat-model', ro || !state.activeId);
  dis('chat-effort', ro || !state.activeId);
  ($('cmd-row') || { querySelectorAll: () => [] })
    .querySelectorAll('button')
    .forEach((b) => (b.disabled = ro || !state.activeId));

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
    } else if (b.kind === 'plan') {
      div.className = 'msg assistant';
      div.innerHTML = `<div class="card plan">
          <div class="head"><span class="name">实施计划</span><span class="badge">ExitPlanMode</span></div>
          ${b.file ? `<div class="badge">${esc(b.file)}</div>` : ''}
          <div class="body">${md(b.text || '（没有解析到计划内容）')}</div>
          <div class="actions">
            <button class="primary" data-plan-allow="${esc(b.requestId || '')}">批准并实施</button>
            <button class="ghost" data-plan-deny="${esc(b.requestId || '')}">驳回，继续规划</button>
          </div>
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
  messagesEl.querySelectorAll('[data-plan-allow]').forEach((el) => {
    el.onclick = () => decidePlan(el.getAttribute('data-plan-allow'), true);
  });
  messagesEl.querySelectorAll('[data-plan-deny]').forEach((el) => {
    el.onclick = () => decidePlan(el.getAttribute('data-plan-deny'), false);
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
  if (state.review) {
    $('chat-title').textContent = '审视历史会话（只读）';
    $('chat-meta').textContent = `${String(state.review.sessionId).slice(0, 8)} · ${state.review.cwd || ''}`;
    return;
  }
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
  state.review = null;
  state.currentKind = (data.session && data.session.kind) || null;
  state.currentSource = (data.session && data.session.source) || null;
  state.currentSessionId = (data.session && data.session.cliSessionId) || null;
  state.currentCwd = (data.session && data.session.cwd) || null;
  setModelSelects(data.session && data.session.model);
  if (data.session && data.session.permissionMode) $('sel-perm').value = data.session.permissionMode;
  state.planMode = (data.session && data.session.permissionMode) === 'plan';
  updatePlanButton();
  const kind = data.session && data.session.kind;
  $('key-row').hidden = !(kind === 'mirror' || kind === 'tui');
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

async function postMessage(text) {
  return api(`/api/sessions/${state.activeId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** 斜杠命令：原生 TUI 会自己处理；结构化模式只能挑几条做等价操作 */
async function handleSlash(text) {
  if (state.currentKind === 'tui' || state.currentKind === 'mirror') {
    try {
      await postMessage(text);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ');

  if (cmd === 'model') {
    if (!arg) {
      alert('用法：/model <模型名>，例如 /model claude-haiku-4-5');
      return;
    }
    if (!confirm(`当前是结构化模式，无法就地切换模型。\n要用「${arg}」重开本对话吗？（保留上下文）`)) return;
    await startLocal({
      name: `m-${Date.now().toString(36).slice(-5)}`,
      resumeFrom: state.currentSessionId || undefined,
      model: arg,
      cwd: state.currentCwd || undefined,
    });
    return;
  }

  if (cmd === 'compact' || cmd === 'usage' || cmd === 'doctor') {
    alert(`「/${cmd}」只有原生 TUI 模式支持（会弹出交互面板）。\n当前是结构化模式。`);
    return;
  }

  if (cmd === 'clear') {
    if (!confirm('结构化模式无法就地清空上下文。要开一个全新的对话吗？')) return;
    await startLocal({ cwd: state.currentCwd || undefined });
    return;
  }

  alert(`「/${cmd}」只有原生 TUI 模式支持。\n当前是结构化模式，斜杠命令会被当成普通消息发给模型。`);
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  input.value = '';
  input.style.height = 'auto';
  if (text.startsWith('/')) {
    await handleSlash(text);
    return;
  }
  try {
    await postMessage(text);
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

/** 切换当前会话的权限模式：结构化走协议指令，原生 TUI 只能 Shift+Tab */
async function applyPermissionMode(mode) {
  if (!mode || !state.activeId || state.review) return;
  try {
    await api(`/api/sessions/${state.activeId}/permission-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  } catch (err) {
    alert(err.message);
  }
  await refreshSessions();
}

/**
 * 批准 / 驳回计划。
 * 有挂起的控制请求就回 control_response；没有（原生 TUI 的确认框不进事件流）
 * 就退化为按键：Enter = 确认，Esc = 取消。
 */
async function decidePlan(requestId, approve) {
  if (!state.activeId) return;
  try {
    if (requestId) {
      await api(`/api/sessions/${state.activeId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, behavior: approve ? 'allow' : 'deny' }),
      });
    } else {
      await api(`/api/sessions/${state.activeId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: approve ? 'Enter' : 'Escape' }),
      });
    }
  } catch (err) {
    alert(err.message);
  }
}

/** 一键进入 / 退出计划模式 */
async function togglePlanMode() {
  if (!state.activeId) return alert('先打开一个对话');
  const on = !state.planMode;
  try {
    await api(`/api/sessions/${state.activeId}/plan-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    state.planMode = on;
    updatePlanButton();
    await refreshSessions();
  } catch (err) {
    alert(err.message);
  }
}

function updatePlanButton() {
  const b = $('btn-plan');
  if (!b) return;
  b.textContent = state.planMode ? '退出计划模式' : '进入计划模式';
  b.title = state.planMode
    ? '当前处于计划模式：只规划不改文件，实施前会出计划等你批准'
    : '进入计划模式：让模型先给方案，批准后再动手';
}

/** 两个模型下拉框保持同步 */
function setModelSelects(value) {
  if (!value) return;
  for (const id of ['sel-model', 'chat-model']) {
    const el = $(id);
    if (el && Array.from(el.options).some((o) => o.value === value)) el.value = value;
  }
}

/** 切换当前会话的模型；不支持就地切换的（结构化模式）改为用新模型重开 */
async function changeModel(model) {
  if (!model) return;
  setModelSelects(model);
  if (!state.activeId || state.review) return; // 没有活动会话时，只作为新建对话的默认值
  try {
    await api(`/api/sessions/${state.activeId}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    await refreshSessions();
    return;
  } catch (err) {
    const reopen = confirm(
      `${err.message}\n\n要用「${model}」重开本对话吗？\n会新起一个终端会话并保留上下文。`
    );
    const resumeFrom = state.currentSessionId || (state.currentSource && state.currentSource.name);
    if (reopen && resumeFrom) {
      await startLocal({
        name: `m-${Date.now().toString(36).slice(-5)}`,
        resumeFrom,
        model,
        cwd: state.currentCwd || undefined,
      });
    } else {
      await refreshSessions(); // 还原下拉框
    }
  }
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

/** 审视：只读渲染一段历史，不起任何进程 */
async function previewHistory(h) {
  const q = `sessionId=${encodeURIComponent(h.sessionId)}&cwd=${encodeURIComponent(h.cwd || '')}`;
  const data = await api(`/api/history/preview?${q}`);
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.activeId = null;
  state.boundName = null;
  state.review = { sessionId: h.sessionId, cwd: h.cwd, total: data.total || 0 };
  state.events = data.events || [];
  $('key-row').hidden = true;
  render();
}

function exitReview() {
  state.review = null;
  state.events = [];
  render();
}

/* ---------------------- 子 agent / 权限 / 模型权限 ---------------------- */

const PROBE_LABEL = {
  ok: '可用',
  blocked: '无权限，需申请',
  rate_limited: '上游限流',
  invalid: '模型名无效',
  budget: '额度耗尽',
  error: '出错',
  unknown: '未知',
};

async function showConfig(view) {
  state.configView = view;
  try {
    if (view === 'agents') state.agents = (await api('/api/agents')).items || [];
    if (view === 'perms') {
      const d = await api('/api/settings');
      state.settings = (d && d.settings) || {};
      state.settingsPath = (d && d.path) || '';
    }
    if (view === 'probe') await refreshProbe();
  } catch (err) {
    alert(err.message);
    state.configView = null;
  }
  render();
}

async function refreshProbe() {
  const d = await api('/api/models/probe');
  state.probe = d;
  render();
  if (d && d.running) setTimeout(refreshProbe, 3000);
}

function buildConfigPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'cfg-panel';
  const view = state.configView;

  const head = document.createElement('div');
  head.className = 'cfg-head';
  const title = { agents: '子 agent', perms: '权限设置', probe: '模型权限' }[view] || '配置';
  head.innerHTML = `<b>${esc(title)}</b>`;
  const back = document.createElement('button');
  back.className = 'ghost small';
  back.textContent = '返回对话';
  back.onclick = () => {
    state.configView = null;
    render();
  };
  head.appendChild(back);
  wrap.appendChild(head);

  if (view === 'agents') {
    const dir = document.createElement('div');
    dir.className = 'hint';
    dir.textContent = '目录：' + (state.agentsDir || '<config>/agents');
    wrap.appendChild(dir);

    for (const a of state.agents || []) {
      const it = document.createElement('div');
      it.className = 'item';
      it.innerHTML = `<div class="t"><b>${esc(a.name)}</b><span>${esc(a.tools || '继承全部')}</span></div>
        <div class="s">${esc(a.description || '（无描述）')}</div>`;
      const ed = document.createElement('button');
      ed.className = 'ghost small';
      ed.textContent = '编辑';
      ed.onclick = () => fillAgentForm(a);
      it.appendChild(ed);
      const del = document.createElement('button');
      del.className = 'ghost small danger';
      del.textContent = '删除';
      del.onclick = async () => {
        if (!confirm(`删除子 agent「${a.name}」？`)) return;
        await api(`/api/agents/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
        await showConfig('agents');
      };
      it.appendChild(del);
      wrap.appendChild(it);
    }
    if (!(state.agents || []).length) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = '还没有子 agent。下面新建一个——主 agent 会按 description 决定何时委派给它。';
      wrap.appendChild(p);
    }

    const form = document.createElement('div');
    form.className = 'cfg-form';
    form.innerHTML = `
      <input id="ag-name" placeholder="名称（英文，如 ceph-helper）" />
      <input id="ag-desc" placeholder="description：什么时候该用它（主 agent 靠这个选人）" />
      <input id="ag-tools" placeholder="tools：Bash, Read, Glob, Grep（留空=继承全部）" />
      <textarea id="ag-body" rows="8" placeholder="正文就是它的 system prompt"></textarea>
    `;
    const save = document.createElement('button');
    save.className = 'primary small';
    save.textContent = '保存';
    save.onclick = async () => {
      const name = $('ag-name').value.trim();
      if (!name) return alert('名称必填');
      try {
        await api('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: $('ag-desc').value.trim(),
            tools: $('ag-tools').value.trim(),
            body: $('ag-body').value,
          }),
        });
        await showConfig('agents');
      } catch (err) {
        alert(err.message);
      }
    };
    form.appendChild(save);
    wrap.appendChild(form);
    return wrap;
  }

  if (view === 'perms') {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = `文件：${esc(state.settingsPath || '')}（改动对新会话生效；运行中的会话用左侧「权限模式」下拉框切换）`;
    wrap.appendChild(p);

    const s = state.settings || {};
    const perms = s.permissions || {};
    const form = document.createElement('div');
    form.className = 'cfg-form';
    form.innerHTML = `
      <label>允许（allow），一行一条</label>
      <textarea id="pm-allow" rows="6" placeholder="Bash(git status)&#10;Bash(ls:*)&#10;Read(*)">${esc((perms.allow || []).join('\n'))}</textarea>
      <label>拒绝（deny），一行一条</label>
      <textarea id="pm-deny" rows="4" placeholder="Bash(rm -rf /:*)">${esc((perms.deny || []).join('\n'))}</textarea>
    `;
    const save = document.createElement('button');
    save.className = 'primary small';
    save.textContent = '保存';
    save.onclick = async () => {
      const lines = (v) =>
        String(v || '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
      try {
        await api('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions: { allow: lines($('pm-allow').value), deny: lines($('pm-deny').value) } }),
        });
        alert('已保存');
        await showConfig('perms');
      } catch (err) {
        alert(err.message);
      }
    };
    form.appendChild(save);
    wrap.appendChild(form);
    return wrap;
  }

  // probe
  const d = state.probe || {};
  const bar = document.createElement('div');
  bar.className = 'cfg-head';
  const run = document.createElement('button');
  run.className = 'primary small';
  run.textContent = d.running ? '探测中…' : '重新探测（会花一点钱）';
  run.disabled = !!d.running;
  run.onclick = async () => {
    try {
      await api('/api/models/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: $('inp-cwd').value.trim() || undefined, force: true }),
      });
    } catch (err) {
      alert(err.message);
    }
    await refreshProbe();
  };
  bar.appendChild(run);
  if (d.probedAt) {
    const t = document.createElement('span');
    t.className = 'hint';
    t.textContent = '上次探测：' + new Date(d.probedAt).toLocaleString();
    bar.appendChild(t);
  }
  wrap.appendChild(bar);

  for (const r of (d.results || [])) {
    const it = document.createElement('div');
    it.className = 'item';
    const st = r.status || 'unknown';
    it.innerHTML = `<div class="t"><b>${esc(r.model)}</b><span>${esc(PROBE_LABEL[st] || st)}</span></div>
      ${r.detail ? `<div class="s">${esc(r.detail)}</div>` : ''}
      ${r.cost !== undefined ? `<div class="s">单次约 $${Number(r.cost).toFixed(4)}</div>` : ''}`;
    wrap.appendChild(it);
  }
  if (!(d.results || []).length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = '还没探测过。点上面按钮，会对每个模型发一条最小请求，判断账号是否可用。';
    wrap.appendChild(p);
  }

  const apply = document.createElement('div');
  apply.className = 'hint';
  apply.innerHTML =
    '无权限（403 Model is blocked）需要找管理员开通：' +
    ' <a href="https://deepops.yuanbao.woa.com/" target="_blank" rel="noopener">deepops 运营平台</a> ·' +
    ' 预算管理 <a href="https://xy.woa.com/xy/app/prod/deepops_admin/litellm-budget" target="_blank" rel="noopener">litellm-budget</a>';
  wrap.appendChild(apply);
  return wrap;
}

function fillAgentForm(a) {
  $('ag-name').value = a.name || '';
  $('ag-desc').value = a.description || '';
  $('ag-tools').value = a.tools || '';
  $('ag-body').value = a.body || '';
}

function wireConfigPanel() {
  /* 事件在 buildConfigPanel 里逐个绑定，这里留空以便扩展 */
}

async function stopLocal(name) {
  if (
    !confirm(
      `结束「${name}」？\n会杀掉对应的 tc 进程和 tmux 会话。\n记录会保留在「历史记录」里，之后可以审视或用新终端恢复。\n（想收纳起来再点它的「归档」）`
    )
  )
    return;
  await api(`/api/local-sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadLocal();
}

/** 彻底删除：连记录一起删，不进归档 */
async function purgeLocal(name) {
  if (!confirm(`彻底删除「${name}」？\n会杀掉进程并删除它的全部记录，不可恢复。`)) return;
  await api(`/api/local-sessions/${encodeURIComponent(name)}?purge=1`, { method: 'DELETE' });
  if (state.boundName === name) {
    state.boundName = null;
    state.events = [];
    render();
  }
  await loadLocal();
}

/** 历史记录 <-> 归档（只改标记，不动文件） */
async function archiveHistory(h, on) {
  const flag = on !== false;
  await api(`/api/history/${encodeURIComponent(h.sessionId)}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: flag }),
  });
  await loadLocal();
}

/** 删除一条归档（删文件） */
async function deleteArchive(h) {
  if (!confirm(`删除归档 ${String(h.sessionId).slice(0, 8)}？\n对应的会话记录文件会被删除，不可恢复。`)) return;
  await api(`/api/history/${encodeURIComponent(h.sessionId)}?cwd=${encodeURIComponent(h.cwd || '')}`, {
    method: 'DELETE',
  });
  if (state.review && state.review.sessionId === h.sessionId) exitReview();
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
  const archive = data.archive || [];
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
    btn.textContent = '结束（进历史）';
    btn.title = '杀掉进程和 tmux 会话，记录保留在「历史记录」里';
    btn.onclick = (ev) => {
      ev.stopPropagation();
      stopLocal(m.name);
    };
    d.appendChild(btn);
    const del = document.createElement('button');
    del.className = 'ghost small danger';
    del.textContent = '删除';
    del.title = '杀掉进程并删除全部记录，不进历史记录也不进归档';
    del.onclick = (ev) => {
      ev.stopPropagation();
      purgeLocal(m.name);
    };
    d.appendChild(del);
    if (m.attachCmd) {
      const cp = document.createElement('button');
      cp.className = 'ghost small';
      cp.textContent = '复制终端命令';
      cp.title = `复制「${m.attachCmd}」，在 CodeBuddy 的终端里粘贴执行即可看到同一个对话`;
      cp.onclick = (ev) => {
        ev.stopPropagation();
        copyText(m.attachCmd).then(
          () => (cp.textContent = '已复制 ✓'),
          () => prompt('自动复制被浏览器拦了，请手动复制：', m.attachCmd)
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
    d.title = '点击审视这段历史（只读，不起进程）';
    d.onclick = () => previewHistory(h);
    const open = document.createElement('button');
    open.className = 'ghost small';
    open.textContent = '打开（新终端）';
    open.title = '新起一个 tmux 会话恢复这段对话并接入 Web';
    open.onclick = (ev) => {
      ev.stopPropagation();
      startLocal({
        name: `r-${String(h.sessionId).slice(0, 8)}-${Date.now().toString(36).slice(-4)}`,
        resumeFrom: h.sessionId,
        cwd: h.cwd || undefined,
      });
    };
    d.appendChild(open);
    const arc = document.createElement('button');
    arc.className = 'ghost small';
    arc.textContent = '归档';
    arc.title = '收进归档区（折叠起来），不删文件';
    arc.onclick = (ev) => {
      ev.stopPropagation();
      archiveHistory(h);
    };
    d.appendChild(arc);
    hl.appendChild(d);
  }
  if (!history.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = '暂无。结束一个对话后它会落到这里';
    hl.appendChild(p);
  }

  /* 归档：折叠区，这里删除 = 删文件 */
  const al = $('archive-list');
  al.replaceChildren();
  for (const h of archive) {
    const d = document.createElement('div');
    d.className = 'item';
    const when = String(h.timestamp || '').slice(0, 16).replace('T', ' ');
    d.innerHTML = `<div class="t"><b>${esc(String(h.sessionId).slice(0, 8))}</b><span>${esc(when)}</span></div>
      <div class="s">${h.source === 'managed' && h.name ? esc(h.name) + ' · ' : ''}${esc(h.cwd || '')}</div>`;
    d.title = '点击审视';
    d.onclick = () => previewHistory(h);
    const open = document.createElement('button');
    open.className = 'ghost small';
    open.textContent = '打开（新终端）';
    open.onclick = (ev) => {
      ev.stopPropagation();
      startLocal({
        name: `r-${String(h.sessionId).slice(0, 8)}-${Date.now().toString(36).slice(-4)}`,
        resumeFrom: h.sessionId,
        cwd: h.cwd || undefined,
      });
    };
    d.appendChild(open);
    const back = document.createElement('button');
    back.className = 'ghost small';
    back.textContent = '移回历史';
    back.onclick = (ev) => {
      ev.stopPropagation();
      archiveHistory(h, false);
    };
    d.appendChild(back);
    const del = document.createElement('button');
    del.className = 'ghost small danger';
    del.textContent = '删除文件';
    del.onclick = (ev) => {
      ev.stopPropagation();
      deleteArchive(h);
    };
    d.appendChild(del);
    al.appendChild(d);
  }
  $('archive-count').textContent = String(archive.length);
  if (!archive.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = '暂无归档';
    al.appendChild(p);
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
  fillSelect($('chat-model'), models, state.cfg.defaultModel);
  fillSelect($('sel-perm'), state.cfg.permissionModes, state.cfg.permissionMode);
  $('inp-cwd').value = state.cfg.defaultCwd;

  const cheap = state.cfg.cheapestModel;
  $('hint').textContent = cheap
    ? `调试默认用最便宜的模型：${cheap}（实测同请求单次约 $0.006）`
    : '';

  on('btn-new', 'click', () => startLocal().catch((err) => alert(err.message)));
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };
  on('btn-stop', 'click', async () => {
    if (!state.activeId) return;
    try {
      await api(`/api/sessions/${state.activeId}/interrupt`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
    }
  });
  ($('key-row') || { querySelectorAll: () => [] }).querySelectorAll('[data-key]').forEach((el) => {
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
  on('inp-cwd', 'change', loadLocal);
  on('sel-model', 'change', () => changeModel($('sel-model').value).catch((err) => alert(err.message)));
  on('chat-model', 'change', () => changeModel($('chat-model').value).catch((err) => alert(err.message)));
  on('chat-effort', 'change', async () => {
    const v = $('chat-effort').value;
    $('chat-effort').value = '';
    if (!v) return;
    if (!state.activeId) return alert('先打开一个对话');
    await handleSlash(`/effort ${v}`);
  });
  on('sel-perm', 'change', () => applyPermissionMode($('sel-perm').value).catch((err) => alert(err.message)));
  ($('cmd-row') || { querySelectorAll: () => [] }).querySelectorAll('[data-cmd]').forEach((el) => {
    el.onclick = async () => {
      if (!state.activeId) return alert('先打开一个对话');
      await handleSlash(el.getAttribute('data-cmd'));
    };
  });
  on('btn-plan', 'click', () => togglePlanMode());
  on('btn-agents', 'click', () => showConfig('agents'));
  on('btn-perms', 'click', () => showConfig('perms'));
  on('btn-probe', 'click', () => showConfig('probe'));

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

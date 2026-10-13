'use strict';

/**
 * 发现「本机已经在跑的 tc」：
 *  1) managed：用 scripts/tc-run.js 启动的（无论在 tmux、终端还是后台），有 meta.json + jsonl + fifo
 *  2) foreign：直接跑 tclaude / claude 的进程。只有在 tmux 窗格里才能接管（靠 pipe-pane 抓屏）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('./config');

function ensureRunDir() {
  try {
    fs.mkdirSync(config.runDir, { recursive: true });
  } catch (err) {
    /* ignore */
  }
  return config.runDir;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return false;
  }
}

function baseName(args) {
  return String(args || '').trim().split(/\s+/)[0].split('/').pop();
}

/** 读取 *.meta.json，列出我们管理过的本地 tc 会话 */
function listManaged() {
  const dir = ensureRunDir();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      m.name = m.name || f.replace(/\.meta\.json$/, '');
      m.alive = isAlive(m.pid);
      m.tmuxTarget = tmuxHasSession(m.name) ? `${m.name}:0.0` : null;
      m.attachCmd = m.tmuxTarget ? `tmux attach -t ${m.name}` : null;
      if (!m.sessionId) m.sessionId = sessionIdFromLog(m.logPath);
      items.push(m);
    } catch (err) {
      /* 跳过坏文件 */
    }
  }
  return items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/** Claude Code 把每个会话实时写进 <config>/projects/<slug>/<sessionId>.jsonl */
function projectDir(cwd) {
  return path.join(config.claudeConfigDir, 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** 找到某个会话的记录文件：优先按 sessionId 匹配，否则取最近修改的那个 */
function findTranscript(cwd, sessionId) {
  const dir = projectDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    return null;
  }
  if (!files.length) return null;

  if (sessionId) {
    const id = String(sessionId);
    for (const f of files) {
      if (f.startsWith(id.slice(0, 8)) || f.replace(/\.jsonl$/, '') === id) return path.join(dir, f);
    }
    for (const f of files) {
      try {
        const fd = fs.openSync(path.join(dir, f), 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const o = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
        if (o && (o.sessionId === id || o.session_id === id)) return path.join(dir, f);
      } catch (err) {
        /* 继续找 */
      }
    }
  }

  let best = null;
  let bt = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > bt) {
        bt = st.mtimeMs;
        best = f;
      }
    } catch (err) {
      /* ignore */
    }
  }
  return best ? path.join(dir, best) : null;
}

/** 严格匹配某个 sessionId 的记录文件（删除时用，绝不回退到「最新的那个」） */
function findTranscriptExact(cwd, sessionId) {
  if (!sessionId) return null;
  const id = String(sessionId);
  const dir = projectDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    return null;
  }
  for (const f of files) {
    if (f.replace(/\.jsonl$/, '') === id || f.startsWith(id.slice(0, 8))) return path.join(dir, f);
  }
  for (const f of files) {
    try {
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const o = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
      if (o && (o.sessionId === id || o.session_id === id)) return path.join(dir, f);
    } catch (err) {
      /* 继续 */
    }
  }
  return null;
}

/** 彻底删除一个本地会话（结束进程 + 清掉 meta/日志/fifo，不进归档） */
function purgeManaged(name) {
  const res = stopManaged(name);
  const dir = ensureRunDir();
  const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '');
  const removed = [];
  for (const f of [`${safe}.meta.json`, `${safe}.jsonl`, `${safe}.fifo`]) {
    try {
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    } catch (err) {
      /* 可能本来就没有 */
    }
  }
  return Object.assign({ removed }, res);
}

/** 删除一条归档（记录文件 + 对应托管会话的日志/meta） */
function deleteHistory(sessionId, cwd) {
  const removed = [];
  const p = findTranscriptExact(cwd, sessionId);
  if (p) {
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch (err) {
      /* ignore */
    }
  }
  for (const m of listManaged()) {
    if (m.sessionId === sessionId || m.name === sessionId) {
      for (const f of [m.logPath, m.fifoPath, path.join(config.runDir, `${m.name}.meta.json`)]) {
        if (!f) continue;
        try {
          fs.unlinkSync(f);
          removed.push(f);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }
  return { removed };
}

/** 从事件日志里找 Claude 的 session_id，历史记录靠它 --resume 恢复 */
function sessionIdFromLog(logPath) {
  if (!logPath) return null;
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
  } catch (err) {
    return null;
  }
  try {
    const buf = Buffer.alloc(131072);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"init"')) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.type === 'system' && o.subtype === 'init' && o.session_id) return o.session_id;
      } catch (err) {
        /* 继续找 */
      }
    }
  } catch (err) {
    /* ignore */
  } finally {
    try {
      fs.closeSync(fd);
    } catch (err) {
      /* ignore */
    }
  }
  return null;
}

function listActive() {
  return listManaged().filter((m) => m.alive);
}

function listArchived(limit = 30) {
  return listManaged()
    .filter((m) => !m.alive)
    .sort((a, b) => (b.exitedAt || b.startedAt || 0) - (a.exitedAt || a.startedAt || 0))
    .slice(0, limit)
    .map((m) => ({
      sessionId: m.sessionId,
      name: m.name,
      cwd: m.cwd,
      model: m.model,
      timestamp: new Date(m.exitedAt || m.startedAt || Date.now()).toISOString(),
      source: 'managed',
      logPath: m.logPath,
      resumedFrom: m.resumedFrom || null,
    }));
}

function psRows() {
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,tty=,args='], { encoding: 'utf8' });
  } catch (err) {
    return [];
  }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], tty: m[3], args: m[4] });
  }
  return rows;
}

function tmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function tmuxHasSession(name) {
  if (!tmuxAvailable()) return false;
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function tmuxPanes() {
  if (!tmuxAvailable()) return [];
  let out = '';
  try {
    out = execFileSync(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    return [];
  }
  const panes = [];
  for (const line of out.split('\n')) {
    const p = line.split('\t');
    if (p.length < 3) continue;
    panes.push({ paneId: p[0], panePid: +p[1], target: p[2], cmd: p[3] || '' });
  }
  return panes;
}

/** 往上找祖先，判断该进程是否跑在某个 tmux 窗格下 */
function paneOf(pid, ppidMap, panes) {
  let cur = pid;
  let depth = 0;
  while (cur && depth++ < 32) {
    const hit = panes.find((p) => p.panePid === cur);
    if (hit) return hit;
    cur = ppidMap.get(cur) || 0;
  }
  return null;
}

function listForeign() {
  const rows = psRows();
  const ppidMap = new Map(rows.map((r) => [r.pid, r.ppid]));
  const panes = tmuxPanes();
  const managedPids = new Set(listManaged().map((m) => m.pid).filter(Boolean));

  const out = [];
  for (const r of rows) {
    // 排除：守护进程、claude-code 内核子进程、我们自己的 runner
    if (
      r.args.includes('__tclaude_daemon') ||
      r.args.includes('runtime/claude-code') ||
      r.args.includes('tc-run.js') ||
      r.args.includes('ccweb')
    ) {
      continue;
    }
    const b = baseName(r.args);
    if (b !== 'tclaude' && b !== 'claude') continue;
    if (managedPids.has(r.pid)) continue;

    // 属于某个 managed 会话的子进程（我们用 tc-run.js 起的）不算「外部 tc」
    const chain = [];
    let cur = r.pid;
    let d = 0;
    while (cur && d++ < 32) {
      chain.push(cur);
      cur = ppidMap.get(cur) || 0;
    }
    if (chain.some((p) => managedPids.has(p))) continue;

    const pane = paneOf(r.pid, ppidMap, panes);
    out.push({
      pid: r.pid,
      tty: r.tty,
      cmd: r.args.slice(0, 140),
      cli: b,
      tmux: pane ? { paneId: pane.paneId, target: pane.target } : null,
      attachable: !!pane,
      reason: pane
        ? null
        : '不在 tmux 窗格里，无法接管。用 scripts/tc-run.js 启动，或先跑在 tmux 里。',
    });
  }
  return out;
}

/** 启动一个本地 tc 会话（放进 tmux，方便随时 tmux attach 看同一个进程） */
function startManaged(opts) {
  const dir = ensureRunDir();
  const name = String(opts.name || '').trim() || `tc-${Date.now().toString(36)}`;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('会话名只能包含字母数字、下划线、点和短横线');
  if (tmuxHasSession(name)) throw new Error(`tmux 会话 ${name} 已存在，换一个名字`);

  const runner = path.join(__dirname, '..', 'scripts', 'tc-run.js');
  const args = [
    runner,
    '--name', name,
    '--cwd', opts.cwd,
    '--model', opts.model,
    '--perm', opts.permissionMode,
    '--cli', config.cli,
  ];
  if (opts.resumeFrom) args.push('--resume', String(opts.resumeFrom));

  let launchedBy = 'tmux';
  if (tmuxAvailable()) {
    const cmd = [process.execPath].concat(args).map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', opts.cwd, cmd], { stdio: 'ignore' });
  } else {
    launchedBy = 'detached';
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, args, { cwd: opts.cwd, detached: true, stdio: 'ignore' });
    child.unref();
  }

  // 等 runner 写好 meta
  const metaPath = path.join(dir, `${name}.meta.json`);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(metaPath)) break;
    execFileSync('sleep', ['0.1']);
  }
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    meta = null;
  }
  return { name, launchedBy, meta };
}

function stopManaged(name) {
  const dir = ensureRunDir();
  const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, `${safe}.meta.json`), 'utf8'));
  } catch (err) {
    /* ignore */
  }
  if (meta && isAlive(meta.pid)) {
    try {
      process.kill(Number(meta.pid), 'SIGTERM');
    } catch (err) {
      /* ignore */
    }
  }
  if (tmuxAvailable()) {
    try {
      execFileSync('tmux', ['kill-session', '-t', safe], { stdio: 'ignore' });
    } catch (err) {
      /* 可能本来就不在 tmux 里 */
    }
  }
  // 保留 meta：结束后它进入「历史记录」，可一键恢复（会新开一个终端会话）
  if (meta) {
    try {
      meta.exitedAt = Date.now();
      meta.alive = false;
      delete meta.alive;
      fs.writeFileSync(path.join(dir, `${safe}.meta.json`), JSON.stringify(meta));
    } catch (err) {
      /* ignore */
    }
  }
  return { name: safe, killed: !!(meta && meta.pid) };
}

module.exports = {
  ensureRunDir,
  listManaged,
  listActive,
  listArchived,
  listForeign,
  startManaged,
  stopManaged,
  tmuxAvailable,
  tmuxHasSession,
  tmuxPanes,
  sessionIdFromLog,
  findTranscript,
  findTranscriptExact,
  projectDir,
  purgeManaged,
  deleteHistory,
  isAlive,
};

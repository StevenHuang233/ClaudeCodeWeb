#!/usr/bin/env node
'use strict';

/**
 * 在本地终端（可以是 tmux / 任意终端 / 后台）里跑一个 tc，
 * 同时把同一份事件流落盘，供 ClaudeCodeWeb 发现并绑定。
 *
 *   node scripts/tc-run.js --name mytc --cwd /data/workspace --model claude-haiku-4-5
 *
 * 终端里：直接打字就是发消息（Enter 发送），输出是美化后的文本。
 * Web 里：看到的是同一进程的完整结构化事件（工具、思考、花费）。
 * 两边共享同一个进程和同一份上下文。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
function arg(key, dflt) {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

const name = arg('name') || `tc-${Date.now().toString(36)}`;
const cwd = path.resolve(arg('cwd') || process.cwd());
const model = arg('model') || 'claude-haiku-4-5';
const perm = arg('perm') || 'acceptEdits';
const cli = arg('cli') || 'tclaude';
const resumeFrom = arg('resume') || '';
const runDir = process.env.CCWEB_RUN_DIR || path.join(os.homedir(), '.cache', 'ccweb');

/**
 * 不在 tmux 里（比如直接在 CodeBuddy / iTerm 的终端里跑）时，自动把自己塞进一个
 * 同名 tmux 会话并 attach 上去。这样终端和 Web 看到的是同一个进程，
 * 也解决了「没有多路复用器就无法接管已有进程」的问题。
 */
if (!argv.includes('--no-tmux') && !process.env.TMUX) {
  let hasTmux = false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    hasTmux = true;
  } catch (err) {
    hasTmux = false;
  }
  if (hasTmux) {
    const self = [process.execPath, __filename].concat(argv, ['--no-tmux']);
    const inner = self.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, inner], { stdio: 'ignore' });
    } catch (err) {
      // 同名会话已存在就直接复用
    }
    console.log(`[tc-run] 已在 tmux 会话「${name}」中启动，正在接入…（Ctrl+B 然后按 D 可脱离，会话继续在后台跑）`);
    try {
      spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
    } catch (err) {
      console.log(`[tc-run] 当前环境无法直接接入，请手动执行： tmux attach -t ${name}`);
    }
    process.exit(0);
  }
}

fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, `${name}.jsonl`);
const fifoPath = path.join(runDir, `${name}.fifo`);
const metaPath = path.join(runDir, `${name}.meta.json`);

if (!fs.existsSync(fifoPath)) {
  try {
    require('child_process').execFileSync('mkfifo', [fifoPath]);
  } catch (err) {
    /* 可能已存在 */
  }
}

const meta = {
  name,
  cwd,
  model,
  permissionMode: perm,
  cli,
  pid: process.pid,
  logPath,
  fifoPath,
  startedAt: Date.now(),
  resumedFrom: resumeFrom || null,
  exitedAt: null,
  sessionId: null,
};
function saveMeta() {
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch (err) {
    /* ignore */
  }
}
saveMeta();

const isTTY = !!process.stdout.isTTY;
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const accent = (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);

console.log(dim(`[tc-run] ${name} · ${cwd} · ${model} · pid=${process.pid}${resumeFrom ? ` · 恢复自 ${resumeFrom.slice(0, 8)}` : ''}`));
console.log(dim(`[tc-run] 事件流: ${logPath}`));
console.log(dim('[tc-run] 直接打字发消息，Ctrl+C 结束\n'));

// 默认跑原生交互界面（就是平时直接敲 tclaude 看到的那个页面）。
// Web 端改读 Claude Code 自己的会话记录文件，所以两边依然实时同步。
// 想回到「终端也是我们渲染的简化界面 + 完整事件流」，加 --structured。
const tuiMode = !argv.includes('--structured');
if (tuiMode) {
  meta.mode = 'tui';
  saveMeta();
  if (process.stdout.isTTY) {
    console.log(dim(`[tc-run] ${name} · ${cwd} · 原生交互界面`));
    console.log(dim('[tc-run] Web 端读会话记录，与这里实时同步\n'));
  }
  const tuiArgs = [];
  if (model) tuiArgs.push('--model', model);
  if (perm) tuiArgs.push('--permission-mode', perm);
  if (resumeFrom) tuiArgs.push('--resume', resumeFrom);
  const c = spawn(cli, tuiArgs, { cwd, stdio: 'inherit' });

  // 找到 Claude Code 正在写的会话记录文件，Web 靠它渲染
  const projDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.tclaude'),
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-')
  );
  const startTs = Date.now();
  let tries = 0;
  const timer = setInterval(() => {
    if (meta.transcriptPath || ++tries > 60) {
      clearInterval(timer);
      return;
    }
    let files = [];
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      return;
    }
    let best = null;
    let bt = startTs - 1000;
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(projDir, f));
        if (st.mtimeMs > bt) {
          bt = st.mtimeMs;
          best = f;
        }
      } catch (err) {
        /* ignore */
      }
    }
    if (best) {
      meta.transcriptPath = path.join(projDir, best);
      meta.sessionId = meta.sessionId || best.replace(/\.jsonl$/, '');
      saveMeta();
      clearInterval(timer);
    }
  }, 1000);
  c.on('exit', (code) => {
    meta.exitedAt = Date.now();
    saveMeta();
    process.exit(code == null ? 1 : code);
  });
  process.on('SIGINT', () => {
    try {
      c.kill('SIGTERM');
    } catch (err) {
      /* ignore */
    }
  });
  return;
}

const cliArgs = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--model', model,
  '--permission-mode', perm,
];
if (resumeFrom) cliArgs.push('--resume', resumeFrom);

const child = spawn(cli, cliArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

let childGone = false;
function send(obj) {
  if (childGone || !child.stdin || child.stdin.destroyed) return false;
  try {
    child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- Web 侧输入：读 FIFO（以 r+ 常开，避免写入端关闭造成 EOF） ---------- */
try {
  const fd = fs.openSync(fifoPath, 'r+');
  const rs = fs.createReadStream(null, { fd, encoding: 'utf8' });
  let buf = '';
  rs.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        send(JSON.parse(line));
      } catch (err) {
        send({ type: 'user', message: { role: 'user', content: line } });
      }
    }
  });
  rs.on('error', () => {});
} catch (err) {
  console.log(dim(`[tc-run] 无法打开 FIFO: ${err.message}`));
}

/* ---------- 终端侧输入 ---------- */
if (process.stdin.isTTY) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(accent('> '));
  rl.prompt();
  rl.on('line', (line) => {
    const t = line.trim();
    if (t) send({ type: 'user', message: { role: 'user', content: t } });
    rl.prompt();
  });
  rl.on('close', () => {});
}

/* ---------- 输出：原始事件落盘 + 终端美化 ---------- */
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function shortInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 120);
  const v = input.command || input.file_path || input.pattern || input.description || input.url || '';
  return String(v).slice(0, 120);
}

function resultText(c) {
  const x = c && c.content;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) {
    return x.map((y) => (typeof y === 'string' ? y : y && y.text ? y.text : '')).filter(Boolean).join(' ⏎ ');
  }
  return '';
}

function pretty(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch (err) {
    return;
  }
  if (e.type === 'assistant') {
    for (const c of (e.message && e.message.content) || []) {
      if (c.type === 'text') {
        if (c.text) process.stdout.write(c.text + '\n');
      } else if (c.type === 'thinking') {
        const t = String(c.thinking || '').trim();
        if (t) {
          process.stdout.write(
            dim(`✢ 思考 ${t.length} 字：${t.slice(0, 160).replace(/\n/g, ' ')}${t.length > 160 ? '…' : ''}\n`)
          );
        }
      } else if (c.type === 'tool_use') {
        const arg = shortInput(c.input);
        process.stdout.write(accent(`⏺ ${c.name}`) + (arg ? dim(` (${arg})`) : '') + '\n');
      }
    }
  } else if (e.type === 'user') {
    // 工具结果是作为 user 消息回传的
    const content = e.message && e.message.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_result') {
          const txt = resultText(c).replace(/\n/g, ' ⏎ ');
          const tag = c.is_error ? '✗ 出错' : '⎿ 结果';
          process.stdout.write(dim(`  ${tag}: ${txt.slice(0, 300)}${txt.length > 300 ? '…' : ''}\n`));
        }
      }
    }
  } else if (e.type === 'result') {
    const u = e.usage || {};
    process.stdout.write(
      dim(
        `\n✓ 完成 · $${(e.total_cost_usd || 0).toFixed(4)} · ${((e.duration_ms || 0) / 1000).toFixed(1)}s · ${
          e.num_turns || 0
        } 轮 · in ${u.input_tokens || 0}/out ${u.output_tokens || 0}\n\n`
      )
    );
  } else if (e.type === 'system' && e.subtype === 'init') {
    if (e.session_id && !meta.sessionId) {
      meta.sessionId = e.session_id;
      saveMeta();
    }
    process.stdout.write(
      dim(`[init] ${e.model || ''} · ${(e.tools || []).length} 个工具 · session ${String(e.session_id || '').slice(0, 8)}\n`)
    );
  }
}

function feed(text) {
  let i;
  while ((i = text.indexOf('\n')) >= 0) {
    pretty(text.slice(0, i).trim());
    text = text.slice(i + 1);
  }
  return text;
}

let sbuf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  logStream.write(d);
  sbuf = feed(sbuf + d);
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  const t = String(d);
  if (t.includes('unrecognized_model')) return; // SDK 对 [1m] 后缀的遥测告警，忽略
  process.stderr.write(dim(t));
});

child.on('error', (err) => {
  childGone = true;
  console.error(`[tc-run] 启动失败: ${err.message}`);
});

child.on('exit', (code) => {
  childGone = true;
  logStream.end();
  console.log(dim(`\n[tc-run] ${name} 结束 (code=${code})`));
  // 保留 meta，这样它会出现在 Web 的「历史记录」里，可一键恢复
  meta.exitedAt = Date.now();
  saveMeta();
  process.exit(code == null ? 1 : code);
});

process.on('SIGINT', () => {
  try {
    child.kill('SIGTERM');
  } catch (err) {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 800);
});
process.on('SIGTERM', () => {
  try {
    child.kill('SIGTERM');
  } catch (err) {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 800);
});

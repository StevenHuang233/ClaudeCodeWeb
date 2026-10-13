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
const { spawn } = require('child_process');

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
const runDir = process.env.CCWEB_RUN_DIR || path.join(os.homedir(), '.cache', 'ccweb');

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

fs.writeFileSync(
  metaPath,
  JSON.stringify({
    name,
    cwd,
    model,
    permissionMode: perm,
    cli,
    pid: process.pid,
    logPath,
    fifoPath,
    startedAt: Date.now(),
  })
);

const isTTY = !!process.stdout.isTTY;
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const accent = (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);

console.log(dim(`[tc-run] ${name} · ${cwd} · ${model} · pid=${process.pid}`));
console.log(dim(`[tc-run] 事件流: ${logPath}`));
console.log(dim('[tc-run] 直接打字发消息，Ctrl+C 结束\n'));

const child = spawn(
  cli,
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', perm],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
);

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

function pretty(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch (err) {
    return;
  }
  if (e.type === 'assistant') {
    for (const c of (e.message && e.message.content) || []) {
      if (c.type === 'text') process.stdout.write(c.text + '\n');
      else if (c.type === 'tool_use') {
        process.stdout.write(accent(`⟦${c.name}⟧ `) + JSON.stringify(c.input).slice(0, 400) + '\n');
      }
    }
  } else if (e.type === 'result') {
    process.stdout.write(
      dim(`\n✓ 完成 · $${(e.total_cost_usd || 0).toFixed(4)} · ${e.duration_ms || 0}ms · ${e.num_turns || 0} 轮\n\n`)
    );
  } else if (e.type === 'system' && e.subtype === 'init') {
    process.stdout.write(dim(`[init] ${e.model || ''} · ${(e.tools || []).length} 个工具\n`));
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
  try {
    fs.unlinkSync(metaPath);
  } catch (err) {
    /* ignore */
  }
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

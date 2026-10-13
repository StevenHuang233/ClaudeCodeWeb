'use strict';

/**
 * 绑定「本机已经在跑的 tc」，不自己 spawn 进程。
 *
 *  kind='managed'：目标是 scripts/tc-run.js 起的会话。
 *      读它的 *.jsonl 拿完整结构化事件，写它的 *.fifo 发消息。
 *  kind='mirror' ：目标是 tmux 窗格里一个不受我们控制的 tclaude/claude。
 *      用 tmux pipe-pane 抓屏幕输出，用 tmux send-keys 发输入。
 *      只有文本镜像，拿不到工具详情和花费。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { config } = require('./config');

const MAX_EVENTS = 4000;
const TAIL_INTERVAL = 300;

class LocalSession extends EventEmitter {
  constructor(opts) {
    super();
    this.id = randomUUID();
    this.kind = opts.kind; // 'managed' | 'mirror'
    this.cwd = opts.cwd || null;
    this.model = opts.model || null;
    this.title = opts.title || null;
    this.status = 'idle';
    this.events = [];
    this.seq = 0;
    this.createdAt = Date.now();
    this.lastError = null;
    this._timer = null;
    this._offset = 0;

    if (this.kind === 'managed') {
      this.name = opts.name;
      this.logPath = opts.logPath;
      this.fifoPath = opts.fifoPath;
      this.pid = opts.pid || null;
      this.model = opts.model || this.model;
      this.cwd = opts.cwd || this.cwd;
      this.title = this.title || this.name;
    } else {
      this.tmuxTarget = opts.tmuxTarget;
      this.paneId = opts.paneId || null;
      this.pid = opts.pid || null;
      this.mirrorPath = path.join(config.runDir, `mirror-${this.id}.log`);
      this.title = this.title || `tmux ${this.tmuxTarget}`;
    }
  }

  start() {
    try {
      fs.mkdirSync(config.runDir, { recursive: true });
    } catch (err) {
      /* ignore */
    }

    if (this.kind === 'mirror') {
      try {
        const shot = execFileSync('tmux', ['capture-pane', '-p', '-t', this.tmuxTarget, '-S', '-3000'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (shot && shot.trim()) this._push({ type: 'ccweb', subtype: 'terminal', data: shot });
      } catch (err) {
        this.lastError = `抓屏失败: ${err.message}`;
      }
      try {
        const cmd = `cat >> ${JSON.stringify(this.mirrorPath)}`;
        execFileSync('tmux', ['pipe-pane', '-o', '-t', this.tmuxTarget, cmd], { stdio: 'ignore' });
      } catch (err) {
        this.lastError = `pipe-pane 失败: ${err.message}`;
        this.status = 'error';
        this._push({ type: 'ccweb', subtype: 'spawn_error', message: this.lastError });
        return this;
      }
    }

    this.status = 'running';
    this._push({
      type: 'ccweb',
      subtype: 'attached',
      message: this.kind === 'managed' ? `已绑定本地会话 ${this.name}` : `已镜像 tmux ${this.tmuxTarget}`,
    });
    this._timer = setInterval(() => this._tail(), TAIL_INTERVAL);
    this._tail();
    return this;
  }

  _tail() {
    const file = this.kind === 'managed' ? this.logPath : this.mirrorPath;
    if (!file) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      return;
    }
    if (stat.size < this._offset) this._offset = 0; // 文件被截断/重写
    if (stat.size === this._offset) return;
    const len = stat.size - this._offset;
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(len, 1 << 20));
      const n = fs.readSync(fd, buf, 0, buf.length, this._offset);
      fs.closeSync(fd);
      this._offset += n;
      text = buf.toString('utf8', 0, n);
    } catch (err) {
      return;
    }
    if (!text) return;

    if (this.kind === 'mirror') {
      this._push({ type: 'ccweb', subtype: 'terminal', data: text });
      return;
    }

    let i;
    while ((i = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, i).trim();
      text = text.slice(i + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (evt && evt.type === 'system' && evt.subtype === 'init') {
        this.model = evt.model || this.model;
        this.cwd = evt.cwd || this.cwd;
      }
      if (evt && evt.type === 'result') {
        this.status = 'idle';
        this.lastResult = {
          cost: evt.total_cost_usd || 0,
          durationMs: evt.duration_ms || 0,
          numTurns: evt.num_turns || 0,
          usage: evt.usage || null,
        };
      }
      this._push(evt);
    }
  }

  _push(evt) {
    const record = Object.assign({}, evt, { _seq: this.seq++, _ts: Date.now() });
    this.events.push(record);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit('event', record);
  }

  send(text) {
    if (!text) throw new Error('消息为空');
    if (this.kind === 'managed') {
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
      try {
        fs.appendFileSync(this.fifoPath, payload);
      } catch (err) {
        throw new Error(`写入 FIFO 失败（会话还活着吗）: ${err.message}`);
      }
      this.status = 'running';
      return true;
    }
    // mirror：把文本敲进 tmux 窗格
    const lines = String(text).split('\n');
    try {
      for (let i = 0; i < lines.length; i++) {
        execFileSync('tmux', ['send-keys', '-t', this.tmuxTarget, '-l', lines[i]], { stdio: 'ignore' });
        if (i < lines.length - 1) execFileSync('tmux', ['send-keys', '-t', this.tmuxTarget, 'Enter'], { stdio: 'ignore' });
      }
      execFileSync('tmux', ['send-keys', '-t', this.tmuxTarget, 'Enter'], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(`tmux send-keys 失败: ${err.message}`);
    }
    return true;
  }

  interrupt() {
    if (this.kind === 'managed') {
      try {
        fs.appendFileSync(
          this.fifoPath,
          JSON.stringify({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } }) + '\n'
        );
      } catch (err) {
        throw new Error(err.message);
      }
      return true;
    }
    try {
      execFileSync('tmux', ['send-keys', '-t', this.tmuxTarget, 'C-c'], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(err.message);
    }
    return true;
  }

  /** 镜像模式下从网页敲按键（白名单，避免把任意字符串当 tmux key 名执行） */
  sendKey(key) {
    if (this.kind !== 'mirror') throw new Error('仅镜像会话支持按键');
    const allowed = ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BSpace', 'Space', 'C-c', 'C-d', 'y', 'n'];
    if (!allowed.includes(key)) throw new Error(`不支持的按键: ${key}`);
    try {
      execFileSync('tmux', ['send-keys', '-t', this.tmuxTarget, key], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(`tmux send-keys 失败: ${err.message}`);
    }
    return true;
  }

  respondControl() {
    if (this.kind === 'mirror') throw new Error('镜像模式不支持权限审批（请在 tmux 里直接操作）');
    throw new Error('本地绑定模式下暂不支持权限审批，请用 acceptEdits 等自动模式');
  }

  setPermissionMode() {
    throw new Error('本地绑定模式不支持运行时切换权限模式');
  }

  /** 只是断开 Web 端的绑定，不会杀掉本地的 tc 进程 */
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.kind === 'mirror') {
      try {
        execFileSync('tmux', ['pipe-pane', '-t', this.tmuxTarget], { stdio: 'ignore' });
      } catch (err) {
        /* ignore */
      }
      try {
        fs.unlinkSync(this.mirrorPath);
      } catch (err) {
        /* ignore */
      }
    }
    this.status = 'exited';
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      cli: this.kind === 'managed' ? 'local:managed' : 'local:mirror',
      cwd: this.cwd,
      model: this.model,
      status: this.status,
      title: this.title,
      createdAt: this.createdAt,
      lastError: this.lastError,
      lastResult: this.lastResult || null,
      source: this.kind === 'managed'
        ? { name: this.name, pid: this.pid }
        : { tmuxTarget: this.tmuxTarget, pid: this.pid },
    };
  }
}

module.exports = { LocalSession };

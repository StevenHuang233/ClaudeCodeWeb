'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_EVENTS = 4000;

/**
 * 一个 Session = 一个常驻的 tclaude / claude code 进程。
 * 用 --input-format stream-json / --output-format stream-json 双向流式协议通信，
 * 可以在同一个进程里连续发多条 user 消息（保留上下文），不用每条都重新起进程。
 */
class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.id = randomUUID();
    this.cli = opts.cli;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.permissionMode = opts.permissionMode;
    this.resumeFrom = opts.resumeFrom || null;
    this.title = opts.title || null;

    this.status = 'starting'; // starting | running | idle | exited | error
    this.events = [];
    this.seq = 0;
    this.cliSessionId = null;
    this.lastResult = null;
    this.createdAt = Date.now();
    this.lastError = null;
    this.child = null;
    this._buf = '';
  }

  get argv() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (this.model) args.push('--model', this.model);
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode);
    if (this.resumeFrom) args.push('--resume', this.resumeFrom);
    return args;
  }

  start() {
    const args = this.argv;
    let child;
    try {
      child = spawn(this.cli, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { CLAUDE_CODE_ENTRYPOINT: 'ccweb' }),
      });
    } catch (err) {
      this.status = 'error';
      this.lastError = String(err && err.message ? err.message : err);
      this._push({ type: 'ccweb', subtype: 'spawn_error', message: this.lastError });
      return this;
    }

    this.child = child;
    this.status = 'idle';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));

    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBuf += chunk;
      const lines = errBuf.split('\n');
      errBuf = lines.pop();
      for (const line of lines) this._onStderrLine(line);
    });

    child.on('error', (err) => {
      this.status = 'error';
      this.lastError = String(err && err.message ? err.message : err);
      this._push({ type: 'ccweb', subtype: 'process_error', message: this.lastError });
    });

    child.on('close', (code, signal) => {
      if (errBuf.trim()) this._onStderrLine(errBuf);
      this.child = null;
      this.status = this.status === 'error' ? 'error' : 'exited';
      this._push({ type: 'ccweb', subtype: 'exit', code, signal });
      this.emit('exit', { code, signal });
    });

    this._push({ type: 'ccweb', subtype: 'spawned', argv: [this.cli].concat(args) });
    return this;
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        this._push({ type: 'ccweb', subtype: 'unparsed', message: line.slice(0, 500) });
        continue;
      }
      this._handleEvent(evt);
    }
  }

  _onStderrLine(line) {
    const text = line.trim();
    if (!text) return;
    this._push({ type: 'ccweb', subtype: 'stderr', message: text.slice(0, 2000) });
  }

  _handleEvent(evt) {
    if (evt && evt.type === 'system' && evt.subtype === 'init') {
      this.cliSessionId = evt.session_id || this.cliSessionId;
      if (!this.title) this.title = evt.session_id ? `会话 ${String(evt.session_id).slice(0, 8)}` : null;
    }
    if (evt && evt.type === 'result') {
      this.status = 'idle';
      this.lastResult = {
        cost: evt.total_cost_usd || 0,
        durationMs: evt.duration_ms || 0,
        numTurns: evt.num_turns || 0,
        usage: evt.usage || null,
        stopReason: evt.stop_reason || null,
      };
    }
    this._push(evt);
  }

  _push(evt) {
    const record = Object.assign({}, evt, { _seq: this.seq++, _ts: Date.now() });
    this.events.push(record);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit('event', record);
  }

  write(payload) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('会话进程未运行，无法写入');
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  /** 发送一条用户消息 */
  send(text) {
    if (!text) throw new Error('消息为空');
    if (!this.child) throw new Error('会话进程已退出，请新建会话');
    this.status = 'running';
    this._push({ type: 'user', message: { role: 'user', content: text } });
    this.write({ type: 'user', message: { role: 'user', content: text } });
    return true;
  }

  /** 中断当前轮次 */
  interrupt() {
    this.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
    return true;
  }

  /** 答复权限审批（can_use_tool） */
  respondControl(requestId, behavior, message, updatedInput) {
    const response =
      behavior === 'allow'
        ? { behavior: 'allow', updatedInput: updatedInput || {} }
        : { behavior: 'deny', message: message || '用户在 Web 端拒绝了这次工具调用' };
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    return true;
  }

  setPermissionMode(mode) {
    this.permissionMode = mode;
    this.write({
      type: 'control_request',
      request_id: `perm-${randomUUID()}`,
      request: { subtype: 'set_permission_mode', mode },
    });
    return true;
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch (err) {
        /* 已退出 */
      }
    }
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      cli: this.cli,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      cliSessionId: this.cliSessionId,
      title: this.title,
      createdAt: this.createdAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      resumeFrom: this.resumeFrom,
    };
  }
}

/** 工作目录 -> Claude Code 的项目目录名（/data/workspace -> -data-workspace） */
function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 读取历史会话（来自 ~/.tclaude/projects/<slug>/*.jsonl 的第一行），用于 --resume 续聊。
 */
function listHistory(tclaudeHome, cwd, limit = 20) {
  const dir = path.join(tclaudeHome, 'projects', projectSlug(cwd));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    return [];
  }
  const items = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
      const obj = JSON.parse(firstLine);
      const stat = fs.statSync(full);
      items.push({
        sessionId: obj.sessionId || obj.session_id || f.replace(/\.jsonl$/, ''),
        cwd: obj.cwd || cwd,
        timestamp: obj.timestamp || stat.mtime.toISOString(),
        mtime: stat.mtimeMs,
        file: full,
      });
    } catch (err) {
      /* 跳过坏文件 */
    }
  }
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return items.slice(0, limit);
}

module.exports = { Session, listHistory, projectSlug };

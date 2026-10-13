'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

/**
 * 极简 .env 加载：只补环境里没有的变量，不覆盖已有的。
 * .env 已被 .gitignore 忽略，令牌不要提交进仓库。
 */
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'CCWEB_TOKEN' && !String(m[2]).trim()) continue; // 留空视为不启用
    let val = m[2].trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadDotEnv();

// tclaude 的配置目录是 ~/.tclaude（不是 ~/.claude）
const TCLAUDE_HOME = process.env.TCLAUDE_HOME || path.join(HOME, '.tclaude');

// 实测（同一条 "只回复两个字：收到" 请求）单次调用成本，取最便宜的作为调试默认模型
const CHEAPEST_MODEL = 'claude-haiku-4-5';

const FALLBACK_MODELS = [
  { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
  { id: 'claude-sonnet-5-5[1m]', name: 'claude-sonnet-5-5[1m]' },
  { id: 'claude-sonnet-5[1m]', name: 'claude-sonnet-5[1m]' },
  { id: 'claude-opus-5-5[1m]', name: 'claude-opus-5-5[1m]' },
  { id: 'claude-opus-5[1m]', name: 'claude-opus-5[1m]' },
];

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function loadGatewayModels() {
  const file = path.join(TCLAUDE_HOME, 'cache', 'gateway-models.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = (raw.models || [])
      .map((m) => ({ id: m.id, name: m.displayName || m.name || m.id }))
      .filter((m) => !!m.id);
    if (models.length) return { source: file, fetchedAt: raw.fetchedAt || null, models };
  } catch (err) {
    // 文件不存在或解析失败时走兜底列表
  }
  return { source: null, fetchedAt: null, models: FALLBACK_MODELS };
}

function parseRoots(raw) {
  return String(raw || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

const config = {
  host: process.env.CCWEB_HOST || '127.0.0.1',
  port: Number(process.env.CCWEB_PORT || 18787),
  // 设了之后所有接口都要带这个 token，配合非 localhost 暴露时必须打开
  token: process.env.CCWEB_TOKEN || '',
  cli: process.env.CCWEB_CLI || 'tclaude',
  defaultModel: process.env.CCWEB_MODEL || CHEAPEST_MODEL,
  defaultCwd: process.env.CCWEB_CWD || process.cwd(),
  permissionMode: process.env.CCWEB_PERMISSION_MODE || 'acceptEdits',
  allowedRoots: parseRoots(process.env.CCWEB_ALLOWED_ROOTS),
  maxSessions: Number(process.env.CCWEB_MAX_SESSIONS || 32),
  readOnly: process.env.CCWEB_READ_ONLY === '1',
  tclaudeHome: TCLAUDE_HOME,
  // Claude Code 自己的会话记录目录，TUI 模式下 Web 靠 tail 这里的文件拿到结构化内容
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || TCLAUDE_HOME,
  // 本地 tc 会话的落盘目录：*.jsonl（事件流）、*.fifo（输入）、*.meta.json（元信息）
  runDir: process.env.CCWEB_RUN_DIR || path.join(HOME, '.cache', 'ccweb'),
  cheapestModel: CHEAPEST_MODEL,
  permissionModes: PERMISSION_MODES,
};

config.gatewayModels = loadGatewayModels();

/**
 * 校验会话工作目录：必须是真实存在的目录；若配置了白名单，必须落在白名单内。
 */
function validateCwd(cwd) {
  let resolved;
  try {
    resolved = path.resolve(String(cwd || ''));
  } catch (err) {
    return { ok: false, error: '非法路径' };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return { ok: false, error: `目录不存在: ${resolved}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `不是目录: ${resolved}` };
  if (config.allowedRoots.length) {
    const inside = config.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!inside) {
      return {
        ok: false,
        error: `目录不在白名单内: ${resolved}（允许: ${config.allowedRoots.join(', ')}）`,
      };
    }
  }
  return { ok: true, cwd: resolved };
}

module.exports = { config, validateCwd, loadGatewayModels };

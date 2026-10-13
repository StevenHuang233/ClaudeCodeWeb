'use strict';

/**
 * 管理 Claude Code 的两类配置：
 *   - 子 agent：<config>/agents/*.md（YAML frontmatter + 正文）
 *   - 权限设置：<config>/settings.json 里的 permissions.allow / deny
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

function agentsDir() {
  const d = path.join(config.claudeConfigDir, 'agents');
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    /* ignore */
  }
  return d;
}

function parseFrontmatter(text) {
  const m = String(text).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return { meta, body: m[2] };
}

function listAgents() {
  const d = agentsDir();
  let files = [];
  try {
    files = fs.readdirSync(d).filter((f) => f.endsWith('.md'));
  } catch (err) {
    return [];
  }
  return files.map((f) => {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(d, f), 'utf8');
    } catch (err) {
      /* ignore */
    }
    const { meta, body } = parseFrontmatter(raw);
    return {
      file: f,
      name: meta.name || f.replace(/\.md$/, ''),
      description: meta.description || '',
      tools: meta.tools || '',
      body,
    };
  });
}

function saveAgent(name, data) {
  const safe = String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('名称只能包含字母数字、下划线和短横线');
  const lines = ['---', `name: ${safe}`];
  if (data.description) lines.push(`description: ${data.description}`);
  if (data.tools) lines.push(`tools: ${data.tools}`);
  lines.push('---', '');
  const content = lines.join('\n') + (data.body || '');
  fs.writeFileSync(path.join(agentsDir(), `${safe}.md`), content);
  return { name: safe, file: `${safe}.md` };
}

function deleteAgent(name) {
  const safe = String(name || '').replace(/[^A-Za-z0-9_-]/g, '');
  const f = path.join(agentsDir(), `${safe}.md`);
  if (!fs.existsSync(f)) throw new Error('该 agent 不存在');
  fs.unlinkSync(f);
  return { name: safe };
}

/* ------------------------------ settings ------------------------------ */

function settingsPath() {
  return path.join(config.claudeConfigDir, 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeSettings(obj) {
  try {
    fs.mkdirSync(config.claudeConfigDir, { recursive: true });
  } catch (err) {
    /* ignore */
  }
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
  return obj;
}

module.exports = { listAgents, saveAgent, deleteAgent, readSettings, writeSettings, agentsDir, settingsPath };

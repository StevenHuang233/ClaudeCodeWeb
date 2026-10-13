'use strict';

/**
 * 模型权限探测：对每个模型发一条最小请求，判断当前账号能不能用。
 * 结果缓存到 <runDir>/model-probe.json，不用每次都花钱重测。
 * 用异步 execFile，避免探测期间把服务事件循环堵死。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('./config');

function cachePath() {
  return path.join(config.runDir, 'model-probe.json');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(data, null, 2));
  } catch (err) {
    /* ignore */
  }
}

function matchLine(text, re) {
  for (const line of String(text || '').split('\n')) {
    if (re.test(line)) return line.trim().slice(0, 200);
  }
  return '';
}

function classify(stdout, stderr) {
  const all = `${stdout || ''}\n${stderr || ''}`;
  if (/PermissionDenied|Model is blocked|not allowed to access/i.test(all)) {
    return { status: 'blocked', detail: matchLine(all, /PermissionDenied|Model is blocked|not allowed to access/i) };
  }
  if (/\b429\b|Too Many Requests|RateLimit|No fallback model group/i.test(all)) {
    return { status: 'rate_limited', detail: matchLine(all, /\b429\b|Too Many Requests|RateLimit|No fallback/i) };
  }
  if (/Invalid model name/i.test(all)) return { status: 'invalid', detail: '模型名无效' };
  if (/Budget has been exceeded/i.test(all)) return { status: 'budget', detail: '额度耗尽' };
  return null;
}

function probeOne(model, cwd) {
  return new Promise((resolve) => {
    const input = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';
    const child = execFile(
      config.cli,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model],
      { cwd, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errText = String(stderr || '') || String((err && err.message) || '');
        const bad = classify(out, errText);
        if (bad) return resolve(Object.assign({ model }, bad));

        for (const line of out.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const o = JSON.parse(t);
            if (o.type === 'result') {
              if (o.is_error) return resolve({ model, status: 'error', detail: String(o.result || '').slice(0, 200) });
              return resolve({ model, status: 'ok', cost: o.total_cost_usd || 0 });
            }
          } catch (e) {
            /* 继续 */
          }
        }
        resolve({ model, status: 'unknown', detail: (errText || '没有拿到 result 事件').slice(0, 200) });
      }
    );
    if (child.stdin) {
      child.stdin.end(input);
      child.stdin.on('error', () => {});
    }
  });
}

async function probeAll(models, cwd, force, only) {
  if (!force) {
    const cached = readCache();
    if (cached && cached.results) return cached;
  }

  let list = (models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  if (only && only.length) {
    const set = new Set(only);
    list = list.filter((m) => set.has(m));
  }

  const results = [];
  for (const m of list) results.push(await probeOne(m, cwd));

  // 只探测部分模型时，把旧结果合并回来
  let final = results;
  if (only && only.length) {
    const old = (readCache() || {}).results || [];
    const map = new Map(old.map((r) => [r.model, r]));
    for (const r of results) map.set(r.model, r);
    final = Array.from(map.values());
  }

  const data = { probedAt: Date.now(), cwd, results: final };
  writeCache(data);
  return data;
}

module.exports = { probeAll, probeOne, readCache };

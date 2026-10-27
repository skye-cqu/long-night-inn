#!/usr/bin/env node
/**
 * live-gen-proxy.mjs — N7「乱流今夜现缝」本地代理（E11/C5）。
 *
 * 【演示用，禁止公网部署（无鉴权）】——本服务不校验任何调用方身份，仅限本机
 * localhost 演示「世界现场生成」缝：浏览器（游戏页 5199）不持有任何密钥，
 * AHOLE_API_KEY 只在服务端从 .env 读取（红线 §3：密钥不进客户端）。
 *
 * 端口 5177，CORS 允许 http://localhost:5199 / http://127.0.0.1:5199。
 * 路由（转发 Aholo OpenAPI v1，网关 https://api.aholo3d.cn，鉴权 Authorization: <key> 无 Bearer）：
 *   GET  /health        → { ok: true }（游戏侧 2s 探测：可达=晨间显示「现场生成」次选按钮）
 *   POST /gen {prompt}  → { id }——同 prompt 会话内只 create 一次（缓存复用；防重复下单扣费）
 *   GET  /status/{id}   → { status, spz? }——终态 SUCCEEDED 附 spz 直链
 *
 * 用法：node scripts/live-gen-proxy.mjs   （在 游戏工程/ 目录下；.env 向上查找）
 * 注意：本脚本属 E11 任务书 C5 范围，验收只验 /health 探测与回落链，不实际调 /gen。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5177;
const GATEWAY = 'https://api.aholo3d.cn';
const ALLOWED_ORIGINS = new Set(['http://localhost:5199', 'http://127.0.0.1:5199']);

// ---- .env 读取（服务端持有；向上查找仓库根） ----
function readEnv(key) {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [process.cwd(), here, resolve(here, '..'), resolve(here, '..', '..')]) {
    const p = resolve(dir, '.env');
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return process.env[key] ?? null;
}

const AHOLE_API_KEY = readEnv('AHOLE_API_KEY');

// ---- 会话内任务表：id → { promptHash, worldId, lastStatus, spz } ----
/** @type {Map<string, {promptHash: string, worldId: string|null, lastStatus: string|null, spz: string|null}>} */
const tasks = new Map();
const byPromptHash = new Map(); // promptHash → id（同 prompt 只 create 一次）

const hash = (s) => {
  let h = 0;
  for (const c of s) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return 'p' + (h >>> 0).toString(36);
};

async function apiCreateGeneration(prompt) {
  const resp = await fetch(`${GATEWAY}/world/v1/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AHOLE_API_KEY, 'x-source': 'skills' },
    body: JSON.stringify({ prompt }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`create HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
  const worldId = body?.worldId ?? body?.data?.worldId ?? null;
  if (!worldId) throw new Error(`create 未返回 worldId: ${JSON.stringify(body).slice(0, 200)}`);
  return worldId;
}

async function apiGetWorld(worldId) {
  const resp = await fetch(`${GATEWAY}/world/v1/${worldId}`, {
    headers: { authorization: AHOLE_API_KEY },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`get HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
  const d = body?.data ?? body;
  return { status: d?.status ?? 'UNKNOWN', spz: d?.spzPath ?? d?.spz ?? null };
}

function cors(req, res) {
  const origin = req.headers.origin ?? '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health —— 游戏侧 2s 探测端点（不触发任何上游调用）
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, keyLoaded: !!AHOLE_API_KEY });
    return;
  }

  // POST /gen {prompt} —— 同 prompt 会话内只 create 一次
  if (req.method === 'POST' && url.pathname === '/gen') {
    if (!AHOLE_API_KEY) {
      json(res, 503, { error: '服务端未找到 AHOLE_API_KEY（检查 .env）' });
      return;
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { prompt } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!prompt || typeof prompt !== 'string') {
        json(res, 400, { error: 'body 需为 {prompt: string}' });
        return;
      }
      const ph = hash(prompt);
      const existing = byPromptHash.get(ph);
      if (existing) {
        json(res, 200, { id: existing, cached: true });
        return;
      }
      const worldId = await apiCreateGeneration(prompt);
      const id = worldId;
      tasks.set(id, { promptHash: ph, worldId, lastStatus: null, spz: null });
      byPromptHash.set(ph, id);
      console.log(`[live-gen] create ok: ${id} (prompt ${ph})`);
      json(res, 200, { id });
    } catch (e) {
      console.warn('[live-gen] create 失败:', e.message);
      json(res, 502, { error: e.message });
    }
    return;
  }

  // GET /status/{id} → { status, spz? }
  const st = url.pathname.match(/^\/status\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && st) {
    const id = st[1];
    const t = tasks.get(id);
    if (!t) {
      json(res, 404, { error: `未知任务 ${id}（代理重启后会话丢失）` });
      return;
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMEOUT', 'REJECTED'].includes(t.lastStatus ?? '')) {
      json(res, 200, { id, status: t.lastStatus, spz: t.spz });
      return;
    }
    try {
      const r = await apiGetWorld(t.worldId);
      t.lastStatus = r.status;
      if (r.status === 'SUCCEEDED' && r.spz) t.spz = r.spz;
      json(res, 200, { id, status: r.status, spz: t.spz ?? undefined });
    } catch (e) {
      console.warn('[live-gen] get 失败:', e.message);
      json(res, 200, { id, status: 'POLL_ERROR', error: e.message });
    }
    return;
  }

  json(res, 404, { error: 'not found（/health · POST /gen · /status/{id}）' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[live-gen] 代理就绪 http://127.0.0.1:${PORT} （演示用，禁止公网部署·无鉴权）`);
  console.log(`[live-gen] AHOLE_API_KEY ${AHOLE_API_KEY ? '已加载（.env）' : '未找到——/gen 将返回 503'}`);
});

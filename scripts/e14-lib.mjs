/**
 * e14-lib.mjs — E14 全局验收自动化公共库（零 AI 生成调用）。
 *
 * 背景：MCP playwright 浏览器在锁屏下隐藏页 rAF 停摆（fps=0、stage 卡死）——E14 必须
 * 自起本机 Chrome（headed + 反后台化 flag 组），rAF 在锁屏/遮挡下继续跑。
 *
 * 内容：
 * - launchBrowser()：playwright-core + channel:'chrome'，四枚反后台化 flag（见 LAUNCH_ARGS）
 * - injectProbe(page)：scripts/test-helpers/probe-installer.js 全文经
 *   page.evaluate(new Function(src)) 注入（线上无 /scripts/ 路径，dev-only fetch 不可用）
 * - installWalker(page)：精走器（页面侧 90ms 步进穿拾，见 WALKER_SRC 注）
 * - loadVoxelGraph(night)：体素路径规划器（Node 侧，plan-n*-points 同族口径）
 * - attachDiagnostics/finalErrors：console/pageerror/4xx/崩溃收集 + 已知噪音剔除
 * - waitStage / rafProbe / playTitleToDive 等 UI 流程件
 */
import { chromium } from 'playwright-core';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEPLOY_URL = process.env.E14_URL || 'https://skye-cqu.github.io/long-night-inn/';
const HERE = dirname(fileURLToPath(import.meta.url));

/** 留痕输出目录：过程留痕/2026-10-27/E14-全局验收/（相对本脚本 = 工程根/../过程留痕/...） */
export const OUT_DIR = join(HERE, '..', '..', '过程留痕', '2026-10-27', 'E14-全局验收');

/** 反后台化 flag（锁屏/遮挡下保证 rAF 与 timer 不停摆——E14 任务书指定） */
export const LAUNCH_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--autoplay-policy=no-user-gesture-required',
];

export async function launchBrowser() {
  return chromium.launch({ channel: 'chrome', headless: false, args: LAUNCH_ARGS });
}

/** 探针源（幂等安装 window.__probe：pump/sample/hopTo/watch/verifyState） */
const PROBE_SRC = readFileSync(join(HERE, 'test-helpers', 'probe-installer.js'), 'utf8');
export function injectProbe(page) {
  return page.evaluate(new Function(PROBE_SRC));
}

/**
 * 精走器（页面侧，90ms 步进）：probe.hopTo 的 0.5s hop 粒度在冲刺下过冲回弹
 * （5m 支路 5 跳 ≈ 2.1m/s 均速）+ 每跳 evaluate 往返延迟，赶不上抓捕后 7s 饱食窗。
 * 本走器整段计划单次 evaluate 页内执行：沿途连续移动、穿拾（d<1.35 时 api.pickup）、
 * 近目标收油门防过冲。仍只用 setInput/setYaw/setSprint/pickup 调试 API，不碰游戏代码。
 * plan: [{ id, x, z, pick?: true, r?: 到点半径 }]；opts: { sprint, timeoutSec }
 */
const WALKER_SRC = `
window.__e14Walk = async function (plan, opts) {
  const o = Object.assign({ sprint: true, timeoutSec: 25 }, opts || {});
  const g = () => window.__game;
  const trace = [];
  const t0 = performance.now();
  const deadline = t0 + o.timeoutSec * 1000;
  for (const wp of plan) {
    let picked = !wp.pick;
    let gaveUp = false;
    while (performance.now() < deadline) {
      const p = g().getPos();
      const d = Math.hypot(wp.x - p.x, wp.z - p.z);
      if (wp.pick && !picked && d < 1.35) picked = !!g().api.pickup();
      if (d < (wp.r || 0.55) || (wp.pick && picked)) break;
      g().setYaw(Math.atan2(wp.z - p.z, wp.x - p.x));
      g().setSprint(!!o.sprint && d > 1.6);
      g().setInput(1, 0);
      await new Promise((r) => setTimeout(r, 90));
    }
    g().setInput(0, 0);
    g().setSprint(false);
    trace.push({ id: wp.id, picked: wp.pick ? picked : undefined, dist: +(Math.hypot(wp.x - g().getPos().x, wp.z - g().getPos().z)).toFixed(2), ms: Math.round(performance.now() - t0) });
    if (performance.now() >= deadline) gaveUp = true;
    if (gaveUp) break;
  }
  return { trace, done: performance.now() < deadline };
};
`;
export function installWalker(page) {
  return page.evaluate(new Function(WALKER_SRC));
}

/**
 * 体素路径规划器（Node 侧，离线读 public/assets 的 nav.json + 体素 bin——与玩家碰撞
 * 同一份数据）。口径照抄工程选点脚本 plan-n3-points.mjs 起的定版模型（开发者用它保证
 * 七夜信物可达，实测七夜 出生→每信物→门 全可达）：
 *   地面 = 该夜 world-nN.nav.json 的 floorGridPos（带限锚定高度场）；
 *   墙   = 地面+0.2..1.6m 内连续实心 ≥0.5m（薄植被可穿，与玩家胶囊一致）；
 *   连通 = 4 邻接可走格 BFS（不做 Δfloor 门——微型地形由胶囊/自动踏步自理，图管粗拓扑）；
 *   路径 → 贪心折线平滑（连线沿途 0.25m 采样均在可走格）。
 * 教训备案：①nav 高度场直接做 Δy 门控的图会碎成单格（N2 实测连通块=1）；②底向上首
 * 实心 colTop（plan-n2 旧口径）在 N3+/多层场景会把兴趣点判成不可达——必须按 nav 带面。
 */
const voxelGraphs = new Map();
export function loadVoxelGraph(night) {
  if (voxelGraphs.has(night)) return voxelGraphs.get(night);
  const suffix = night === 1 ? '' : `-n${night}`;
  const dir = join(HERE, '..', 'public', 'assets');
  const meta = JSON.parse(readFileSync(join(dir, `collision${suffix}.voxel-meta.json`), 'utf8'));
  const bin = readFileSync(join(dir, `collision${suffix}.voxel.bin`));
  const nav = JSON.parse(readFileSync(join(dir, `world-n${night}.nav.json`), 'utf8'));
  const allU32 = new Uint32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + Math.floor(bin.byteLength / 4) * 4));
  const nodes = allU32.slice(0, meta.nodeCount >>> 0);
  const leafData = allU32.slice(meta.nodeCount >>> 0, (meta.nodeCount >>> 0) + (meta.leafDataCount >>> 0));
  const gMin = meta.gridBounds.min, gMax = meta.gridBounds.max, vs = meta.voxelResolution;
  const CX = Math.round((gMax[0] - gMin[0]) / vs);
  const CY = Math.round((gMax[1] - gMin[1]) / vs);
  const CZ = Math.round((gMax[2] - gMin[2]) / vs);
  const SOLID = 0xff000000 >>> 0;
  const popcount = (n) => { n >>>= 0; n -= (n >>> 1) & 0x5555555; n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
  const leaf = (n, ix, iy, iz) => {
    const idx = n & 0xffffff, bit = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
    const lo = leafData[idx * 2] >>> 0;
    if (bit < 32) return ((lo >>> bit) & 1) === 1;
    return (((leafData[idx * 2 + 1] >>> 0) >>> (bit - 32)) & 1) === 1;
  };
  const solid = (ix, iy, iz) => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= CX || iy >= CY || iz >= CZ) return false;
    const bx = (ix / 4) | 0, by = (iy / 4) | 0, bz = (iz / 4) | 0;
    let node = 0;
    for (let level = meta.treeDepth - 1; level >= 0; level--) {
      const n = nodes[node] >>> 0;
      if (n === SOLID) return true;
      const mask = (n >>> 24) & 0xff;
      if (mask === 0) return leaf(n, ix, iy, iz);
      const oct = (((bz >>> level) & 1) << 2) | (((by >>> level) & 1) << 1) | ((bx >>> level) & 1);
      if (!(mask & (1 << oct))) return false;
      node = (n & 0xffffff) + popcount(mask & ((1 << oct) - 1));
    }
    const n = nodes[node] >>> 0;
    return n === SOLID ? true : leaf(n, ix, iy, iz);
  };
  const CELL = nav.cellSize;
  const NX = nav.nx, NZ = nav.nz;
  const fl = nav.floorGridPos; // +Y up（七夜均如此；?up=-1 仅对照调试）
  const blocked = new Uint8Array(NX * NZ);
  let walkable = 0;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    const f = fl[k];
    if (f === null) { blocked[k] = 2; continue; }
    const wx = nav.bboxMin[0] + (i + 0.5) * CELL, wz = nav.bboxMin[2] + (j + 0.5) * CELL;
    const gx = Math.floor((wx - gMin[0]) / vs), gz = Math.floor((wz - gMin[2]) / vs);
    let run = 0, maxRun = 0;
    for (let y = f + 0.2; y < f + 1.6; y += vs) {
      if (solid(gx, Math.floor((y - gMin[1]) / vs), gz)) { run += vs; if (run > maxRun) maxRun = run; } else run = 0;
    }
    blocked[k] = maxRun >= 0.5 ? 1 : 0;
    if (!blocked[k]) walkable++;
  }
  const cellOf = (x, z) => [Math.floor((x - nav.bboxMin[0]) / CELL), Math.floor((z - nav.bboxMin[2]) / CELL)];
  const walkIdx = (i, j) => (i >= 0 && j >= 0 && i < NX && j < NZ && blocked[j * NX + i] === 0) ? j * NX + i : -1;
  /** 吸附到 ≤4 格内最近可走格（信物坐标常落在带缘/凹室内） */
  const snapIdx = (x, z) => {
    const [ix, iz] = cellOf(x, z);
    const direct = walkIdx(ix, iz);
    if (direct >= 0) return direct;
    let best = -1, bd = 1e9;
    for (let r = 1; r <= 4; r++)
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const k = walkIdx(ix + dx, iz + dz);
        if (k >= 0) { const dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; best = k; } }
      }
    return best;
  };
  const wpos = (k) => ({ x: +(nav.bboxMin[0] + ((k % NX) + 0.5) * CELL).toFixed(2), z: +(nav.bboxMin[2] + (((k / NX) | 0) + 0.5) * CELL).toFixed(2) });
  const graph = {
    NX, NZ, stats: { walkable, total: NX * NZ },
    /** (x,z) → 格 idx（学习动态障碍用） */
    cellIdxAt(x, z) {
      const [ix, iz] = cellOf(x, z);
      return (ix >= 0 && iz >= 0 && ix < NX && iz < NZ) ? iz * NX + ix : -1;
    },
    /** BFS 最短路（4 邻接可走格；extra=运行期学到的「实走撞墙」格集合，一并视作不可走）
     *  → 折线 waypoint（贪心平滑）；不可达 null */
    path(from, to, extra) {
      const s = snapIdx(from.x, from.z), t = snapIdx(to.x, to.z);
      if (s < 0 || t < 0) return null;
      const bad = (k) => (extra && extra.has(k)) || false;
      const prev = new Int32Array(NX * NZ).fill(-2);
      prev[s] = -1;
      const q = [s];
      let found = s === t;
      for (let h = 0; h < q.length && !found; h++) {
        const c = q[h], ci = c % NX, cj = (c / NX) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = walkIdx(ci + dx, cj + dz);
          if (k < 0 || prev[k] !== -2 || bad(k)) continue;
          prev[k] = c;
          if (k === t) { found = true; break; }
          q.push(k);
        }
      }
      if (!found) return null;
      const cells = [];
      for (let c = t; c !== -1; c = prev[c]) cells.unshift(c);
      const pts = cells.map((k) => wpos(k));
      const clearSeg = (a, b) => { // 两点连线沿途 0.25m 采样均在可走格（且非学习障碍格）
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
        for (let i = 1; i < steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps, z = a.z + ((b.z - a.z) * i) / steps;
          const k = walkIdx(...cellOf(x, z));
          if (k < 0 || bad(k)) return false;
        }
        return true;
      };
      const out = [];
      let i = 0;
      while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && !clearSeg(pts[i], pts[j])) j--;
        out.push(pts[j]);
        i = j;
      }
      return out;
    },
  };
  voxelGraphs.set(night, graph);
  return graph;
}

/** B4 已知噪音（aholo-viewer 引擎层 GL 警告，E11 验收报告 item B4，不影响玩法） */
const NOISE_PATTERNS = [
  /GL_INVALID_OPERATION/i,
  /glDrawElements/i,
  /vertex shader input type/i,
  /WebGL\s*[:：]/i,
];
export function isNoise(text) {
  return NOISE_PATTERNS.some((r) => r.test(String(text)));
}

/** 页面诊断收集：非噪音 console.error / 未捕获异常 / ≥400 响应 / 页面崩溃 */
export function attachDiagnostics(page, sink) {
  page.on('console', (m) => {
    const type = m.type();
    const text = m.text();
    sink.console.push({ type, text: String(text).slice(0, 260) });
    if (type === 'error' && !isNoise(text)) sink.errors.push(`console.error: ${String(text).slice(0, 260)}`);
    if (type === 'warning' && !isNoise(text)) {
      // 非 GL 噪音的 warning 留采样（前缀 60 字符聚合计数——生产首验要知道还有什么在响）
      const key = String(text).slice(0, 60);
      sink.warnSamples[key] = (sink.warnSamples[key] || 0) + 1;
    }
  });
  page.on('pageerror', (e) => sink.errors.push(`pageerror: ${String(e && e.message ? e.message : e).slice(0, 260)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) sink.responses.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const err = r.failure() && r.failure().errorText;
    sink.requestFailed.push({ url: r.url(), err: err || '' });
  });
  page.on('crash', () => sink.errors.push('page-crash'));
  return sink;
}

export function newSink() {
  return { console: [], errors: [], responses: [], crashed: false, warnSamples: {}, requestFailed: [] };
}

/**
 * 终判错误清单：N7 livegen 缝按设计探测 http://localhost:5177/health（代理只在现场演示
 * 机器上跑，见 scripts/live-gen-proxy.mjs），不可达时 Chrome 把该次资源加载记为
 * console.error(net::ERR_CONNECTION_REFUSED)——游戏侧行为正确（摘除按钮走烘焙，E11
 * item 8c 已验收）。此条件下的 REFUSED 控制台错误按已知噪音剔除（与 5177 请求失败
 * 事件关联核对）；除此之外的错误照算。
 */
export function finalErrors(sink) {
  const livegenProbeRefused = sink.requestFailed.some(
    (f) => /:5177\//.test(f.url) && /ERR_CONNECTION_REFUSED/.test(f.err),
  );
  if (!livegenProbeRefused) return sink.errors;
  return sink.errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
}

/** 等 __game.night.stage === stage（游戏状态机阶段，polling 游戏侧 250ms） */
export function waitStage(page, stage, timeout = 90_000) {
  return page.waitForFunction(
    (s) => window.__game && window.__game.night && window.__game.night.stage === s,
    stage,
    { timeout, polling: 250 },
  );
}

export function nightDebug(page) {
  return page.evaluate(() => window.__game && window.__game.night);
}
export function gameState(page) {
  return page.evaluate(() => window.__game && window.__game.state);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标题→晨间→穿缝→下潜 的 UI 流程驱动（E3 核心剧本公共段） */
export async function playTitleToDive(page, { archetypeIdx = 0, diveTimeout = 120_000 } = {}) {
  await page.waitForSelector('.g-title', { timeout: 60_000 });
  await page.locator('.g-arch-card').nth(archetypeIdx).click();
  await page.locator('.g-title .g-btn.primary').click();
  await page.waitForSelector('.g-morning', { timeout: 15_000 });
  await page.locator('.g-morning .g-btn.primary').click();
  await waitStage(page, 'dive', diveTimeout);
}

/** rAF 帧推进计数（harness 验证：锁屏下 rAF 是否活着） */
export async function rafProbe(page, ms = 3000) {
  await page.evaluate(() => {
    window.__rafCount = 0;
    const f = () => { window.__rafCount++; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await sleep(ms);
  return page.evaluate(() => ({ raf: window.__rafCount | 0, fps: (window.__game && window.__game.state.fps) || 0 }));
}

/** 结果落 JSONL（appendFileSync，逐行即时写——防长跑中断丢数据） */
export function appendJsonl(file, obj) {
  appendFileSync(file, JSON.stringify(obj) + '\n');
}

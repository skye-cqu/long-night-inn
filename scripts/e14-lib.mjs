/**
 * e14-lib.mjs — E14 全局验收自动化公共库（零 AI 生成调用）。
 *
 * 背景：MCP playwright 浏览器在锁屏下隐藏页 rAF 停摆（fps=0、stage 卡死）——E14 必须
 * 自起本机 Chrome（headed + 反后台化 flag 组），rAF 在锁屏/遮挡下继续跑。
 *
 * 内容：
 * - launchBrowser()：playwright-core + channel:'chrome'，四枚反后台化 flag（见 LAUNCH_ARGS）
 * - injectProbe(page)：把 scripts/test-helpers/probe-installer.js 全文经
 *   page.evaluate(new Function(src)) 注入（线上无 /scripts/ 路径，dev-only fetch 不可用）
 * - attachDiagnostics(page)：console/pageerror/4xx 响应收集；GL 警告按 B4 已知噪音过滤
 * - waitStage / step 计时与 N1 门位等测试常量（门位来自 src/game/config.ts N1，注释在案）
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
  });
  page.on('pageerror', (e) => sink.errors.push(`pageerror: ${String(e && e.message ? e.message : e).slice(0, 260)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) sink.responses.push(`${r.status()} ${r.url()}`);
  });
  page.on('crash', () => sink.errors.push('page-crash'));
  return sink;
}

export function newSink() {
  return { console: [], errors: [], responses: [], crashed: false };
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
export function getPos(page) {
  return page.evaluate(() => window.__game && window.__game.getPos());
}

/**
 * N1 关键坐标（与 src/game/config.ts N1 定义同步抄录——游戏 debug API 不暴露门位，
 * 此处是唯一硬编码；若 config 改动需同步）：
 * door (-12.3, 0.35) r1.5 / spawn (-11.8, 0.35) / loot: oil(-9.0,0.9) lantern(-4.5,-0.5) watch(0.7,0.3)
 */
export const N1 = {
  door: { x: -12.3, z: 0.35 },
  spawn: { x: -11.8, z: 0.35 },
};

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

/** 拾取全部未取信物：hopTo 实走 + api.pickup（E 键等价）兜底，返回 taken 数与明细 */
export async function collectAllLoot(page, { hop = 0.7, timeoutPerItem = 45 } = {}) {
  const items = await page.evaluate(() => window.__game.api.itemPositions());
  const detail = [];
  let taken = 0;
  for (const it of items) {
    if (it.taken) { detail.push({ id: it.id, preTaken: true }); continue; }
    const hopRes = await page.evaluate(
      ({ x, z, hop, t }) => window.__probe.hopTo(x, z, { hop, timeout: t, sprint: false }),
      { x: it.x, z: it.z, hop, t: timeoutPerItem },
    );
    const picked = await page.evaluate(() => window.__game.api.pickup());
    if (picked) taken++;
    detail.push({ id: it.id, picked, finalDist: hopRes && hopRes.finalDist, ok: hopRes && hopRes.ok });
  }
  return { taken, detail };
}

/** 走到门并归航（returnHome=endDive('return')，E 键等价的调试通道） */
export async function walkDoorAndReturn(page, door, { hop = 0.7, timeout = 45 } = {}) {
  const hopRes = await page.evaluate(
    ({ x, z, hop, t }) => window.__probe.hopTo(x, z, { hop, timeout: t, sprint: false }),
    { x: door.x, z: door.z, hop, t: timeout },
  );
  await page.evaluate(() => window.__game.setInput(0, 0));
  const dist = await page.evaluate(
    ({ x, z }) => { const p = window.__game.getPos(); return Math.hypot(p.x - x, p.z - z); },
    { x: door.x, z: door.z },
  );
  const ret = await page.evaluate(() => window.__game.api.returnHome());
  return { hopRes, doorDist: +dist.toFixed(2), returned: ret !== false };
}

/** 结算→夜谈→进度 三连（点 UI 按钮，等屏幕挂载） */
export async function playSettleTalkProgress(page) {
  await page.waitForSelector('.g-settle', { timeout: 20_000 });
  await page.locator('.g-settle .g-btn.primary').click();
  await page.waitForSelector('.g-talk', { timeout: 15_000 });
  await page.locator('.g-talk .g-btn.primary').click();
  await page.waitForSelector('.g-progress', { timeout: 15_000 });
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

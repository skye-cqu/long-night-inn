/**
 * e14-b1b3.mjs — E14 D3：B1/B3 修复的浏览器级复检（部署 URL，零 AI 生成调用）。
 *
 * B1（碰撞格边死锁，修复=自动踏步+反死锁微滑，见 过程留痕/2026-10-27/快速修复-B1碰撞死锁）：
 *   三复现点直行 10s：N7 (-11.52,-0.05) / N3 (-1.22, 0.25 任一走廊 z) / N4 门 (14.45,2.25)
 *   —— 位移 >1m 即过（修复前 45s+ 零位移）。计时以游戏 timeLeft 差为分母（口径约定）。
 * B3（同根复核，无代码改动）：N4 完整抓捕链 setSanity(0) → 盲追 → 被抓（重定位 startAt）
 *   → 重定位点 setInput(1,0) 前进 5s 位移 >1m。
 * 附：N1-N6 各夜出生点直行 10s 无卡死（复用 enterNight 跳夜，实体冻结排除抓捕传送干扰
 *   —— B1/B3 测的是碰撞位移，不是遭遇玩法；遭遇玩法由 E3 50 遍与 B3 链覆盖）。
 *
 * 用法：node scripts/e14-b1b3.mjs
 * 输出：过程留痕/2026-10-27/E14-全局验收/b1b3.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOY_URL, OUT_DIR, launchBrowser, injectProbe, attachDiagnostics, newSink, waitStage, sleep,
} from './e14-lib.mjs';

/** B1 三复现点（修复说明同款坐标）+ 各夜出生朝向（config.ts 同步抄录） */
const B1_POINTS = [
  { night: 7, label: 'B1-N7长廊(-11.52,-0.05)东向', x: -11.52, z: -0.05, yaw: 0 },
  { night: 3, label: 'B1-N3走廊(-1.22,0.25)东向', x: -1.22, z: 0.25, yaw: 0 },
  { night: 4, label: 'B1-N4门(14.45,2.25)西向', x: 14.45, z: 2.25, yaw: Math.PI },
];
const SPAWN_YAW = { 1: 0, 2: 0.98, 3: -0.22, 4: -2.68, 5: 2.36, 6: 2.16 };

async function gotoDive(page, night) {
  await page.evaluate((n) => window.__game.enterNight(n), night);
  await waitStage(page, 'morning', 60_000);
  await page.evaluate(() => window.__game.api.goto('dive'));
  await waitStage(page, 'dive', 150_000); // 世界加载门控（穿缝同款 ensureWorld）
  await page.evaluate(() => window.__game.api.entityFreeze(true)); // 排除抓捕传送干扰
}

/** 定点直行：setCam 落点（y 取当前带面 +0.3 由地面弹簧收）→ 定 yaw → setInput(1,0) → 采样。
 *  skipCam=true：不落点，从当前位置（如被抓重定位点）直接前进——B3 专用，避免
 *  setCam 的裸 position.set 绕过 onCaught→startAt 的出生碰撞解析（那正是被测代码路径）。 */
async function straightWalk(page, { x, z, yaw, seconds = 10, label, skipCam = false }) {
  if (!skipCam) {
    const y0 = (await page.evaluate(() => window.__game.getPos())).y;
    await page.evaluate(({ x, y, z, yaw }) => window.__game.setCam(x, y + 0.3, z, yaw), { x, y: y0, z, yaw });
    await sleep(800); // 地面弹簧/碰撞稳定一拍
  }
  const s0 = await page.evaluate(() => ({ p: window.__game.getPos(), t: window.__game.night.timeLeft }));
  await page.evaluate((yaw) => { window.__game.setYaw(yaw); window.__game.setInput(1, 0); }, yaw);
  await sleep(seconds * 1000);
  const s1 = await page.evaluate(() => ({ p: window.__game.getPos(), t: window.__game.night.timeLeft }));
  await page.evaluate(() => window.__game.setInput(0, 0));
  const disp = Math.hypot(s1.p.x - s0.p.x, s1.p.z - s0.p.z);
  const fwd = (s1.p.x - s0.p.x) * Math.cos(yaw) + (s1.p.z - s0.p.z) * Math.sin(yaw);
  return { label, from: { x: +s0.p.x.toFixed(2), z: +s0.p.z.toFixed(2) }, dispM: +disp.toFixed(2), forwardM: +fwd.toFixed(2), gameSec: +(s0.t - s1.t).toFixed(1), pass: disp > 1.0 };
}

/** 出生点直行（不 setCam，用 beginDive 落位原点） */
async function spawnWalk(page, night) {
  await sleep(600);
  const s0 = await page.evaluate(() => ({ p: window.__game.getPos(), t: window.__game.night.timeLeft }));
  await page.evaluate((yaw) => { window.__game.setYaw(yaw); window.__game.setInput(1, 0); }, SPAWN_YAW[night]);
  await sleep(10_000);
  const s1 = await page.evaluate(() => ({ p: window.__game.getPos(), t: window.__game.night.timeLeft }));
  await page.evaluate(() => window.__game.setInput(0, 0));
  const disp = Math.hypot(s1.p.x - s0.p.x, s1.p.z - s0.p.z);
  return { label: `N${night}出生直行(yaw=${SPAWN_YAW[night]})`, from: { x: +s0.p.x.toFixed(2), z: +s0.p.z.toFixed(2) }, dispM: +disp.toFixed(2), gameSec: +(s0.t - s1.t).toFixed(1), pass: disp > 1.0 };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = { b1: [], spawn: [], b3: null, errors: [], responses: [] };
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sink = newSink();
  attachDiagnostics(page, sink);
  try {
    await page.goto(DEPLOY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await injectProbe(page);
    await waitStage(page, 'title', 60_000);

    // ---- ① B1 三复现点 ----
    for (const pt of B1_POINTS) {
      await gotoDive(page, pt.night);
      const r = await straightWalk(page, pt);
      out.b1.push(r);
      console.log('[B1]', r.label, `disp=${r.dispM}m fwd=${r.forwardM}m game=${r.gameSec}s pass=${r.pass}`);
    }

    // ---- ② N1-N6 出生直行 ----
    for (let n = 1; n <= 6; n++) {
      await gotoDive(page, n);
      const r = await spawnWalk(page, n);
      out.spawn.push(r);
      console.log('[SPAWN]', r.label, `disp=${r.dispM}m game=${r.gameSec}s pass=${r.pass}`);
    }

    // ---- ③ B3 完整抓捕链（N4）----
    await gotoDive(page, 4);
    await page.evaluate(() => window.__game.api.entityFreeze(false)); // B3 需要真实实体
    const caught0 = (await page.evaluate(() => window.__game.night.caught)) || 0;
    // 实体挪到玩家面前 + 理智归零 → 盲追（缩短抵达时间；重定位行为本身不受影响）
    await page.evaluate(() => {
      const p = window.__game.getPos();
      window.__game.api.entityTeleport(p.x - 3.5, p.z);
      window.__game.api.setSanity(0);
    });
    const tB3 = Date.now();
    let chain = { enraged: false, caught: false };
    while (Date.now() - tB3 < 30_000) {
      const nd = await page.evaluate(() => ({
        enrage: window.__game.night.entity.enrageLeft,
        state: window.__game.night.entity.state,
        caught: window.__game.night.caught,
        pos: window.__game.getPos(),
      }));
      if (nd.enrage > 0 && nd.state === 'chase') chain.enraged = true;
      if (nd.caught > caught0) { chain.caught = true; chain.relocated = { x: +nd.pos.x.toFixed(2), z: +nd.pos.z.toFixed(2) }; break; }
      await sleep(400);
    }
    if (chain.caught) {
      // 被抓重定位后（onCaught→startAt 门位）：不 setCam，从重定位点直行 5s —— B3 复现条件
      const r = await straightWalk(page, { x: 14.45, z: 2.25, yaw: SPAWN_YAW[4], seconds: 5, label: 'B3-N4抓捕重定位后直行5s', skipCam: true });
      out.b3 = { ...chain, walk: r, pass: chain.enraged && chain.caught && r.pass };
    } else {
      out.b3 = { ...chain, pass: false, why: '30s 内未被抓获（盲追链未闭合）' };
    }
    console.log('[B3]', JSON.stringify(out.b3));

    out.errors = sink.errors.slice(0, 10);
    out.responses = sink.responses.slice(0, 10);
    out.verdict = {
      b1: out.b1.length === 3 && out.b1.every((r) => r.pass) ? 'PASS' : 'FAIL',
      b3: out.b3 && out.b3.pass ? 'PASS' : 'FAIL',
      spawn: out.spawn.length === 6 && out.spawn.every((r) => r.pass) ? 'PASS' : 'FAIL',
      errors: sink.errors.length === 0 ? 'PASS' : 'FAIL',
    };
    out.verdictAll = Object.values(out.verdict).every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
  } catch (e) {
    out.fatal = String(e && e.message ? e.message : e).slice(0, 300);
    console.error('[FATAL]', out.fatal);
  } finally {
    writeFileSync(join(OUT_DIR, 'b1b3.json'), JSON.stringify(out, null, 2));
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log('[verdict]', JSON.stringify(out.verdict || { fatal: out.fatal }));
}

main();

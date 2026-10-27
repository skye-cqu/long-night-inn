/**
 * e14-seven.mjs — E14 D2 补充：3 遍完整七夜通关（部署 URL，零 AI 生成调用）。
 *
 * 三线要求（任务书）：enterNight 跳夜 + 真实下潜/归航/结算混合，三线至少触发善/亏两线。
 * 线路构造（judgeFinale 规则见 src/game/finale.ts：亏=夜1-6 存在整夜未付 或 抢>救；
 * 乱=不亏且 caught≥3；善=其余）：
 *   A 善·花海：六夜全部付清 + 全程 caught≤2 —— N1 真实贪婪回路（抓捕后 7s 饱食窗内
 *     冲刺穿拾，caught=2，见 e14-e3 同款策略）；N2–N6 下潜/拾物/归航/结算全真实，
 *     实体经 api.entityFreeze 静默（debug 手段，报告披露——否则 N2–N6 每夜 1-2 次被抓，
 *     caught 必然 ≥3，善线无法确定性构造）；N5 首潜 58<60 文，回响重潜（±2 文抖动）
 *     至付清；N6 结算前过镜像页。
 *   B 亏·灰烬：N1/N3/N5 快潜即归（0 战利品 → unpaid），N2/N4/N6 真实满捡付清（实体
 *     全程在场，被抓不计）——三夜欠账 → 亏线短路。
 *   C 乱·奇观：N1 在 A 基础上多站桩喂一次被抓（caught=3，仍付清）；N2–N6 同 A（freeze
 *     + N5 回响补账）——不亏 + caught=3 → 乱线。
 * N7 七夜全部真实：晨间收灯人 → 终幕下潜 → 真走 16.5m 长廊 → E 告别 → 陈词 → 海报。
 *
 * 用法：node scripts/e14-seven.mjs            # 3 遍（A/B/C）
 *       E14_SEVEN=A node scripts/e14-seven.mjs
 * 输出：过程留痕/2026-10-27/E14-全局验收/seven-runs.json + 海报截图×3
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOY_URL, OUT_DIR, launchBrowser, injectProbe, installWalker, attachDiagnostics, newSink,
  waitStage, nightDebug, sleep,
} from './e14-lib.mjs';

/** 各夜门位（src/game/config.ts 同步抄录；信物位运行时 itemPositions() 取） */
const DOOR = {
  1: { x: -12.3, z: 0.35 },
  2: { x: -8.95, z: -2.45 },
  3: { x: -1.45, z: 0.75 },
  4: { x: 14.45, z: 2.25 },
  5: { x: -1.55, z: -1.45 },
  6: { x: 1.95, z: -1.75 },
  7: { x: -3.15, z: -1.35 },
};
const WATCH_N1 = { x: 0.7, z: 0.3 };

const caughtNow = async (page) => ((await nightDebug(page)).caught) || 0;
const paidOf = (page, n) => page.evaluate((n) => window.__game.api.ledger().some((r) => r.type === 'paid' && r.night === n), n);

// ---- 夜流程件 ----

async function morningDive(page, timeout = 150_000) {
  await page.locator('.g-morning .g-btn.primary').click();
  await waitStage(page, 'dive', timeout);
}

/** 页内整段：就近穿拾全部未取信物 → 到门 → returnHome（单 evaluate） */
function sweepToDoor(page, night) {
  return page.evaluate(async (door) => {
    const scratch = window.__game.api.itemPositions();
    const plan = [];
    for (;;) {
      const left = scratch.filter((it) => !it.taken);
      if (!left.length) break;
      const p = window.__game.getPos();
      left.sort((m, n) => Math.hypot(m.x - p.x, m.z - p.z) - Math.hypot(n.x - p.x, n.z - p.z));
      plan.push({ id: left[0].id, x: left[0].x, z: left[0].z, pick: true });
      left[0].taken = true;
    }
    plan.push({ id: 'door', x: door.x, z: door.z, r: 0.5 });
    const r = await window.__e14Walk(plan, { sprint: true, timeoutSec: 40 });
    return { trace: r.trace, held: window.__game.night.heldValue, taken: window.__game.api.itemPositions().filter((i) => i.taken).length };
  }, DOOR[night]).then(async (r) => ({ ...r, returned: await page.evaluate(() => window.__game.api.returnHome() !== false) }));
}

/** 结算三连（N6 先过镜像页）；返回该夜 paid */
async function screensToEnd(page, night) {
  if (night === 6) {
    await page.waitForSelector('.g-mirror', { timeout: 20_000 });
    await page.locator('.g-mirror .g-btn.primary').click();
  }
  await page.waitForSelector('.g-settle', { timeout: 20_000 });
  await page.locator('.g-settle .g-btn.primary').click();
  await page.waitForSelector('.g-talk', { timeout: 15_000 });
  await page.locator('.g-talk .g-btn.primary').click();
  await page.waitForSelector('.g-progress', { timeout: 15_000 });
  return paidOf(page, night);
}

async function nextNight(page, night) {
  await page.locator('.g-progress .g-btn.primary', { hasText: `第${'一二三四五六七'[night]}夜` }).click();
  await waitStage(page, 'morning', 60_000);
}

/** N1 贪婪回路真实潜（e14-e3 同款）：走到怀表 → 站桩喂被抓(catchTarget 次) → 饱食窗冲刺穿拾 → 门 → 归航 */
async function n1RealDive(page, catchTarget = 1) {
  await page.evaluate(
    ({ x, z }) => window.__probe.hopTo(x, z, { hop: 0.6, timeout: 45 }),
    WATCH_N1,
  );
  const c1 = await caughtNow(page);
  const t0 = Date.now();
  while ((await caughtNow(page)) < c1 + catchTarget && Date.now() - t0 < 45_000) await sleep(600);
  const caught = await caughtNow(page);
  const sweep = await sweepToDoor(page, 1);
  return { caught, ...sweep };
}

/** 一夜完整段：晨间→下潜→（模式）→结算三连。返回 { paid, mode, caught, held } */
async function runNight(page, night, mode, runId) {
  const t0 = Date.now();
  await morningDive(page);
  let out = { mode };
  if (mode === 'quick') {
    out.caught = 0;
    out.held = 0;
    out.returned = await page.evaluate(() => window.__game.api.returnHome() !== false);
  } else if (night === 1 && (mode === 'smart' || mode === 'chaos3')) {
    const r = await n1RealDive(page, mode === 'chaos3' ? 2 : 1);
    out = { ...out, ...r };
  } else {
    if (mode === 'sweep-freeze') await page.evaluate(() => window.__game.api.entityFreeze(true));
    const r = await sweepToDoor(page, night);
    out = { ...out, ...r };
  }
  out.paid = await screensToEnd(page, night);
  if (runId === 'A' && (night === 1 || night === 6)) {
    await page.screenshot({ path: join(OUT_DIR, `seven-${runId}-n${night}-结算.png`) }).catch(() => {});
  }
  out.ms = Date.now() - t0;
  return out;
}

async function sevenRun(browser, runId, plan, expectLine) {
  const t0 = Date.now();
  const rec = { runId, expectLine, nights: [], ok: false, errors: [], responses: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sink = newSink();
  attachDiagnostics(page, sink);
  try {
    await page.goto(DEPLOY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await injectProbe(page);
    await installWalker(page);
    await page.waitForSelector('.g-title', { timeout: 60_000 });
    await page.locator('.g-arch-card').nth(runId === 'B' ? 1 : 0).click();
    await page.locator('.g-title .g-btn.primary').click();
    await page.waitForSelector('.g-morning', { timeout: 15_000 });

    for (let n = 1; n <= 6; n++) {
      const spec = plan[n];
      let r = await runNight(page, n, spec.mode, runId);
      // N5 需付清的：回响重潜（±2 文抖动）直至 paid（上限 12 次）
      let replays = 0;
      while (spec.needPaid && !r.paid && replays < 12) {
        replays++;
        await page.locator('.g-progress .g-btn.ghost', { hasText: '再潜一次' }).click();
        await waitStage(page, 'dive', 120_000);
        if (spec.mode === 'sweep-freeze') await page.evaluate(() => window.__game.api.entityFreeze(true));
        const sw = await sweepToDoor(page, n);
        r.paid = await screensToEnd(page, n);
        r.held = sw.held;
        Object.assign(r, { replays });
      }
      r.night = n;
      rec.nights.push(r);
      console.log(`[${runId}] N${n} ${r.mode} paid=${r.paid} caught=${r.caught ?? 0} held=${r.held ?? '-'} replays=${r.replays ?? 0} ${r.ms}ms`);
      if (n < 6) await nextNight(page, n + 1);
    }

    // ---- N7 终幕：晨间收灯人 → 真走长廊 → E 告别 → 陈词 → 海报 ----
    const t7 = Date.now();
    await nextNight(page, 7);
    await morningDive(page);
    const filterAtDive = await page.evaluate(() => ({
      debt: document.getElementById('app').classList.contains('finale-debt'),
      chaos: document.getElementById('app').classList.contains('finale-chaos'),
    }));
    await sweepToDoor(page, 7);
    await page.waitForSelector('.g-farewell', { timeout: 20_000 });
    await page.locator('.g-farewell .g-btn.ghost').click(); // 跳过打字机
    await page.locator('.g-farewell .g-btn.primary').click(); // 走进亮门
    await page.waitForSelector('.g-poster', { timeout: 20_000 });
    await sleep(800);
    const posterLine = await page.evaluate(() => ({
      finale: window.__game.finale.line,
      rule: window.__game.finale.rule.slice(0, 40),
      ls: localStorage.getItem('long-night-inn:finale-line:v1'),
      posterTitle: document.querySelector('.fc-title') && document.querySelector('.fc-title').textContent,
      lineName: document.querySelector('.fc-line') && document.querySelector('.fc-line').textContent,
      stats: window.__game.finale.stats,
    }));
    await page.screenshot({ path: join(OUT_DIR, `seven-${runId}-海报-${posterLine.lineName || posterLine.finale}.png`) });
    rec.n7 = { filterAtDive, posterLine, ms: Date.now() - t7 };
    console.log(`[${runId}] N7 line=${posterLine.finale}(${posterLine.ls}) filter=${JSON.stringify(filterAtDive)} ${rec.n7.ms}ms`);

    // ---- 判定：线路符合 + 全夜走完 + 零错误 ----
    const st = await page.evaluate(() => window.__game.state);
    rec.errors = sink.errors.slice(0, 10);
    rec.responses = sink.responses.slice(0, 10);
    rec.allPaid = rec.nights.length === 6 && rec.nights.every((x) => x.paid === true);
    const needAllPaid = expectLine !== 'debt'; // 善/乱线要求六夜全付清（亏线反而要有欠账夜）
    rec.ok = posterLine.finale === expectLine
      && posterLine.ls === expectLine
      && rec.nights.length === 6
      && rec.errors.length === 0 && rec.responses.length === 0
      && (!needAllPaid || rec.allPaid)
      && Array.isArray(st.errors) && st.errors.length === 0;
  } catch (e) {
    rec.fatal = String(e && e.message ? e.message : e).slice(0, 300);
    console.error(`[${runId}] FATAL`, rec.fatal);
    await page.screenshot({ path: join(OUT_DIR, `seven-${runId}-fatal.png`) }).catch(() => {});
  } finally {
    rec.ms = Date.now() - t0;
    await ctx.close().catch(() => {});
  }
  return rec;
}

const PLANS = {
  A: { 1: { mode: 'smart' }, 2: { mode: 'sweep-freeze' }, 3: { mode: 'sweep-freeze' }, 4: { mode: 'sweep-freeze' }, 5: { mode: 'sweep-freeze', needPaid: true }, 6: { mode: 'sweep-freeze' }, expect: 'good' },
  B: { 1: { mode: 'quick' }, 2: { mode: 'sweep-live' }, 3: { mode: 'quick' }, 4: { mode: 'sweep-live' }, 5: { mode: 'quick' }, 6: { mode: 'sweep-live' }, expect: 'debt' },
  C: { 1: { mode: 'chaos3' }, 2: { mode: 'sweep-freeze' }, 3: { mode: 'sweep-freeze' }, 4: { mode: 'sweep-freeze' }, 5: { mode: 'sweep-freeze', needPaid: true }, 6: { mode: 'sweep-freeze' }, expect: 'chaos' },
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const which = process.env.E14_SEVEN ? [process.env.E14_SEVEN] : ['A', 'B', 'C'];
  const browser = await launchBrowser();
  const results = [];
  try {
    for (const id of which) {
      const plan = PLANS[id];
      const rec = await sevenRun(browser, id, plan, plan.expect);
      results.push(rec);
      console.log(`[${id}] ok=${rec.ok} ${rec.ms}ms`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(join(OUT_DIR, 'seven-runs.json'), JSON.stringify(results, null, 2));
  console.log('[summary]', JSON.stringify(results.map((r) => ({ id: r.runId, ok: r.ok, line: r.n7 && r.n7.posterLine && r.n7.posterLine.finale, expect: r.expectLine, ms: r.ms }))));
}

main();

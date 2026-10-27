/**
 * e14-e3.mjs — E14 D2：E3 核心剧本 50 遍自动跑（部署 URL，零 AI 生成调用）。
 *
 * 单遍剧本（≈30-60s 墙钟）：新 context（清 localStorage）→ 标题「开始」（选原型+确认）
 * → N1 晨间「推门下潜」→ 穿缝 → 世界加载 → 拾 3 信物 → 回门 E 归航 → 结算付账 → 夜谈
 * → 进度页 + N2 解锁。
 *
 * 拾物策略（实体「闻声而动」的既定规则，非 debug 特权——抓捕后实体饱食冷静 7s，
 * entity.ts:282 calmUntil；冲刺 4.2 > 追击 3.1 可甩脱）：
 *   A 走到深端怀表点（途中被追被抓不管，hopTo 持续向目标）
 *   B 站定等被抓（LOS 追击必来抓；被途中抓过则直接进 C）
 *   C 抓捕后 7s 冷静窗口内：按地理位置就近冲刺连拾 3 件 → 冲刺折返门 → returnHome
 *   兜底：B 等 30s 无被抓（异常）→ 退回逐件走捡（旧路径，允许被抓/欠账——流程仍完整）
 *
 * 成功判定：全步骤走完（含付账结算屏）+ 0 console error（非 B4 GL 噪音）+ 0 个 ≥400
 * 响应 + 页面零崩溃 + 结束时 __game.night 状态健康（stage=progress/night=1/errors 空）。
 * 及格线（验收规格书 E3）：50 遍成功率 ≥90% 且崩溃 0。
 *
 * 用法：node scripts/e14-e3.mjs                 # 50 遍
 *       E14_N=3 node scripts/e14-e3.mjs         # 试点
 *       E14_START=4 E14_N=47 node ...           # 断点续跑（runId 续号，JSONL 追加）
 *       E14_SHOTS=1 node ...                    # 指定遍截结算/夜谈/进度图（留痕）
 * 输出：过程留痕/2026-10-27/E14-全局验收/e3-runs.jsonl + e3-summary.json
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOY_URL, OUT_DIR, launchBrowser, injectProbe, attachDiagnostics, newSink,
  waitStage, gameState, nightDebug, sleep, appendJsonl, installWalker,
} from './e14-lib.mjs';

/** N1 坐标（src/game/config.ts N1 同步抄录；config 改动需同步） */
const N1_LOOT = [
  { id: 'oil', x: -9.0, z: 0.9 },
  { id: 'lantern', x: -4.5, z: -0.5 },
  { id: 'watch', x: 0.7, z: 0.3 },
];
const N1_DOOR = { x: -12.3, z: 0.35 };

const hopTo = (page, x, z, opts) =>
  page.evaluate(
    ({ x, z, o }) => window.__probe.hopTo(x, z, o),
    { x, z, o: Object.assign({ hop: 0.5, timeout: 40, sprint: false }, opts) },
  );
const pickup = (page) => page.evaluate(() => window.__game.api.pickup());
const caughtNow = async (page) => ((await nightDebug(page)).caught) || 0;

async function smartDiveLootReturn(page) {
  // A：走到深端怀表（途中被抓会被拖回出生点，hopTo 自动续走）
  const a = await hopTo(page, N1_LOOT[2].x, N1_LOOT[2].z, { hop: 0.6, timeout: 45 });
  // B：以「到达怀表点」为基线等下一次被抓——保证冷静窗口从此刻新起（途中旧抓的
  //    窗口已被走回程耗掉，不能用）
  const c1 = await caughtNow(page);
  let caught = c1;
  const t0 = Date.now();
  while (caught === c1 && Date.now() - t0 < 30_000) {
    await sleep(600);
    caught = await caughtNow(page);
  }
  const viaCatch = caught > c1;
  // C：精走器整段单 evaluate：就近穿拾 3 件 → 直奔门（90ms 步进不吃 evaluate 往返
  //    延迟、近目标收油门防过冲——赶进抓捕后 7s 饱食窗，见 e14-lib WALKER 注）
  const sweep = await page.evaluate(async (door) => {
    const plan = [];
    const scratch = window.__game.api.itemPositions();
    for (;;) {
      const left = scratch.filter((it) => !it.taken);
      if (!left.length) break;
      const p = window.__game.getPos();
      left.sort((m, n) => Math.hypot(m.x - p.x, m.z - p.z) - Math.hypot(n.x - p.x, n.z - p.z));
      plan.push({ id: left[0].id, x: left[0].x, z: left[0].z, pick: true });
      left[0].taken = true;
    }
    plan.push({ id: 'door', x: door.x, z: door.z, r: 0.5 });
    return window.__e14Walk(plan, { sprint: true, timeoutSec: 25 });
  }, N1_DOOR);
  const taken = sweep.trace.filter((t) => t.id !== 'door' && t.picked).length;
  const doorDist = (sweep.trace.find((t) => t.id === 'door') || {}).dist ?? null;
  const ret = await page.evaluate(() => window.__game.api.returnHome());
  return { viaCatch, taken, trace: sweep.trace, hopAok: a.ok, doorDist, returned: ret !== false };
}

const HARD_RUN_MS = 240_000;

async function coreRun(browser, runId) {
  const t0 = Date.now();
  const rec = { runId, ms: null, ok: false, steps: {}, taken: 0, caught: 0, paid: null, heldValue: null, why: '' };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sink = newSink();
  attachDiagnostics(page, sink);
  try {
    const kill = setTimeout(() => { rec.why = 'hard-timeout 240s'; page.close().catch(() => {}); }, HARD_RUN_MS);

    await page.goto(DEPLOY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    rec.steps.load = true;
    await injectProbe(page);
    await installWalker(page);

    await page.waitForSelector('.g-title', { timeout: 60_000 });
    await page.locator('.g-arch-card').first().click();
    await page.locator('.g-title .g-btn.primary').click();
    await page.waitForSelector('.g-morning', { timeout: 15_000 });
    rec.steps.title = true; // 捏伙计（选原型+确认）→ 晨间

    await page.locator('.g-morning .g-btn.primary').click();
    await waitStage(page, 'dive', 150_000); // 穿缝 + 世界加载（新 context 全量下载）
    rec.steps.dive = true;

    const dive = await smartDiveLootReturn(page);
    rec.taken = dive.taken;
    rec.caught = await caughtNow(page);
    rec.steps.loot3 = dive.taken === 3;
    rec.steps.returnHome = dive.returned === true;
    rec.doorDist = dive.doorDist;
    rec.viaCatch = dive.viaCatch;
    if (dive.hopFail) rec.hopFail = dive.hopFail;

    await page.waitForSelector('.g-settle', { timeout: 20_000 });
    rec.steps.settle = true;
    if (SHOT_RUNS.has(runId)) await page.screenshot({ path: join(OUT_DIR, `e3-${String(runId).padStart(2, '0')}-结算.png`) });
    await page.locator('.g-settle .g-btn.primary').click();
    await page.waitForSelector('.g-talk', { timeout: 15_000 });
    rec.steps.talk = true;
    if (SHOT_RUNS.has(runId)) await page.screenshot({ path: join(OUT_DIR, `e3-${String(runId).padStart(2, '0')}-夜谈.png`) });
    await page.locator('.g-talk .g-btn.primary').click();
    await page.waitForSelector('.g-progress', { timeout: 15_000 });
    rec.steps.progress = true;
    if (SHOT_RUNS.has(runId)) await page.screenshot({ path: join(OUT_DIR, `e3-${String(runId).padStart(2, '0')}-进度.png`) });

    // ---- 结束态判定 ----
    const st = await gameState(page);
    const unlocked = await page.evaluate(() => Number(localStorage.getItem('long-night-inn:unlocked-night:v1') || 0));
    const ledger = await page.evaluate(() => window.__game.api.ledger());
    rec.paid = ledger.some((r) => r.type === 'paid' && r.night === 1);
    rec.stateHealthy = st.stage === 'progress' && st.night === 1 && Array.isArray(st.errors) && st.errors.length === 0;
    rec.steps.n2Unlocked = unlocked >= 2;
    rec.errors = sink.errors.slice(0, 8);
    rec.responses = sink.responses.slice(0, 8);
    rec.crashed = sink.crashed;

    rec.ok = rec.steps.load && rec.steps.title && rec.steps.dive && rec.steps.loot3 && rec.steps.returnHome
      && rec.steps.settle && rec.steps.talk && rec.steps.progress && rec.steps.n2Unlocked
      && rec.stateHealthy && rec.errors.length === 0 && rec.responses.length === 0 && !rec.crashed;
    if (!rec.ok && !rec.why) {
      rec.why = !rec.steps.loot3 ? `loot taken=${rec.taken}/3` : !rec.stateHealthy ? `state=${st.stage}/n${st.night}` : (rec.errors[0] || rec.responses[0] || 'steps');
    }
    clearTimeout(kill);
  } catch (e) {
    rec.why = rec.why || String(e && e.message ? e.message : e).slice(0, 220);
  } finally {
    rec.ms = Date.now() - t0;
    await ctx.close().catch(() => {});
  }
  return rec;
}

const N = Number(process.env.E14_N || 50);
const START = Number(process.env.E14_START || 1);
const SHOT_RUNS = new Set(String(process.env.E14_SHOTS || '').split(',').filter(Boolean).map(Number));
const JSONL = join(OUT_DIR, 'e3-runs.jsonl');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (START === 1 && existsSync(JSONL)) rmSync(JSONL);
  const browser = await launchBrowser();
  const runs = [];
  try {
    for (let id = START; id < START + N; id++) {
      const rec = await coreRun(browser, id);
      runs.push(rec);
      appendJsonl(JSONL, rec);
      console.log(`run ${String(id).padStart(2, '0')} ok=${rec.ok} ${rec.ms}ms taken=${rec.taken}/3 caught=${rec.caught} paid=${rec.paid}${rec.why ? ' why=' + rec.why : ''}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const pass = runs.filter((r) => r.ok).length;
  const crashed = runs.filter((r) => r.crashed).length;
  const summary = {
    url: DEPLOY_URL, total: runs.length, pass, fail: runs.length - pass,
    successRate: +(runs.length ? (pass / runs.length) * 100 : 0).toFixed(1),
    crashes: crashed,
    verdict: runs.length >= 50 ? (pass / runs.length >= 0.9 && crashed === 0 ? 'PASS' : 'FAIL') : `PARTIAL(${runs.length}/50)`,
    failures: runs.filter((r) => !r.ok).map((r) => ({ runId: r.runId, why: r.why, steps: r.steps, errors: r.errors, responses: r.responses })),
    msAvg: Math.round(runs.reduce((s, r) => s + (r.ms || 0), 0) / (runs.length || 1)),
    caughtTotal: runs.reduce((s, r) => s + (r.caught || 0), 0),
    paidCount: runs.filter((r) => r.paid).length,
    viaCatchCount: runs.filter((r) => r.viaCatch).length,
  };
  writeFileSync(join(OUT_DIR, 'e3-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[summary]', JSON.stringify({ ...summary, failures: summary.failures.slice(0, 5) }));
}

main();

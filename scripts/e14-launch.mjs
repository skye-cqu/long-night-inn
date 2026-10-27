/**
 * e14-launch.mjs — E14 D1：harness 验证 + 部署 URL 冒烟（零 AI 生成调用）。
 *
 * 1. 自起本机 Chrome（headed + 反后台化 flag）加载 https://skye-cqu.github.io/long-night-inn/
 * 2. 断言 __game.state.fps > 0 且 3s 内 rAF 帧推进（锁屏 rAF 停摆问题的 harness 门）
 * 3. 冒烟：标题页渲染 + AI 标识在场 → 捏伙计 → 晨间 → 推门下潜 → 穿缝 → 世界加载 → 截图存证
 * 4. 生产构建首验：收集全部 console 消息（viewer GL 警告=B4 已知噪音单独归类）、
 *    未捕获异常、≥400 响应；记录任何生产专属错误。
 * 失败排查对照环境：E14_DEV=1 时改打 http://localhost:5199（npm run dev）。
 *
 * 用法：node scripts/e14-launch.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOY_URL, OUT_DIR, launchBrowser, injectProbe, attachDiagnostics, newSink,
  rafProbe, playTitleToDive, gameState, nightDebug, sleep,
} from './e14-lib.mjs';

const URL_UNDER_TEST = process.env.E14_DEV ? 'http://localhost:5199/' : DEPLOY_URL;
const TAG = process.env.E14_DEV ? 'dev' : 'deploy';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const verdict = { url: URL_UNDER_TEST, harness: {}, smoke: {}, productionErrors: {}, ok: false };
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sink = newSink();
  attachDiagnostics(page, sink);

  try {
    // ---- harness 门：加载 + rAF 活性 ----
    await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 60_000 });
    const raf = await rafProbe(page, 3000);
    // 注：__game.state.fps 由 main.ts 渲染循环计数，循环在资产就绪/标题页弹出后才启动——
    // 资产加载期 fps=0 是预期，故 fps 门放在标题页出现之后再验（此处先验裸 rAF）。
    await page.waitForFunction(() => window.__game.state.fps > 0, null, { timeout: 30_000, polling: 500 });
    const fpsAfterTitle = await page.evaluate(() => window.__game.state.fps);
    verdict.harness = { rafFrames3s: raf.raf, fpsAtLoad: raf.fps, fpsAfterLoopStart: fpsAfterTitle, pass: raf.raf > 30 && fpsAfterTitle > 0 };
    console.log('[harness]', JSON.stringify(verdict.harness));
    if (!verdict.harness.pass) throw new Error('harness FAIL: rAF/fps 停摆 → 排查（对照：E14_DEV=1 打 dev 5199）');

    // ---- 冒烟：标题页 + AI 标识 ----
    await page.waitForSelector('.g-title', { timeout: 60_000 });
    const titleText = (await page.locator('.g-title-main').innerText()).trim();
    const aiMark = await page.locator('.g-ai-mark').first().innerText();
    verdict.smoke.title = { text: titleText, aiMark: aiMark.slice(0, 40) };
    await page.screenshot({ path: join(OUT_DIR, `e14-${TAG}-01首页.png`) });

    // ---- 冒烟：捏伙计 → 晨间 → 下潜 → 世界加载 ----
    await injectProbe(page);
    await playTitleToDive(page, { diveTimeout: 150_000 });
    await sleep(2500); // 世界渲染稳定一拍再截图
    const st = await gameState(page);
    const nd = await nightDebug(page);
    verdict.smoke.dive = {
      stage: st.stage, night: st.night, phase: st.phase, fps: st.fps,
      collision: st.collision, gameErrors: st.errors,
      timeLeft: nd.timeLeft, pos: await page.evaluate(() => window.__game.getPos()),
    };
    await page.screenshot({ path: join(OUT_DIR, `e14-${TAG}-02穿缝后世界.png`) });

    // ---- 生产错误清单（GL 噪音单列） ----
    const byType = {};
    for (const c of sink.console) byType[c.type] = (byType[c.type] || 0) + 1;
    const glNoise = sink.console.filter((c) => /GL_INVALID_OPERATION|glDrawElements|vertex shader/i.test(c.text)).length;
    verdict.productionErrors = {
      consoleByType: byType, glNoiseCount: glNoise,
      nonNoiseErrors: sink.errors, badResponses: sink.responses, crashed: sink.crashed,
      gameRuntimeErrors: st.errors,
    };
    verdict.ok = sink.errors.length === 0 && sink.responses.length === 0 && st.errors.length === 0;
    console.log('[smoke]', JSON.stringify(verdict.smoke, null, 1));
    console.log('[prod-errors]', JSON.stringify(verdict.productionErrors, null, 1));
  } catch (e) {
    verdict.fatal = String(e && e.message ? e.message : e).slice(0, 400);
    console.error('[FATAL]', verdict.fatal);
    try { await page.screenshot({ path: join(OUT_DIR, `e14-${TAG}-99失败现场.png`) }); } catch { /* 截图尽力而为 */ }
  } finally {
    writeFileSync(join(OUT_DIR, `e14-${TAG}-launch.json`), JSON.stringify(verdict, null, 2));
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log('[verdict.ok]', verdict.ok, verdict.fatal ? '（有 fatal）' : '');
  process.exit(verdict.ok ? 0 : 1);
}

main();

/**
 * probe-installer.js — 《长夜驿站》验收探针（E10 沉淀，N4 验收输入③）。
 *
 * 来源：N3/N4 验收轮实证的四个模式——「截图泵帧 + 游戏时钟采样 + hop-walk + 劫持检测恢复」。
 * 运行通道：无依赖、纯页面侧。由浏览器自动化工具（如 mcp browser_evaluate）把本文件
 * 全文贴进游戏页执行一次，即安装 `window.__probe`；后续每次 browser_evaluate 调用
 * `__probe.xxx()` 取结果。安装幂等（重复执行只重置状态）。
 *
 * 约定（与 N4 验收报告一致）：
 * - 一切速度/扣减测量以「游戏时钟」为分母：游戏内 timeLeft（__game.night.timeLeft），
 *   不用 performance.now（无头 dt 钳制会失真）。
 * - 截图泵帧：每张截图强制出一帧；泵帧节奏按游戏时 ≈0.5s/张控制（见 pump）。
 * - 劫持：共享浏览器可能被外部进程导航走。本探针只做「检测+恢复后核对」，恢复本身
 *   由自动化层重新导航 localhost:5199 完成（账本在 localStorage，进度无损）。
 *
 * 安装后可用：
 * - __probe.pump(seconds)          泵帧：强制 rAF/渲染推进游戏时（返回推进的游戏秒数）
 * - __probe.sample(fields, ms, iv) 游戏时钟采样：按 interval 抽 __game.night 快照
 * - __probe.hopTo(x, z, opts)      hop-walk：分跳走到世界坐标，逐跳核对位移/坠落兜底
 * - __probe.watch()                劫持检测：登记 pagehide/blur，返回事件日志
 * - __probe.verifyState()          恢复后核对：localStorage 账本/解锁链完整性
 * - __probe.reset()                清空日志与看门狗
 */
/* eslint-disable */
(function installProbe() {
  const g = () => window.__game;
  const night = () => (g() && g().night) || null;

  const P = window.__probe && window.__probe.__installed ? window.__probe : {};

  // ---- 内部日志 ----
  P.__log = P.__log || [];
  const log = (kind, detail) => {
    P.__log.push({ t: performance.now(), kind, detail });
    if (P.__log.length > 500) P.__log.shift();
  };

  // ---- ① 泵帧：推进游戏时（无头/节流下 rAF 停摆的兜底）----
  // 原理：viewer.render 强制出帧；main.ts 的 rAF 循环若活着则同时推进 game.update。
  // 返回实际推进的游戏秒数（按 timeLeft 差，游戏时钟口径）。
  P.pump = function pump(seconds) {
    return new Promise((resolve) => {
      const n0 = night();
      const t0 = n0 ? n0.timeLeft : null;
      const end = performance.now() + seconds * 1000;
      const step = () => {
        try {
          const v = g() && g().viewer && g().viewer();
          if (v && v.render) v.render();
        } catch (e) {
          log('pump-error', String(e));
        }
        if (performance.now() < end) setTimeout(step, 33);
        else {
          const n1 = night();
          const advanced = t0 !== null && n1 ? +(t0 - n1.timeLeft).toFixed(2) : null;
          resolve({ advancedGameSeconds: advanced, pumpWallSeconds: seconds });
        }
      };
      step();
    });
  };

  // ---- ② 游戏时钟采样：fields 取 __game.night 的键（点路径支持 'entity.pos.x'）----
  P.sample = function sample(fields, durationMs, intervalMs) {
    return new Promise((resolve) => {
      const rows = [];
      const end = performance.now() + durationMs;
      const get = (path) =>
        path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), night());
      const tick = () => {
        const row = { t: night() ? +night().timeLeft.toFixed(2) : null };
        for (const f of fields) row[f] = get(f);
        rows.push(row);
        if (performance.now() < end) setTimeout(tick, intervalMs || 400);
        else resolve(rows);
      };
      tick();
    });
  };

  // ---- ③ hop-walk：分跳走到目标点（N4 实走 16 跳同款）----
  // opts: { hop=0.8s, timeout=60s, sprint=false, yawTo=true }
  // 每跳后核对：pos 是否逼近、是否触发坠落软复位（stage 跳变/黑闪由游戏层 console.warn 记录）。
  P.hopTo = function hopTo(x, z, opts) {
    const o = Object.assign({ hop: 0.8, timeout: 60, sprint: false, yawTo: true }, opts || {});
    return new Promise((resolve) => {
      const t0 = performance.now();
      let hops = 0;
      const fell = () => P.__log.filter((l) => l.kind === 'fall-reset').length;
      const step = () => {
        const pos = g() && g().getPos();
        if (!pos) return resolve({ ok: false, why: 'no __game', hops });
        const d = Math.hypot(x - pos.x, z - pos.z);
        if (d < 0.6 || performance.now() - t0 > o.timeout * 1000) {
          g().setInput(0, 0);
          g().setSprint(false);
          return resolve({ ok: d < 0.6, hops, finalDist: +d.toFixed(2), pos, fallResets: fell() });
        }
        if (o.yawTo) g().setYaw(Math.atan2(z - pos.z, x - pos.x));
        g().setSprint(!!o.sprint);
        g().setInput(1, 0);
        hops++;
        setTimeout(step, o.hop * 1000);
      };
      step();
    });
  };

  // 坠落兜底挂钩：监听游戏层 console.warn('[兜底]' 开头) —— hop/采样期间记录
  if (!P.__fallHooked) {
    const origWarn = console.warn.bind(console);
    console.warn = function (...args) {
      try {
        const s = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        if (s.includes('[兜底]') || s.includes('托回')) log('fall-reset', s.slice(0, 120));
        if (s.includes('[理智]')) log('sanity-zero', s.slice(0, 120));
      } catch (e) { /* 忽略 */ }
      origWarn(...args);
    };
    P.__fallHooked = true;
  }

  // ---- ④ 劫持检测：登记页面级异常事件（恢复=自动化层重新导航）----
  P.watch = function watch() {
    if (!P.__watchHooked) {
      addEventListener('pagehide', () => { try { localStorage.setItem('probe-hijack', String(Date.now())); } catch (e) {} });
      addEventListener('blur', () => log('blur', document.title));
      P.__watchHooked = true;
    }
    return { events: P.__log.filter((l) => l.kind === 'blur' || l.kind === 'hijack'), note: '被导航走=pagehide 已落 localStorage.probe-hijack；恢复后 verifyState() 核对' };
  };

  // ---- ⑤ 恢复后核对：账本/解锁链完整性（劫持不应丢进度）----
  P.verifyState = function verifyState() {
    let ledger = null;
    let unlocked = null;
    let hijackTs = null;
    try {
      ledger = JSON.parse(localStorage.getItem('long-night-inn:ledger:v1') || 'null');
      unlocked = Number(localStorage.getItem('long-night-inn:unlocked-night:v1') || '0');
      hijackTs = Number(localStorage.getItem('probe-hijack') || '0');
    } catch (e) {
      return { ok: false, why: 'localStorage 不可读: ' + e };
    }
    const okLedger = ledger === null || (Array.isArray(ledger) && ledger.every((r) => r.night >= 1 && r.type && r.ts));
    return {
      ok: okLedger,
      ledgerRecords: Array.isArray(ledger) ? ledger.length : 0,
      unlockedNight: unlocked || null,
      lastHijackTs: hijackTs || null,
      stage: g() && g().state ? g().state.stage : null,
      night: g() && g().state ? g().state.night : null,
    };
  };

  // ---- 重置与元信息 ----
  P.reset = function reset() {
    P.__log.length = 0;
    try { localStorage.removeItem('probe-hijack'); } catch (e) {}
    return true;
  };
  P.__installed = true;
  P.about = { name: 'long-night-inn probe', version: 'E10-2026-10-26', clock: 'game-timeLeft 为分母' };
  return { installed: true, about: P.about };
})();

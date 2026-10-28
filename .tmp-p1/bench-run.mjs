// P1 修复验证台架（打回修复）：真实体素+nav，60Hz 定步长，无头复现 N3/N4 深处信物不可达。
// 用法：node p1-bench.mjs <bundle.cjs> <输出.json> [mode]
//   mode=walk（默认）N3/N4 出生→各信物 hopTo 实走 + N7 踏步复现点 + 卡死区间统计
//   mode=sweep       N1-N7 全域 nav 柱采样直行 8s（对齐 B1 sweep 口径：<0.3m=卡点）
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = 'D:/Projects/群核Aholo全球3D AI黑客松/游戏工程';
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ImageData = class ImageData { constructor(...a){ Object.assign(this, { width: a[1], height: a[2], data: a[0] }); } };
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { addEventListener(){}, removeEventListener(){}, pointerLockElement: null, hidden: false };

const BUNDLE = process.argv[2] ?? root + '/.tmp-p1/wc-after.cjs';
const OUT = process.argv[3] ?? 'p1-bench.json';
const MODE = process.argv[4] ?? 'walk';
const { WalkControls, VoxelCollision } = await import(pathToFileURL(BUNDLE).href);
const { PerspectiveCamera } = await import(pathToFileURL(root + '/node_modules/three/build/three.module.js').href);

function loadCollision(night) {
  const tag = night === 1 ? '' : '-n' + night;
  const meta = JSON.parse(readFileSync(root + '/public/assets/collision' + tag + '.voxel-meta.json', 'utf8'));
  const bin = readFileSync(root + '/public/assets/collision' + tag + '.voxel.bin');
  const u32 = new Uint32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + Math.floor(bin.byteLength / 4) * 4));
  const n = meta.nodeCount >>> 0, d = meta.leafDataCount >>> 0;
  const col = new VoxelCollision(meta, u32.slice(0, n), u32.slice(n, n + d));
  // P1 门洞（config.ts N3 carves 同款）
  if (night === 3) col.setCarves([{ x0: 1.15, x1: 3.45, y0: 2.35, y1: 6.2, z0: 0.1, z1: 1.0 }]);
  return col;
}
function loadNav(night) {
  const d = JSON.parse(readFileSync(root + '/public/assets/world-n' + night + '.nav.json', 'utf8'));
  const grid = d.floorGridPos, cell = d.cellSize, cols = [];
  for (let iz = 0; iz < d.nz; iz++) for (let ix = 0; ix < d.nx; ix++) {
    const v = grid[iz * d.nx + ix]; if (v === null) continue;
    cols.push({ x: d.bboxMin[0] + (ix + 0.5) * cell, z: d.bboxMin[2] + (iz + 0.5) * cell, y: v });
  }
  return {
    cols,
    columns: cols,
    bboxMin: d.bboxMin,
    bboxMax: d.bboxMax,
    floorAt(x, z) {
      const ix = Math.floor((x - d.bboxMin[0]) / cell), iz = Math.floor((z - d.bboxMin[2]) / cell);
      if (ix < 0 || iz < 0 || ix >= d.nx || iz >= d.nz) return d.globalFloorPos;
      const v = grid[iz * d.nx + ix];
      return v === null ? d.globalFloorPos : v;
    },
  };
}
const cam = new PerspectiveCamera();
const EYE = 1.2;

// config.ts 口径的 N3/N4 出生点与信物（x/z 与 src/game/config.ts 一致）
const NIGHTS = {
  3: { spawn: { x: -1.45, z: 0.75 }, loot: [
    { id: 'oil', x: 2.55, z: -1.25 }, { id: 'lantern', x: 7.55, z: -0.35 }, { id: 'watch', x: 14.55, z: -0.75 }] },
  4: { spawn: { x: 14.45, z: 2.25 }, loot: [
    { id: 'oil', x: 7.45, z: -1.25 }, { id: 'lantern', x: -3.05, z: -1.75 }, { id: 'watch', x: -12.05, z: -1.25 }] },
};

/** 带面顶棚（与 walk-controls 同口径）：可站柱 0.5m 格最大 → 2m 半径极大滤波 */
function bandCeilFn(nav) {
  const cell = 0.5;
  const nx = Math.max(1, Math.ceil((nav.bboxMax[0] - nav.bboxMin[0]) / cell));
  const nz = Math.max(1, Math.ceil((nav.bboxMax[2] - nav.bboxMin[2]) / cell));
  const raw = new Float32Array(nx * nz).fill(-1e9);
  for (const c of nav.cols) {
    const ix = Math.max(0, Math.min(nx - 1, Math.floor((c.x - nav.bboxMin[0]) / cell)));
    const iz = Math.max(0, Math.min(nz - 1, Math.floor((c.z - nav.bboxMin[2]) / cell)));
    const j = iz * nx + ix;
    if (c.y > raw[j]) raw[j] = c.y;
  }
  const R = 4, out = new Float32Array(nx * nz).fill(-1e9);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    let m = -1e9;
    for (let zz = Math.max(0, iz - R); zz <= Math.min(nz - 1, iz + R); zz++)
      for (let xx = Math.max(0, ix - R); xx <= Math.min(nx - 1, ix + R); xx++) m = Math.max(m, raw[zz * nx + xx]);
    out[iz * nx + ix] = m;
  }
  return (x, z) => {
    const ix = Math.max(0, Math.min(nx - 1, Math.floor((x - nav.bboxMin[0]) / cell)));
    const iz = Math.max(0, Math.min(nz - 1, Math.floor((z - nav.bboxMin[2]) / cell)));
    const v = out[iz * nx + ix];
    return v > -1e8 ? Math.max(v, nav.floorAt(x, z)) : nav.floorAt(x, z);
  };
}

/** hopTo 实走：yaw 对准目标直行；卡死 >2s 逐步偏航 25°/s（上限 75°，真人贴墙绕行的
 *  自动化代理，与 E14 escape「换向可移动」同型）；恢复移动即回正。y 口径=带面顶棚。 */
function hopTo(night, tx, tz, timeoutS = 60) {
  const col = loadCollision(night), nav = loadNav(night);
  const wc = new WalkControls({ addEventListener(){}, contains: () => true }, nav, col);
  const spawn = NIGHTS[night].spawn;
  wc.startAt(spawn.x, spawn.z, 0);
  const t0 = { x: wc.position.x, z: wc.position.z };
  const dist0 = Math.hypot(tx - t0.x, tz - t0.z);
  const ceil = bandCeilFn(nav);
  const trail = [];
  let maxOverBand = -Infinity, stuckT = 0, lastPos = { x: t0.x, z: t0.z };
  let steer = 0, stuckRun = 0;
  let reached = false, tReached = null;
  for (let i = 0; i < 60 * timeoutS; i++) {
    const dx = tx - wc.position.x, dz = tz - wc.position.z;
    if (Math.hypot(dx, dz) < 1.4) { reached = true; tReached = i / 60; break; } // 拾取半径 1.6 内含余量
    // 卡死转向：连续 2s 零位移 → 每秒 +25°（封顶 75°），动了回正
    const moved = Math.hypot(wc.position.x - lastPos.x, wc.position.z - lastPos.z);
    if (moved < 2e-4) {
      stuckRun++;
      if (stuckRun > 120 && stuckRun % 60 === 0) steer = Math.sign(steer || 1) * Math.min(Math.PI * 0.42, Math.abs(steer) + Math.PI / 7.2);
      stuckT += 1 / 60;
    } else { stuckRun = 0; steer = 0; }
    lastPos = { x: wc.position.x, z: wc.position.z };
    wc.setYaw(Math.atan2(dz, dx) + steer);
    wc.setInput(1, 0);
    wc.update(1 / 60, cam);
    const feet = wc.position.y - EYE;
    const fl = nav.floorAt(wc.position.x, wc.position.z);
    maxOverBand = Math.max(maxOverBand, feet - ceil(wc.position.x, wc.position.z));
    if (i % 120 === 0) trail.push({ t: +(i / 60).toFixed(1), x: +wc.position.x.toFixed(2), z: +wc.position.z.toFixed(2), feetY: +feet.toFixed(2), navFloor: +fl.toFixed(2) });
  }
  wc.setInput(0, 0);
  const disp = Math.hypot(wc.position.x - t0.x, wc.position.z - t0.z);
  return {
    night, target: { x: tx, z: tz }, dist0: +dist0.toFixed(2),
    reached, tReached, finalDist: +Math.hypot(tx - wc.position.x, tz - wc.position.z).toFixed(2),
    dispOk: disp >= dist0 - 1, // 验收口径：位移 ≥ 目标距离-1m
    maxFeetOverBand: +maxOverBand.toFixed(2), stuckSeconds: +stuckT.toFixed(1),
    trail: trail.slice(0, 30), final: { x: +wc.position.x.toFixed(2), z: +wc.position.z.toFixed(2), feetY: +(wc.position.y - EYE).toFixed(2) },
  };
}

/** 直行 N 秒（B1 sweep 同口径） */
function runStraight(night, x, z, yaw, seconds = 8) {
  const col = loadCollision(night), nav = loadNav(night);
  const wc = new WalkControls({ addEventListener(){}, contains: () => true }, nav, col);
  wc.startAt(x, z, yaw);
  wc.setInput(1, 0);
  const t0 = { x: wc.position.x, z: wc.position.z };
  let maxY = -Infinity;
  for (let i = 0; i < 60 * seconds; i++) {
    wc.update(1 / 60, cam);
    maxY = Math.max(maxY, wc.position.y - EYE - nav.floorAt(wc.position.x, wc.position.z));
  }
  wc.setInput(0, 0);
  return { d: +Math.hypot(wc.position.x - t0.x, wc.position.z - t0.z).toFixed(2), yOver: +maxY.toFixed(2) };
}

const report = { bundle: BUNDLE.split('/').pop(), mode: MODE, cases: [] };
if (MODE === 'walk') {
  for (const n of [3, 4]) for (const l of NIGHTS[n].loot) report.cases.push(hopTo(n, l.x, l.z));
  // N7 踏步保留回归点（B1 修复口径：8s ≥6m）
  report.cases.push({ case: 'N7-stepup(-11.52,-0.05)E', ...runStraight(7, -11.52, -0.05, 0) });
  // N3 卡死现场直击（朝 watch 直行 12s，观察 y 爬升与零位移）
  report.cases.push({ case: 'N3-stuckpoint(x≈1.28)E-12s', ...runStraight(3, 1.28, 0.1, 0, 12) });
} else {
  for (const night of [1, 2, 3, 4, 5, 6, 7]) {
    const nav = loadNav(night);
    const cols = nav.cols.length > 60 ? nav.cols.filter((_, i) => i % Math.ceil(nav.cols.length / 60) === 0) : nav.cols;
    let stuck = 0, worst = [];
    for (const c of cols) {
      const r = runStraight(night, c.x, c.z, 0);
      if (r.d < 0.3) { stuck++; worst.push({ x: +c.x.toFixed(1), z: +c.z.toFixed(1), d: r.d }); }
    }
    report.cases.push({ night, sampled: cols.length, stuck, stuckAt: worst.slice(0, 8) });
  }
}
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));

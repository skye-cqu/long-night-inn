#!/usr/bin/env node
/**
 * gen-nav-n4.mjs — N4「深海×灯笼古镇」nav 高度场修正版（E6 接入，2026-10-26）。
 *
 * 为什么不能直接用 gen-nav-from-voxel.mjs（主带顶向下选面）：N4 世界 44m 竖向
 * （gridBounds y -10.8~32），主街上空挂满灯笼 canopy（连片棚盖层 y≈23.6）+ 店面
 * 二层/摊顶（y≈3~4）。旧口径按「柱最高层顶」计带众数 → 主带被 canopy 截胡，
 * floorGridPos 混入 23.6/3/4 层（E5 产物实测：y≈-3:311格 / y≈3:170 / y≈-2:125 /
 * y≈4:86，globalFloor=23.6），相邻柱带面跳变=坠穿，E5 nav 不可用（E6 任务书「N4 关键坑」）。
 *
 * 纯底向上首触面也不行（已实测）：深海街面杂物/藤壶多，首触面被打在杂物顶，
 * 玩家柱可走碎成 52 块、主块仅 26 格——不可导航。
 *
 * 修正口径（E6）＝「底向上定带，带内选面」：
 *   ① 底向上首触面直方图 → 全局地面主带 y≈-4（±1.5m）——这一步是任务书要的
 *      「体素底向上地面口径」（参考 任务E5/analyze-voxel-n4.mjs 地面估计逻辑），
 *      canopy(23.6)/摊顶(+3) 天然落在带外，从候选里整体剔除；
 *   ② 每列层顶（solid→空 的每个顶面）只取带内者；同列多个带内顶面（藤壶坑 y≈-4.5
 *      vs 街面 y≈-3.2、雨棚 y≈-2.7 vs 街面）→ 取「所属 1m 带全局柱数多」者，同数取
 *      较低层（棚盖/杂物顶让位给街面——与 N2「带内顶向下」反其道的部分，理由：
 *      底向上已证带内低处多杂物坑，高处多棚盖，街面=两者之间连续走道）；
 *   ③ 墙判据沿用 gen-nav-from-voxel：F 上方 0.2..1.6m 有 ≥0.5m 连续实心
 *      （贴地植被/薄藤壶可穿，厚摊柜推不穿——与胶囊推离一致）。
 * 输出 schema 与 gen-nav-data.mjs / gen-nav-from-voxel.mjs 完全一致（floorGridNeg 占位，
 * upSign 已定 +Y）。选点验证：过程留痕/2026-10-26/游戏工程-N4接入/plan-n4-points.mjs
 * （同一口径硬规则）。
 *
 * 用法：node scripts/gen-nav-n4.mjs [meta.json bin out.nav.json]（默认 N4 三件套）
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const [metaPath, binPath, outPath] = process.argv.length > 2
  ? process.argv.slice(2)
  : [resolve(ROOT, 'public/assets/collision-n4.voxel-meta.json'), resolve(ROOT, 'public/assets/collision-n4.voxel.bin'), resolve(ROOT, 'public/assets/world-n4.nav.json')];

for (const f of [metaPath, binPath]) {
  if (!statSync(f, { throwIfNoEntry: false })) { console.error(`找不到 ${f}`); process.exit(1); }
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const bin = readFileSync(binPath);
const allU32 = new Uint32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + Math.floor(bin.byteLength / 4) * 4));
const nodes = allU32.slice(0, meta.nodeCount >>> 0);
const leafData = allU32.slice(meta.nodeCount >>> 0, (meta.nodeCount >>> 0) + (meta.leafDataCount >>> 0));

const gMin = meta.gridBounds.min, gMax = meta.gridBounds.max, vs = meta.voxelResolution;
const CX = Math.round((gMax[0] - gMin[0]) / vs);
const CY = Math.round((gMax[1] - gMin[1]) / vs);
const CZ = Math.round((gMax[2] - gMin[2]) / vs);
console.log(`体素场景: y[${gMin[1].toFixed(1)}, ${gMax[1].toFixed(1)}]（高 ${(gMax[1] - gMin[1]).toFixed(1)}m 竖向） 格 ${CX}x${CY}x${CZ}`);

const SOLID = 0xff000000 >>> 0;
const popcount = (n) => { n >>>= 0; n -= (n >>> 1) & 0x5555555; n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
function solid(ix, iy, iz) {
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
}
function leaf(n, ix, iy, iz) {
  const idx = n & 0xffffff;
  const bit = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
  const lo = leafData[idx * 2] >>> 0;
  if (bit < 32) return ((lo >>> bit) & 1) === 1;
  return (((leafData[idx * 2 + 1] >>> 0) >>> (bit - 32)) & 1) === 1;
}

const CELL = 0.5;
const NX = Math.ceil((gMax[0] - gMin[0]) / CELL);
const NZ = Math.ceil((gMax[2] - gMin[2]) / CELL);

// ---- ① 底向上首触面 + 全局地面主带（体素底向上地面口径）----
const colFirstTop = new Float32Array(NX * NZ).fill(NaN);
const colTops = new Array(NX * NZ); // 每列全部层顶（solid→空）
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const wx = gMin[0] + (i + 0.5) * CELL, wz = gMin[2] + (j + 0.5) * CELL;
    const gx = Math.floor((wx - gMin[0]) / vs), gz = Math.floor((wz - gMin[2]) / vs);
    const tops = [];
    for (let gy = 0; gy < CY; gy++) {
      if (solid(gx, gy, gz) && !solid(gx, gy + 1, gz)) tops.push(gMin[1] + (gy + 1) * vs);
    }
    colTops[j * NX + i] = tops;
    if (tops.length) colFirstTop[j * NX + i] = tops[0]; // 底向上首个
  }
const hist = new Map();
for (let k = 0; k < NX * NZ; k++) if (!Number.isNaN(colFirstTop[k])) {
  const b = colFirstTop[k].toFixed(0);
  hist.set(b, (hist.get(b) || 0) + 1);
}
const rankedBands = [...hist.entries()].sort((a, b) => b[1] - a[1]);
const mainBand = +rankedBands[0][0];
const BAND_TOL = 1.5;
let inBand = 0;
for (let k = 0; k < NX * NZ; k++) if (!Number.isNaN(colFirstTop[k]) && Math.abs(colFirstTop[k] - mainBand) <= BAND_TOL) inBand++;
console.log(`底向上首触面直方图前5: ${rankedBands.slice(0, 5).map(([b, c]) => `y≈${b}:${c}列`).join(' ')} → 地面主带 y≈${mainBand}（±${BAND_TOL}m 内 ${inBand} 列）`);
console.log(`（canopy y≈23.6 / 摊顶 y≈+3 均在带外，整体剔除——旧口径在此翻车）`);

// ---- ② 带内选面：所属 1m 带全局柱数多者优先，同数取较低层 ----
const bandColCount = new Map(); // 1m 带 → 拥有该带层顶的列数
for (let k = 0; k < NX * NZ; k++) {
  const seen = new Set();
  for (const t of colTops[k]) {
    if (Math.abs(t - mainBand) > BAND_TOL) continue;
    const b = Math.round(t);
    if (!seen.has(b)) { seen.add(b); bandColCount.set(b, (bandColCount.get(b) || 0) + 1); }
  }
}
const colFloor = new Float32Array(NX * NZ).fill(NaN);
for (let k = 0; k < NX * NZ; k++) {
  let best = NaN, bestCount = 0;
  for (const t of colTops[k]) {
    if (Math.abs(t - mainBand) > BAND_TOL) continue;
    const c = bandColCount.get(Math.round(t)) ?? 0;
    if (c > bestCount || (c === bestCount && t < best)) { best = t; bestCount = c; }
  }
  colFloor[k] = best;
}

// ---- ③ 墙判据（沿用 gen-nav-from-voxel）：F 上方 0.2..1.6m 连续实心 ≥0.5m ----
const WALL_T = 0.5;
const blocked = new Uint8Array(NX * NZ);
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    if (Number.isNaN(colFloor[k])) { blocked[k] = 2; continue; }
    const wx = gMin[0] + (i + 0.5) * CELL, wz = gMin[2] + (j + 0.5) * CELL;
    const gx = Math.floor((wx - gMin[0]) / vs), gz = Math.floor((wz - gMin[2]) / vs);
    let run = 0, maxRun = 0;
    for (let y = colFloor[k] + 0.2; y < colFloor[k] + 1.6; y += vs) {
      if (solid(gx, Math.floor((y - gMin[1]) / vs), gz)) { run += vs; if (run > maxRun) maxRun = run; } else run = 0;
    }
    if (maxRun >= WALL_T) blocked[k] = 1;
  }

// ---- nav json（schema 同 gen-nav-data.mjs）----
const floorGridPos = new Array(NX * NZ).fill(null);
const floorGridNeg = new Array(NX * NZ).fill(null);
let valid = 0;
for (let k = 0; k < NX * NZ; k++) {
  if (Number.isNaN(colFloor[k])) continue;
  floorGridPos[k] = +colFloor[k].toFixed(3);
  floorGridNeg[k] = +colFloor[k].toFixed(3);
  valid++;
}
const out = {
  bboxMin: [+gMin[0].toFixed(3), +gMin[1].toFixed(3), +gMin[2].toFixed(3)],
  bboxMax: [+gMax[0].toFixed(3), +gMax[1].toFixed(3), +gMax[2].toFixed(3)],
  cellSize: CELL,
  nx: NX, nz: NZ,
  floorGridNeg, floorGridPos,
  globalFloorNeg: mainBand, globalFloorPos: mainBand,
};
writeFileSync(outPath, JSON.stringify(out));
const walkable = blocked.reduce((s, b) => s + (b === 0 ? 1 : 0), 0);
console.log(`\nnav 数据: ${outPath}`);
console.log(`带内地面格 ${valid}/${NX * NZ}（${((100 * valid) / (NX * NZ)).toFixed(0)}%）；玩家柱可走 ${walkable}/${NX * NZ}（${((100 * walkable) / (NX * NZ)).toFixed(0)}%）`);
for (let j = 0; j < NZ; j++) {
  let row = '';
  for (let i = 0; i < NX; i++) row += blocked[j * NX + i] === 1 ? '#' : blocked[j * NX + i] === 0 ? '.' : ' ';
  console.log(row);
}

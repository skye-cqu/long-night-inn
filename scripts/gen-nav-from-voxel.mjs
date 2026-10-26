#!/usr/bin/env node
/**
 * gen-nav-from-voxel.mjs — 从体素碰撞数据生成 nav 高度场（N2 起）。
 *
 * 背景：直接从原始 PLY 统计的高度场会被 20 万+ 噪声高斯污染（N2 点云 145 连通块，
 * bbox 被拉到 82×91m，globalFloor 失真）。体素管线（gen-voxel）已做簇过滤，
 * 由此推导的「每列主带内的实心段顶面」（E2 起：顶向下、带内选面）与玩家碰撞所见
 * 一致。本脚本把体素柱顶转成 world-*.nav.json（与 gen-nav-data.mjs 同 schema，
 * floorGridNeg 仅占位——upSign 已定 +Y）。
 *
 * 用法：node scripts/gen-nav-from-voxel.mjs [voxel-meta.json] [voxel.bin] [out.nav.json]
 * 默认生成 public/assets/world-n2.nav.json。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const [metaPath, binPath, outPath] = process.argv.length > 2
  ? process.argv.slice(2)
  : [resolve(ROOT, 'public/assets/collision-n2.voxel-meta.json'), resolve(ROOT, 'public/assets/collision-n2.voxel.bin'), resolve(ROOT, 'public/assets/world-n2.nav.json')];

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

// ---- 每列（0.5m）所有实心层顶面（顶向下选面，见下方 F 规则）----
// E2 修订：旧「底向上首个实心」会被地面裂缝下的深层杂片截胡——pocket 列底向上取到
// y≈-9 的坑底杂片，而玩家实际站在 y≈2.8 的板上（探地实测）。玩家 probeGround 是从
// 上往下打射线，nav 也改成从上往下选面：候选=落在主带 ±BAND_TOL 内的层顶，
// 多个候选取「所属带柱数最多」的那个（同数取较高层）——棚盖/坑底不当地面。
const CELL = 0.5;
const NX = Math.ceil((gMax[0] - gMin[0]) / CELL);
const NZ = Math.ceil((gMax[2] - gMin[2]) / CELL);
const colTops = new Array(NX * NZ);
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const wx = gMin[0] + (i + 0.5) * CELL, wz = gMin[2] + (j + 0.5) * CELL;
    const gx = Math.floor((wx - gMin[0]) / vs), gz = Math.floor((wz - gMin[2]) / vs);
    const tops = [];
    for (let gy = 0; gy < CY; gy++) {
      // 连续实心段的顶面：本层实心且上一层为空（薄层/厚板各记一个顶）
      if (solid(gx, gy, gz) && !solid(gx, gy + 1, gz)) tops.push(gMin[1] + (gy + 1) * vs);
    }
    colTops[j * NX + i] = tops;
  }

// ---- 主高度带（多台阶带，E2 起）----
// N2 场景有多级地面（y≈-4 河埠头 / y≈+2~3 岸上 / 局部 ~1.5 台阶），单主带钳制会把
// 另一级压平导致实体悬浮（E1 集成记录观察项 4）。取 1m 带内柱数 ≥BAND_MIN 的为主带；
// 每列地面 F=该列落在任一主带 ±BAND_TOL 内的层顶中，「所属带柱数最多」的那个。
const BAND_MIN = 15, BAND_TOL = 1.0;
const bandCount = new Map();
for (let k = 0; k < NX * NZ; k++) {
  const tops = colTops[k];
  if (tops.length === 0) continue;
  const b = Math.round(tops[tops.length - 1]); // 1m 带中心（按柱最高层顶计）
  bandCount.set(b, (bandCount.get(b) || 0) + 1);
}
const majorBands = [...bandCount.entries()].filter(([, c]) => c >= BAND_MIN).map(([b]) => b).sort((a, b) => a - b);
const mainBand = majorBands.reduce((best, b) => (bandCount.get(b) > (bandCount.get(best) ?? 0) ? b : best), majorBands[0] ?? 0);
const colFloor = new Float32Array(NX * NZ).fill(NaN);
for (let k = 0; k < NX * NZ; k++) {
  let best = NaN, bestCount = 0;
  for (const t of colTops[k]) {
    let hitBand = null;
    for (const b of majorBands) if (Math.abs(t - b) <= BAND_TOL) { hitBand = b; break; }
    if (hitBand === null) continue;
    const c = bandCount.get(hitBand);
    if (c > bestCount || (c === bestCount && t > best)) { best = t; bestCount = c; }
  }
  colFloor[k] = best;
}

// ---- 玩家柱障碍（连续实心厚度 ≥WALL_T 米才算墙——E2 起） ----
// 旧判据「地面+0.2..1.6 内有任何实心即阻挡」把贴地植被/灌丛也当墙，N2 户外场景
// 146/176 个障碍起始离地 0.2m，可走主块只剩 ~10 格（diag-n2-voxel.mjs 诊断）。
// 改判据后以带面 F 为地面基准：F 上方 0.2..1.6m 内有 ≥WALL_T 连续实心 → 墙。
// 玩家胶囊本体仍走体素推离：薄植被能挤过去（草丛可穿），厚墙推不穿——与判据一致。
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
console.log(`nav 数据: ${outPath}`);
console.log(`bbox x[${gMin[0].toFixed(1)},${gMax[0].toFixed(1)}] z[${gMin[2].toFixed(1)},${gMax[2].toFixed(1)}] 格 ${NX}x${NZ} 主带 y≈${majorBands.join('/')} 有效格 ${valid}/${NX * NZ}（${((100 * valid) / (NX * NZ)).toFixed(0)}%）`);
console.log(`玩家柱可走（连续实心≥${WALL_T}m 才算墙）: ${walkable}/${NX * NZ}（${((100 * walkable) / (NX * NZ)).toFixed(0)}%）`);
// ASCII 障碍图（选点参考）
for (let j = 0; j < NZ; j++) {
  let row = '';
  for (let i = 0; i < NX; i++) row += blocked[j * NX + i] === 1 ? '#' : blocked[j * NX + i] === 0 ? '.' : ' ';
  console.log(row);
}

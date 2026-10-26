#!/usr/bin/env node
/**
 * convert-nav-n7.mjs — N7 终幕 nav 入工程（E11/C1，纯本地离线转换，零 API）。
 *
 * 输入：过程留痕/2026-10-26/任务E9-N7世界生成/world-n7.nav.json（gen-nav-from-voxel.mjs
 * 产物，flat schema：bboxMin/bboxMax/cellSize/nx/nz/floorGridNeg/floorGridPos/
 * globalFloorNeg/globalFloorPos，floorGridPos 为 nx×nz 行主序平面数组，null=无地面）。
 *
 * 转换（带限锚定，同 gen-nav-band.mjs 口径）：
 *   - 锚定地面带 y∈[0.5,3.5]：E9 静态回归「锚定地面层 y∈[0.5,3.5]」为判定 PASS 的口径，
 *     含 E9 留痕的峰带 y≈2–3；剔除东半 y≈10–11 拱廊/棚盖上层（130 格）与 y≈5–7 中层杂面。
 *     不用更窄的 [2,3]：南缘 1.3–1.9m 低走道被剔成孤岛（连通块 4→6，主块 225→179 格）。
 *   - 带外格置 null + globalFloor 重置为带内众数（floorAt 兜底不落到杂带）。
 *
 * schema 核对：输入/输出与 N1–N6 的 world-n*.nav.json 同为 flat schema（nav.ts NavData
 * 单一消费 schema）——运行时加载器不做双 schema 分支，本脚本即「对齐 + 带限」。
 *
 * 用法：node scripts/convert-nav-n7.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const inPath = join(here, '../../过程留痕/2026-10-26/任务E9-N7世界生成/world-n7.nav.json');
const outPath = join(here, '../public/assets/world-n7.nav.json');

if (!statSync(inPath, { throwIfNoEntry: false })) {
  console.error(`找不到输入 ${inPath}`);
  process.exit(1);
}

const nav = JSON.parse(readFileSync(inPath, 'utf8'));

// schema 核对：与 nav.ts NavData / N1–N6 nav 完全同构
const EXPECTED_KEYS = [
  'bboxMin', 'bboxMax', 'cellSize', 'nx', 'nz',
  'floorGridNeg', 'floorGridPos', 'globalFloorNeg', 'globalFloorPos',
];
const keys = Object.keys(nav);
for (const k of EXPECTED_KEYS) {
  if (!keys.includes(k)) {
    console.error(`schema 不符：缺 ${k}（E9 产物应为 flat schema）`);
    process.exit(1);
  }
}
if (!Array.isArray(nav.floorGridPos) || nav.floorGridPos.length !== nav.nx * nav.nz) {
  console.error(`schema 不符：floorGridPos 长度 ${nav.floorGridPos?.length} != nx*nz=${nav.nx * nav.nz}`);
  process.exit(1);
}

const Y_MIN = 0.5, Y_MAX = 3.5; // E9 锚定地面层（判定 PASS 口径，峰带 y≈2–3 在内）
const { nx, nz } = nav;
const gridPos = new Array(nx * nz).fill(null);
const gridNeg = new Array(nx * nz).fill(null);
const hist = {};
let kept = 0, dropped = 0, nullWas = 0;
for (let k = 0; k < nx * nz; k++) {
  const v = nav.floorGridPos[k];
  if (v === null) { nullWas++; continue; }
  if (v >= Y_MIN && v <= Y_MAX) {
    gridPos[k] = v;
    gridNeg[k] = nav.floorGridNeg[k] !== null && nav.floorGridNeg[k] >= Y_MIN && nav.floorGridNeg[k] <= Y_MAX
      ? nav.floorGridNeg[k]
      : v;
    kept++;
    const b = Math.round(v);
    hist[b] = (hist[b] || 0) + 1;
  } else {
    dropped++;
  }
}
if (kept === 0) { console.error(`带 [${Y_MIN},${Y_MAX}] 内 0 格——锚定带错误`); process.exit(1); }
const mode = Number(Object.entries(hist).sort((a, b) => b[1] - a[1])[0][0]);

const out = {
  ...nav,
  floorGridPos: gridPos,
  floorGridNeg: gridNeg,
  globalFloorNeg: mode,
  globalFloorPos: mode,
};
writeFileSync(outPath, JSON.stringify(out));
console.log(`N7 nav 带限 [${Y_MIN}, ${Y_MAX}]：保留 ${kept} 格 / 剔除 ${dropped} 格（原 null ${nullWas} 格）；带内分布 ${JSON.stringify(hist)}；globalFloor→${mode}`);
console.log(`输出: ${outPath}`);

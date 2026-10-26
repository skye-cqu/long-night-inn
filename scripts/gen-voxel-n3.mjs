#!/usr/bin/env node
/**
 * gen-voxel-n3.mjs — N3 体素碰撞生成（沿用 gen-voxel-n2.mjs 模式：Read+Voxel 管线，
 * Read 任务自带 filterCluster 去噪——N3 输入直接用 资产库/ 原始 PLY，任务E3 已用
 * 同管线验证过：594,343 高斯 kept 392,709，地面主带 y≈-2，可走 50%）。
 * 用法：node scripts/gen-voxel-n3.mjs [input.ply]（默认指向 资产库/ N3 PLY）
 * 产物：public/assets/collision-n3.voxel-meta.json + collision-n3.voxel.bin
 */
import { statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const { run } = await import(pathToFileURL(resolve(ROOT, 'node_modules/@manycore/aholo-splat-transform/dist/index.js')).href);

const plyIn = (process.argv[2] ?? resolve(ROOT, '../资产库/N3雪原x唐风夜市-世界_2026-10-26.ply')).replaceAll('\\', '/');
if (!statSync(plyIn, { throwIfNoEntry: false })) { console.error(`找不到输入: ${plyIn}`); process.exit(1); }
const outDir = resolve(ROOT, 'public/assets').replaceAll('\\', '/');

const tmpDir = resolve(outDir, '.voxel-tmp-n3');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
const pipeline = {
  version: 1,
  tasks: [
    { id: 'read', type: 'Read', config: { inputs: [plyIn], output: 'world' } },
    {
      id: 'voxel',
      type: 'Voxel',
      config: { input: 'world', output: tmpDir.replaceAll('\\', '/'), backend: 'cpu', voxelResolution: 0.1, nodeEncoding: 'raw', compression: 'none', collisionMesh: false },
      release: ['world'],
    },
  ],
};
console.log(`生成 N3 体素碰撞: ${plyIn} -> ${outDir}/collision-n3.voxel-*`);
const t0 = Date.now();
await run(pipeline);
cpSync(`${tmpDir}/voxel-meta.json`, `${outDir}/collision-n3.voxel-meta.json`);
cpSync(`${tmpDir}/voxel.bin`, `${outDir}/collision-n3.voxel.bin`);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

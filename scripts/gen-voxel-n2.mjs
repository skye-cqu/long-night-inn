#!/usr/bin/env node
/**
 * gen-voxel-n2.mjs — N2 体素碰撞生成（输入=密度过滤后的 PLY，见
 * 过程留痕/2026-10-26/游戏工程-N2接入/clean-ply-n2.mjs；直接体素化原始 PLY 会把
 * 地面以下的悬浮絮状伪影也固化为实心，导致 colTop 落在 y≈-17 而非真实地面）。
 * 用法：node scripts/gen-voxel-n2.mjs [input.ply]（默认指向留痕清洗版）
 */
import { statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const { run } = await import(pathToFileURL(resolve(ROOT, 'node_modules/@manycore/aholo-splat-transform/dist/index.js')).href);

const plyIn = (process.argv[2] ?? resolve(ROOT, '../过程留痕/2026-10-26/游戏工程-N2接入/压缩工作区/N2-cleaned.ply')).replaceAll('\\', '/');
if (!statSync(plyIn, { throwIfNoEntry: false })) { console.error(`找不到输入: ${plyIn}`); process.exit(1); }
const outDir = resolve(ROOT, 'public/assets').replaceAll('\\', '/');

const tmpDir = resolve(outDir, '.voxel-tmp-n2');
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
console.log(`生成 N2 体素碰撞: ${plyIn} -> ${outDir}/collision-n2.voxel-*`);
const t0 = Date.now();
await run(pipeline);
cpSync(`${tmpDir}/voxel-meta.json`, `${outDir}/collision-n2.voxel-meta.json`);
cpSync(`${tmpDir}/voxel.bin`, `${outDir}/collision-n2.voxel.bin`);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

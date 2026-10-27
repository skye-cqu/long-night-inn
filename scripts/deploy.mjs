#!/usr/bin/env node
/**
 * deploy.mjs — 一键重部署到 GitHub Pages（E13 沉淀）
 * 前提：gh 已登录（gh auth status）；origin = skye-cqu/long-night-inn
 * 流程：npm run build → dist 临时仓 → 强推 gh-pages → Pages 自动发布（~1min）
 * 用法：node scripts/deploy.mjs
 */
import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });

console.log('[1/3] 构建（vite base=./ 相对基座）…');
run('npm run build');

console.log('[2/3] dist → gh-pages …');
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', { cwd: dist });
run('git add -A', { cwd: dist });
run('git commit -q -m "deploy: rebuild" --allow-empty', { cwd: dist });
if (!existsSync(resolve(dist, '.git/refs/remotes'))) {
  run('git remote add origin https://github.com/skye-cqu/long-night-inn.git', { cwd: dist });
}
run('git push -f origin gh-pages', { cwd: dist });

console.log('[3/3] 完成：https://skye-cqu.github.io/long-night-inn/ （Pages 发布约 1 分钟）');

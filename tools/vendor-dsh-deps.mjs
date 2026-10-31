// 从 DSH 的 app.asar 里提取 @deepseek-ai/* 依赖树，装进插件的 node_modules。
//
// 为什么需要：DSH 0.2.1-rc.5 的 @deepseek-ai/dsh-tools 带了一整排 peerDependencies
// （dsh-scope / dsh-llm / dsh-agent / dsh-session …），这些包在真实宿主里由 DSH 自己提供，
// 而插件在独立仓库里跑测试时没有它们，import dsh-tools 会一路 ERR_MODULE_NOT_FOUND。
// 用 npm 装不行：peer 版本互相咬合，--legacy-peer-deps 装完下一次 install 又会把 --no-save 的删掉。
// 所以直接从宿主归档里取，版本与宿主逐字节一致，也顺便证明插件适配的是宿主那一份实现。
//
// 用法：node tools/vendor-dsh-deps.mjs [--dry-run]
import { openSync, readSync, closeSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ASAR = 'D:\\deepseek\\resources\\app.asar';
const OUT_ROOT = 'D:\\dsh\\dsh-plugin-cdp\\node_modules\\@deepseek-ai';
const DRY = process.argv.includes('--dry-run');

const fd = openSync(ASAR, 'r');
const sb = Buffer.alloc(16);
readSync(fd, sb, 0, 16, 0);
const hs = sb.readUInt32LE(12);
const hb = Buffer.alloc(hs);
readSync(fd, hb, 0, hs, 16);
const header = JSON.parse(hb.toString('utf8').replace(/\0+$/u, ''));
const dataStart = 16 + hs;

const get = (p) => {
  const parts = p.split('/').filter(Boolean);
  let n = header;
  for (const x of parts) { if (!n.files || !n.files[x]) return null; n = n.files[x]; }
  return n;
};
const readEntry = (p) => {
  const n = get(p);
  if (!n || n.files) return null;
  const b = Buffer.alloc(n.size);
  readSync(fd, b, 0, n.size, dataStart + parseInt(n.offset, 10));
  return b;
};

// 1) 从入口包出发，递归收集 @deepseek-ai/* 的 dependencies + peerDependencies
const BASE = 'dsh/node_modules/@deepseek-ai';
const need = new Set();
const queue = ['dsh-tools', 'dsh-app-boot'];
const missing = [];
while (queue.length) {
  const name = queue.pop();
  if (need.has(name)) continue;
  const raw = readEntry(`${BASE}/${name}/package.json`);
  if (!raw) { missing.push(name); continue; }
  need.add(name);
  let j;
  try { j = JSON.parse(raw.toString('utf8')); } catch { continue; }
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(j[field] || {})) {
      if (dep.startsWith('@deepseek-ai/')) queue.push(dep.slice('@deepseek-ai/'.length));
    }
  }
}

console.log(`需要 ${need.size} 个包${missing.length ? `（缺失 ${missing.length}: ${missing.join(', ')}）` : ''}`);

// 2) 递归写出每个包的全部文件
let files = 0;
let bytes = 0;
const writeNode = (node, absDir) => {
  for (const [name, child] of Object.entries(node.files || {})) {
    const abs = join(absDir, name);
    if (child.files) {
      if (!DRY && !existsSync(abs)) mkdirSync(abs, { recursive: true });
      writeNode(child, abs);
    } else {
      files += 1;
      bytes += child.size || 0;
      if (!DRY) {
        mkdirSync(dirname(abs), { recursive: true });
        const b = Buffer.alloc(child.size);
        readSync(fd, b, 0, child.size, dataStart + parseInt(child.offset, 10));
        writeFileSync(abs, b);
      }
    }
  }
};

for (const name of need) {
  const node = get(`${BASE}/${name}`);
  if (!node || !node.files) { continue; }
  const outDir = join(OUT_ROOT, name);
  if (!DRY && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeNode(node, outDir);
}

closeSync(fd);
console.log(`${DRY ? '[dry-run] ' : ''}写入 ${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB -> ${OUT_ROOT}`);

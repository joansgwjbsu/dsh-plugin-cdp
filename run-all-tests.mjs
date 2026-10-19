// 一键跑全部单元测试 + 自检，并汇总结果。
//
// 为什么要一个总入口：插件有 4 个测试文件 + 1 个自检脚本，逐个手跑容易漏，
// 而且在版本适配时最需要的是「一句话结论 + 退出码」，好接 CI。
//
// 用法：
//   node run-all-tests.mjs          # 全部
//   node run-all-tests.mjs --quick  # 跳过需要联网/浏览器的自检
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// 测试文件与自检都在 lib/ 下，不是仓库根目录
const libDir = join(here, 'lib');
const quick = process.argv.includes('--quick');

const files = [
  'jobs.test.mjs',
  'report.test.mjs',
  'plugin.test.mjs',
  'supervisor.test.mjs',
  'match.test.mjs',
];

const results = [];
let failed = 0;

for (const file of files) {
  const path = join(libDir, file);
  const r = spawnSync(process.execPath, ['--test', path], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tests = /ℹ tests (\d+)/.exec(out)?.[1];
  const pass = /ℹ pass (\d+)/.exec(out)?.[1];
  const fail = /ℹ fail (\d+)/.exec(out)?.[1];
  const ok = r.status === 0;
  if (!ok) failed += 1;
  results.push({ file, ok, status: r.status, tests, pass, fail });
  console.log(`${ok ? '✅' : '❌'} ${file.padEnd(22)} tests=${tests ?? '?'} pass=${pass ?? '?'} fail=${fail ?? '?'}`);
  if (!ok) {
    // 只打印失败测试名，避免整屏噪音
    const lines = out.split('\n').filter((l) => /^\s*✖/.test(l) || /AssertionError/.test(l));
    for (const l of lines.slice(0, 8)) console.log(`     ${l.trim()}`);
  }
}

if (!quick) {
  const r = spawnSync(process.execPath, [join(libDir, 'selftest.mjs')], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  if (!ok) failed += 1;
  const verLine = out.split('\n').find((l) => l.includes('dsh-tools 校验器'))?.trim() || '';
  const countLine = out.split('\n').find((l) => l.includes('注册工具数'))?.trim() || '';
  const skipped = out.includes('Chrome 未运行');
  console.log(`${ok ? '✅' : '❌'} ${'selftest.mjs'.padEnd(22)} ${countLine}${skipped ? '（Chrome 未运行，跳过需浏览器的校验）' : ''}`);
  if (verLine) console.log(`     ${verLine}`);
  if (!ok) {
    for (const l of out.split('\n').filter((x) => /失败|Error|错误/.test(x)).slice(0, 8)) console.log(`     ${l.trim()}`);
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 个文件失败`);
process.exitCode = failed === 0 ? 0 : 1;

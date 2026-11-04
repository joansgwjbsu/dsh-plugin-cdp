// 校验 applyFlow 拼接出来的页面脚本是合法 JS。
//
// 为什么需要单独校验：applyFlow 返回的是一段**字符串**（要送进 CDP evaluate），
// 它的语法错误不会被 node --check 或任何 import 检查发现 —— 只有当真正去投递时
// 才会以 “SyntaxError: Unexpected token” 的形式炸在页面里，而那时候已经点过按钮了。
//
// 做法：从源码里取出 applyFlow 的箭头函数定义，用几种参数组合各生成一次，
// 全部交给 new Function 解析。
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const start = src.indexOf("const applyFlow = (");
if (start < 0) throw new Error("找不到 applyFlow 定义");
const endMark = "})()`;";
const end = src.indexOf(endMark, start);
if (end < 0) throw new Error("找不到 applyFlow 结尾");
const def = src.slice(start + "const applyFlow = ".length, end + endMark.length);

const build = new Function(`return (${def.replace(/;$/, "")})`)();

const cases = [
  { label: "带卡片标题选择器", cardTitleExpr: '() => { const e = document.querySelector(".c"); return e ? e.innerText : ""; }' },
  { label: "不带卡片标题选择器（退化路径）", cardTitleExpr: "" },
];

let bad = 0;
for (const c of cases) {
  const script = build({
    cardSelector: ".job-card",
    cardTitleSelector: undefined,
    cardTitleExpr: c.cardTitleExpr,
    titleExpr: '() => { const e = document.querySelector(".t"); return e ? e.innerText : ""; }',
    applySelector: ".apply",
    salaryExpr: '() => { const e = document.querySelector(".s"); return e ? e.innerText : ""; }',
  });
  try {
    // 只解析、不执行：new Function 在构造时就会抛 SyntaxError。
    new Function(`return ${script}`);
    console.log(`  OK   ${c.label}（${script.length} 字符）`);
  } catch (err) {
    bad += 1;
    console.log(`  FAIL ${c.label}: ${err.message}`);
    console.log(script);
  }
}

// 顺带确认两个新语义确实进了生成脚本
const s1 = build({
  cardSelector: ".job-card",
  cardTitleExpr: "",
  titleExpr: "() => 1",
  applySelector: ".apply",
  salaryExpr: "() => 1",
});
for (const token of ["titleMatched", "confirmed", "panel title does not match the picked card"]) {
  if (!s1.includes(token)) {
    bad += 1;
    console.log(`  FAIL 生成脚本缺少 ${token}`);
  }
}

if (bad) {
  console.log(`\n失败 ${bad} 项`);
  process.exit(1);
}
console.log("\napplyFlow 生成脚本校验通过");

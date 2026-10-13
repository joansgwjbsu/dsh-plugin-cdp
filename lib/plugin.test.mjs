/**
 * 插件层测试 —— 工具返回值与报告文本必须一致。
 *
 * 存在的理由（2026-10-13 实测发现）：`cdp_jobs_report` 的 jobCount 取了未过滤的
 * payload.jobs.length，于是筛选「北京·已投递」时报告头部写「岗位 7」而返回值 81。
 * 第一次修复时我把筛选算进了局部变量，**但 return 里仍写原始表达式** —— 变量算了
 * 却没用上，属于只看代码不容易发现、只看输出才发现的那类错误。
 * 因此这里断言的是「返回值 == 报告头部显示的数字」，而不是断言某个实现细节。
 *
 * 用法：node D:\dsh\dsh-plugin-cdp\lib\plugin.test.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("file:///D:/dsh/dsh-plugin-cdp/lib/index.mjs");

/**
 * DSH 自己的输出校验器。
 *
 * ⚠️ 2026-10-13 真实踩到的坑，也是这个测试存在的理由：
 *   `cdp_runner_status` 的 output.schema 漏声明了 uptimeMs / snapshotGeneration /
 *   workerAliveHint，而 execute() 会返回它们。本地自检当时只断言「execute() 不抛错」，
 *   所以完全没发现；只有在真实 DSH 里调用才被拒绝：
 *     tool "cdp_runner_status" returned invalid output:
 *     "value.uptimeMs" is not a declared property (additionalProperties: false)
 *   教训：「本地跑通」不等于「宿主里跑通」，必须用宿主的校验器验证输出。
 */
const { validateJsonSchemaValue } = await import(
  "file:///C:/Users/77841/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js"
);

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "cdp-plugin-"));
const registered = [];
plugin.apply(
  { tools: { register: (d) => { registered.push(d); return () => {}; } } },
  { prefsPath: join(dir, "prefs.json"), stateDir: join(dir, "state") },
);
const call = async (name, args = {}) => {
  const def = registered.find((d) => d.name === name);
  if (!def) throw new Error(`工具未注册: ${name}`);
  return await def.execute(args);
};

console.log("插件层测试：返回值与报告文本一致性\n");

try {
  /* ---------- 1. 工具注册完整性 ---------- */
  console.log("1) 工具注册");
  const EXPECTED = [
    "cdp_status", "cdp_navigate", "cdp_eval", "cdp_read", "cdp_screenshot",
    "cdp_new_tab", "cdp_use_tab", "cdp_apply_verified",
    "cdp_prefs", "cdp_browser_info", "cdp_jobs_report", "cdp_jobs_data",
    "cdp_runner_status", "cdp_runner_reload", "cdp_runner_stop",
  ];
  const names = registered.map((d) => d.name);
  for (const want of EXPECTED) ok(names.includes(want), `已注册 ${want}`);
  ok(names.length === EXPECTED.length, `工具总数恰为 ${EXPECTED.length}（实际 ${names.length}）`);

  /* ---------- 2. jobCount 必须等于报告头部 ---------- */
  console.log("\n2) jobCount 必须等于报告头部显示的岗位数");
  const cases = [
    ["无筛选", {}],
    ["城市=北京", { city: "北京" }],
    ["判定=已投递", { decision: "applied" }],
    ["判定=待投", { decision: "pending" }],
    ["判定=已排除", { decision: "skipped" }],
    ["城市=北京 判定=已投递", { city: "北京", decision: "applied" }],
  ];
  for (const [label, args] of cases) {
    const v = await call("cdp_jobs_report", { mode: "brief", ...args });
    const head = (v.text.match(/岗位 (\d+) ·/) || [])[1];
    ok(head !== undefined, `${label}：报告头部含岗位数`);
    ok(
      String(v.jobCount) === head,
      `${label}：返回 ${v.jobCount} == 报告 ${head}`,
      `返回=${v.jobCount} 报告=${head}`,
    );
  }

  /* ---------- 3. 平台筛选同时作用于岗位与投递数 ---------- */
  console.log("\n3) 平台筛选：岗位数与投递数都要跟着变");
  const all = await call("cdp_jobs_report", { mode: "brief" });
  const lp = await call("cdp_jobs_report", { mode: "brief", platform: "liepin" });
  ok(lp.jobCount < all.jobCount, `猎聘岗位数(${lp.jobCount}) < 全量(${all.jobCount})`);
  ok(lp.appliedCount < all.appliedCount, `猎聘投递数(${lp.appliedCount}) < 全量(${all.appliedCount})`);
  ok(lp.appliedCount <= lp.jobCount + 100, "投递数为正数且量级合理");

  /* ---------- 4. 筛选结果必须真的收窄 ---------- */
  console.log("\n4) 筛选必须真的收窄，不是只改标题");
  const pending = await call("cdp_jobs_report", { mode: "brief", decision: "pending" });
  ok(pending.jobCount > 0 && pending.jobCount < all.jobCount, `待投筛选收窄到 ${pending.jobCount}`);
  ok(/待投/.test(pending.text), "报告里出现待投相关字样");

  /* ---------- 5. appliedCount 只数 kind=applied ---------- */
  console.log("\n5) appliedCount 只能数 kind=applied（失败事件不得计入）");
  const data = await call("cdp_jobs_data");
  if (data.ok) {
    const total = data.payload.applied.length;
    const appliedOnly = data.payload.applied.filter((e) => e.kind === "applied").length;
    ok(total > appliedOnly, `事件总数(${total}) 大于投递数(${appliedOnly})，说明确实有失败事件`);
    ok(
      all.appliedCount === appliedOnly,
      `appliedCount(${all.appliedCount}) == kind=applied(${appliedOnly})`,
      `返回=${all.appliedCount} 实际=${appliedOnly}`,
    );
  } else {
    console.log("  (跳过：数据模块不可用)");
  }

  /* ---------- 6. 偏好工具在无配置时要求询问 ---------- */
  console.log("\n6) 全新用户：cdp_prefs 必须要求弹窗询问");
  const fresh = await call("cdp_prefs");
  ok(fresh.needsAsk === true, "needsAsk=true");
  ok(fresh.required.length >= 4, `报出至少 4 项缺失（实际 ${fresh.required.length}）`);
  const q = fresh.suggestedQuestions.questions;
  ok(q.length >= 5, `问卷至少 5 题（实际 ${q.length}）`);
  const ruleQuestions = q.filter((x) => ["titles", "locations", "salary", "excludeNotes"].includes(x.id));
  ok(
    ruleQuestions.every((x) => !x.options || x.options.length === 0),
    "规则类问题不得预置选项（插件不携带规则）",
  );
  ok(
    q.every((x) => !(x.options || []).some((o) => /Recommended/i.test(o.label))),
    "任何问题都不得标 Recommended",
  );

  /* ---------- 7. 每个工具的返回值必须符合自己的 output.schema ---------- */
  console.log("\n7) 输出必须通过宿主校验（防「schema 漏声明字段」）");
  const probeArgs = {
    cdp_status: {},
    cdp_prefs: {},
    cdp_browser_info: {},
    cdp_jobs_report: { mode: "brief" },
    cdp_jobs_data: {},
    cdp_runner_status: {},
  };
  for (const [toolName, args] of Object.entries(probeArgs)) {
    const def = registered.find((d) => d.name === toolName);
    if (!def) continue;
    let value;
    try {
      value = await def.execute(args);
    } catch (err) {
      ok(false, `${toolName} 可执行`, String(err?.message || err));
      continue;
    }
    const violations = validateJsonSchemaValue(def.output.schema, value, "");
    ok(
      violations.length === 0,
      `${toolName} 输出通过 schema 校验`,
      violations.join("; "),
    );
  }

  /* 特意覆盖「返回对象字段多于 schema 声明」这种情况：
     cdp_runner_status 曾经的失败形态正是如此。 */
  console.log("\n8) cdp_runner_status 的返回字段必须全部在 schema 里声明");
  {
    const def = registered.find((d) => d.name === "cdp_runner_status");
    const value = await def.execute({});
    const declared = new Set(Object.keys(def.output.schema.properties || {}));
    const returned = Object.keys(value);
    const undeclared = returned.filter((k) => !declared.has(k));
    ok(undeclared.length === 0, "无未声明字段", `未声明: ${undeclared.join(", ")}`);
  }

  /* ---------- 9. 偏好必须能加也能删 ---------- */
  /*
   * 2026-10-13 真实踩到：用户想清掉已填的排除规则，传了空值，偏好里仍是 3 条。
   * 根因是 mergeAnswers 只做「合并」，把空答案当成「没回答」，旧值原样保留 ——
   * 于是排除规则、城市、岗位方向全都只能加不能删，用户无法撤回自己填过的规则。
   * 这里守住增删对称。
   */
  console.log("\n9) 偏好必须可增可删（不能只加不减）");
  {
    const set = await call("cdp_prefs", {
      answers: {
        answers: [
          { id: "titles", selected: [], custom: "方向A、方向B" },
          { id: "locations", selected: [], custom: "城市A、城市B" },
          { id: "salary", selected: [], custom: "城市A 1000，城市B 2000" },
          { id: "excludeNotes", selected: [], custom: "排除1、排除2、排除3" },
        ],
      },
    });
    ok(set.prefs.excludeNotes.length === 3, "初始 3 条排除规则");
    ok(Object.keys(set.prefs.salaryFloor).length === 2, "初始 2 个城市下限");

    const cleared = await call("cdp_prefs", { answers: { answers: [{ id: "excludeNotes", selected: [], custom: "" }] } });
    ok(cleared.prefs.excludeNotes.length === 0, "排除规则可清空", JSON.stringify(cleared.prefs.excludeNotes));
    ok(cleared.prefs.titles.length === 2, "未回答的字段保持不变");
    ok(Object.keys(cleared.prefs.salaryFloor).length === 2, "未回答薪资时 salaryFloor 保持");

    const shrunk = await call("cdp_prefs", { answers: { answers: [{ id: "locations", selected: [], custom: "城市A" }] } });
    ok(shrunk.prefs.locations.length === 1, "地点可减少到 1 个");
  }

  /* ---------- 10. 城市名要支持中英混合 ---------- */
  console.log("\n10) 薪资下限解析要支持中英混合城市名");
  {
    const cases = [
      ["城市A 1000，城市B 2000", { 城市A: 1000, 城市B: 2000 }],
      ["北京 7000，太原 4000", { 北京: 7000, 太原: 4000 }],
      ["Shanghai 12000", { Shanghai: 12000 }],
      ["北京 7k，太原 4k", { 北京: 7000, 太原: 4000 }],
    ];
    for (const [text, want] of cases) {
      const r = await call("cdp_prefs", {
        answers: { answers: [{ id: "locations", selected: [], custom: Object.keys(want).join("、") }, { id: "salary", selected: [], custom: text }] },
      });
      /* 注意：同一个临时偏好文件在用例间是复用的，salaryFloor 会累积
         （这正是"未回答时保留旧值"的正确行为），所以断言"包含"而非"等于"。 */
      const missing = Object.entries(want).filter(([city, floor]) => r.prefs.salaryFloor[city] !== floor);
      ok(
        missing.length === 0,
        `「${text}」解析正确`,
        `缺/错: ${JSON.stringify(missing)}  实际: ${JSON.stringify(r.prefs.salaryFloor)}`,
      );
    }
  }

  /* ---------- 11. salaryCities 必须能删掉误写入的城市 ---------- */
  /*
   * 2026-10-13 踩到：salaryFloor 是**按城市合并**（本次提到的覆盖、未提到的保留），
   * 所以误写入的城市名用问答清不掉 —— 缺一个「删城市」的入口。
   * cdp_prefs 因此提供 salaryCities 参数显式限定城市集合。
   */
  console.log("\n11) salaryCities 可显式限定城市集合（删除误写入的城市）");
  {
    const seeded = await call("cdp_prefs", {
      answers: { answers: [{ id: "salary", selected: [], custom: "北京 7000，太原 4000，误写城市 9999" }] },
    });
    ok(seeded.prefs.salaryFloor["误写城市"] === 9999, "已写入待清理的城市");

    const cleaned = await call("cdp_prefs", { salaryCities: ["北京", "太原"] });
    ok(cleaned.prefs.salaryFloor["误写城市"] === undefined, "误写入的城市已被删除");
    ok(cleaned.prefs.salaryFloor["北京"] === 7000, "保留的城市下限未变");
    ok(cleaned.notes.some((n) => /已移除/.test(n)), "notes 说明移除了什么");

    const untouched = await call("cdp_prefs", { answers: { answers: [{ id: "titles", selected: [], custom: "方向X" }] } });
    ok(untouched.prefs.salaryFloor["北京"] === 7000, "不传 salaryCities 时 salaryFloor 不受影响");
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
// 不用 process.exit()：在有未关闭 handle 时强杀进程会触发 libuv 的
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（Node 24 / Windows），
// 把退出码污染成 1，于是「测试全绿」却让调用方以为失败。
// 设置 exitCode 并让事件循环自然排空即可。
process.exitCode = fail ? 1 : 0;

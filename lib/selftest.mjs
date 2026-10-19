/**
 * 插件加载自检 —— 用真实 DSH 包导入插件，确认它能真正加载并注册工具。
 *
 * ⚠️ 这里有一个曾经踩过的坑，写在最前面免得后人重蹈：
 *   lib/index.mjs 里是 `ctx.tools.register(defineTool(tool))` —— defineTool
 *   在插件内部就被调用了。所以 mock 的 ctx.tools.register 收到的**已经是
 *   defineTool 的编译产物**（parameters 已变成 JSON Schema、属性级 required
 *   已折叠成顶层 required 数组）。如果在这里再对它调用一次 defineTool，
 *   就是把编译产物当作者 DSL 二次编译，**必然报错**，而且会连线上一直正常
 *   的工具一起报错 —— 我一度据此误判插件坏了。不要重复调用 defineTool。
 *
 *   「插件定义是否合法」这件事，本身就是由插件内部的 defineTool 调用证明的：
 *   它没抛错，注册就发生了；它抛错，apply() 就会炸。所以本自检只需断言
 *   「apply 没炸 + 工具齐全 + 编译产物形状正确 + 工具能执行」。
 *
 * 用法：node D:\dsh\dsh-plugin-cdp\lib\selftest.mjs
 */
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import(pathToFileURL("D:/dsh/dsh-plugin-cdp/lib/index.mjs").href);

const registered = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
};

/**
 * 用 DSH 自己的校验函数检查输出。
 *
 * ⚠️ 为什么必须加这一步（2026-10-13 真实踩到）：
 *   `cdp_runner_status` 的 output.schema 漏声明了 uptimeMs / snapshotGeneration /
 *   workerAliveHint 三个字段，而 execute() 会返回它们。本地自检原本只断言
 *   「execute() 不抛错」，所以**完全没发现**；只有在真实 DSH 里调用时才会被
 *   输出校验拒绝：
 *     tool "cdp_runner_status" returned invalid output:
 *     "value.uptimeMs" is not a declared property (additionalProperties: false)
 *   教训：output.schema 必须与 execute() 的返回对象逐一对应，不能只写主要字段；
 *   而且「本地跑通」不等于「在宿主里跑通」，必须用宿主的校验器验一遍。
 *
 * ⚠️ 解析方式的变更（2026-10-19，适配 DSH 0.2.1-rc.2）：
 *   旧版这里写死了绝对路径
 *     file:///C:/Users/77841/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js
 *   两个问题：一是机器专属，换台机器/换 profile 就找不到；
 *   二是它指向旧版本 0.2.0-rc.2，DSH 升级后校验器已不是同一份代码，
 *   「用宿主校验器验证」的前提就不成立了。
 *   现在改为从插件自身的 devDependencies 解析（版本在 package.json 里钉死，
 *   与宿主保持一致），并打印实际用的版本，避免再次悄悄校验了别的副本。
 */
const dshTools = await import("@deepseek-ai/dsh-tools").catch(async () => {
  // 兜底：从插件目录解析（selftest 放在 lib/ 下）
  return import(new URL("../node_modules/@deepseek-ai/dsh-tools/lib/index.js", import.meta.url).href);
});
const { validateJsonSchemaValue } = dshTools;
const validateOutput = (schema, value) => validateJsonSchemaValue(schema, value, "");

// 打印实际使用的 dsh-tools 版本：自检的价值在于「用与宿主同一份校验器」。
// dsh-tools 不导出 version，只能读它自己的 package.json。
let dshToolsVersion = "(未知)";
try {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  dshToolsVersion = req("@deepseek-ai/dsh-tools/package.json").version;
} catch { /* 读不到就保持未知，不影响自检 */ }
console.log(`ℹ dsh-tools 校验器: v${dshToolsVersion}（应为宿主同版本，DSH 0.2.1-rc.2 = 0.2.1-rc.2）`);

const failures = [];
const check = (cond, message) => {
  if (!cond) failures.push(message);
};

/* 1) 模块形状 */
check(typeof plugin.name === "string" && plugin.name, "插件没有导出非空 name");
check(Array.isArray(plugin.inject), "插件没有导出 inject 数组");
check(typeof plugin.apply === "function", "插件没有导出 apply 函数");
check(!!plugin.Config, "插件没有导出 Config");

/* 2) apply() 能跑通 —— 这一步同时证明每个工具的作者 DSL 都被 defineTool 接受了 */
const tmpPrefs = join(mkdtempSync(join(tmpdir(), "cdp-selftest-")), "prefs.json");
const tmpState = join(tmpPrefs, "..", "state");
try {
  plugin.apply(ctx, { prefsPath: tmpPrefs, stateDir: tmpState });
} catch (err) {
  failures.push(`apply() 抛错（说明某个工具定义被 defineTool 拒绝）：${err?.message || err}`);
}

/* 3) 编译产物形状 */
const names = [];
for (const def of registered) {
  const toolName = def?.name || "(无名)";
  names.push(toolName);
  check(typeof def?.description === "string" && def.description.length > 0, `${toolName} 缺少 description`);
  check(typeof def?.output?.render === "function", `${toolName} 缺少 output.render`);

  const params = def?.parameters;
  check(!!params && typeof params === "object", `${toolName} 的 parameters 不是对象`);
  check(params?.type === "object", `${toolName} 的 parameters.type 不是 "object"（实际 ${JSON.stringify(params?.type)}）`);
  check(!!params?.properties && typeof params.properties === "object", `${toolName} 的 parameters 缺少 properties`);

  const out = def?.output?.schema;
  check(!!out && typeof out === "object", `${toolName} 的 output.schema 不是对象`);
  check(out?.type === "object", `${toolName} 的 output.schema.type 不是 "object"`);
  check(!!out?.properties && typeof out.properties === "object", `${toolName} 的 output.schema 缺少 properties`);
  if (out && "required" in out) {
    check(Array.isArray(out.required), `${toolName} 的 output.schema.required 不是数组`);
    for (const key of out.required || []) {
      check(key in (out.properties || {}), `${toolName} 的 required 里有未声明的属性 ${key}`);
    }
  }
  check(typeof def?.execute === "function", `${toolName} 缺少 execute`);
}

/* 4) 期望存在的工具（含本轮新增的三个） */
const EXPECTED = [
  "cdp_status",
  "cdp_navigate",
  "cdp_eval",
  "cdp_read",
  "cdp_screenshot",
  "cdp_new_tab",
  "cdp_use_tab",
  "cdp_apply_verified",
  "cdp_prefs",
  "cdp_browser_info",
  "cdp_jobs_report",
  "cdp_jobs_data",
  "cdp_runner_status",
  "cdp_runner_reload",
  "cdp_runner_stop",
];
for (const want of EXPECTED) check(names.includes(want), `缺少工具 ${want}`);

/* 5) 工具真的能执行；数据模块缺失时必须优雅降级而不是抛错 */
const byName = new Map(registered.map((d) => [d.name, d]));
const runProbe = async (toolName, args) => {
  const def = byName.get(toolName);
  if (!def) return;
  try {
    const result = await def.execute(args);
    check(result !== undefined, `${toolName}.execute() 返回 undefined`);

    /* 关键：用 DSH 的校验器验证输出，捕捉「schema 漏声明字段」这类
       只有宿主才会拒绝的错误。 */
    const violations = validateOutput(def.output.schema, result);
    check(
      violations.length === 0,
      `${toolName} 的输出不符合自己的 output.schema：${violations.join("; ")}`,
    );

    /* 关键：输出必须是「无损 JSON」。
       踩过的坑（2026-10-13，真实 DSH 报错 `value is not lossless JSON`）：
       cdp_runner_reload 在 started/unchanged 分支返回了
       `retiredGeneration: undefined`，而 undefined 不是合法 JSON 值，
       序列化直接失败。本机 execute() 不做序列化，所以以前完全没暴露。
       这里显式往返序列化一次，把这类错误在自检阶段就挡住。 */
    const undeclared = Object.keys(result || {}).filter(
      (k) => !(def.output.schema?.properties && k in def.output.schema.properties),
    );
    check(
      undeclared.length === 0,
      `${toolName} 返回了 schema 未声明的字段：${undeclared.join(", ")}`,
    );
    let roundTrip = null;
    try {
      const json = JSON.stringify(result);
      check(json !== undefined, `${toolName} 的输出无法序列化为 JSON`);
      roundTrip = JSON.parse(json);
    } catch (err) {
      failures.push(`${toolName} 的输出不是无损 JSON：${err?.message || err}`);
    }
    if (roundTrip !== null) {
      const dropped = Object.keys(result || {}).filter(
        (k) => result[k] === undefined || !(k in roundTrip),
      );
      check(
        dropped.length === 0,
        `${toolName} 的输出含 undefined 字段（序列化时会丢失）：${dropped.join(", ")}`,
      );
    }

    if (toolName === "cdp_jobs_report") {
      // 数据模块可能尚未就绪：ok 可以是 false，但必须给出可读文本而不是抛错
      check(typeof result?.text === "string" && result.text.length > 0, `${toolName} 没有返回可读文本`);
      check(typeof result?.jobCount === "number", `${toolName} 的 jobCount 不是数字`);
    }
    return result;
  } catch (err) {
    failures.push(`${toolName}.execute() 抛错：${err?.message || err}`);
    return null;
  }
};

/* 无副作用的工具：每次都验 */
await runProbe("cdp_prefs", {});
await runProbe("cdp_browser_info", {});
await runProbe("cdp_jobs_report", { mode: "brief" });
await runProbe("cdp_jobs_report", { mode: "full", city: "北京", decision: "applied" });
await runProbe("cdp_jobs_data", {});
// 运行器状态查询必须可用；这里**故意不**调 cdp_runner_reload，
// 因为那会真的派生一个后台进程，自检不应该产生副作用。
await runProbe("cdp_runner_status", {});

/* CDP 工具：只在已有浏览器在跑时才验，避免自检去启动 Chrome。
   这样既覆盖了这些工具的 output.schema，又不产生「自检把浏览器拉起来」的副作用。 */
const st = await runProbe("cdp_status", {});
if (st && st.alive) {
  await runProbe("cdp_eval", { script: "() => ({ href: location.href })" });
  await runProbe("cdp_read", { maxChars: 200 });
  await runProbe("cdp_screenshot", { path: join(tmpState, "selftest-shot.png") });
  await runProbe("cdp_use_tab", { targetId: st.tabs?.[0] ? String(st.tabs[0]).split(" | ")[0] : "noop" });
} else {
  console.log("(Chrome 未运行，跳过需要浏览器的 CDP 工具的输出校验)");
}

try {
  rmSync(join(tmpPrefs, ".."), { recursive: true, force: true });
} catch {
  /* 清理失败不影响判定 */
}

console.log(`插件名：${plugin.name}`);
console.log(`注册工具数：${registered.length}`);
console.log(`工具清单：${names.join(", ")}`);
console.log(`inject：${plugin.inject.join(", ")}`);
console.log("");

if (failures.length) {
  console.log("❌ 自检失败：");
  for (const f of failures) console.log("   - " + f);
  // 用 exitCode 而不是 process.exit()，避免 libuv 的 handle-closing 断言
  // 把退出码污染成与真实结果无关的值。
  process.exitCode = 1;
} else {
  console.log("✅ 插件加载自检通过");
}

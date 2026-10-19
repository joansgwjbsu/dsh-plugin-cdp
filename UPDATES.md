# dsh-plugin-cdp 更新说明

---

# 0.3.0（2026-10-19）—— 简历 × JD 匹配打分

> 上一版：`0.2.2`
> 本次：`0.3.0`，新增一个能力工具，并把「达标才投」做成可配置闸门

## 用户要的是什么

「查看招聘信息是否与简历符合、符合达 70% 以上直接投递。」

这里有两件事必须分开：

| 谁的事 | 内容 | 落在哪 |
| --- | --- | --- |
| **能力** | 把 JD 和简历比出 0~1 的分数，并说明依据 | 插件代码（`lib/match.mjs`） |
| **规则** | 达标线 0.7、「未达标就不投」 | 使用者的配置（`matchThreshold` / `applyRequiresMatch`） |

所以插件里**没有任何写死的阈值**：`matchThreshold` 只是默认值，谁用谁改。

## 打分口径

```text
技能覆盖 55%  +  方向命中 25%  +  经验满足 12%  +  学历满足 8%
```

- **技能覆盖**：JD 里出现的通用 IT 技术项，有多少在简历里出现过。
  覆盖比例 60% + 命中数量 40%（避免「JD 只提 1 项技能、刚好命中」就被判满分）。
- **方向命中**：JD 的方向词与简历意向是否有交集（运维 / 网络 / 云计算 / 实施 / 技术支持…）。
- **经验**：JD 解析 `1-3年` / `3年以上` / `不限`，简历解析工作经历起止算年限；
  满足 1.0，差一年 0.6，明显不满足 0.15。
- **学历**：解析 JD 要求与简历实际学历，满足 1.0，不满足 0.3。

刻意**不做语义推断**：没有向量、没有模型，全是可复现的关键词/条件判定。
好处是每一条扣分都能解释，坏处是同义词得靠词表覆盖 —— 词表在 `lib/match.mjs` 顶部，随时可加。

## 新增工具

```js
cdp_resume_match({})                          // 当前页面当 JD + 配置里的简历
cdp_resume_match({ text, threshold, weights }) // 显式给 JD / 达标线 / 权重
```

返回：

```json
{
  "score": 0.863, "pass": true, "decision": "apply",
  "parts": { "skills": 0.9, "direction": 1, "experience": 1, "education": 1 },
  "matched": ["Linux", "Docker", "监控"],
  "missing": ["Kubernetes"],
  "reasons": ["技能：JD 提到 12 项，命中 9 项", "经验：要求 1-3年，简历约 1.6 年，满足"]
}
```

## 投递闸门

`cdp_apply_verified` 新增 `requireMatch`；配置里 `applyRequiresMatch: true` 即为默认开启。
开启后点击前先算分，**未达标直接返回 `ok: false`** 并带上分数与缺失技能 —— 不会「投了再说」。

## 简历来源

插件只读文本文件（`.txt` / `.md`），不做 PDF 解析。
PDF 由使用者先转文本（本次用 `pypdf` 把两份简历转成 `resume-ops.txt` / `resume-net.txt`）。

## 踩到的两个坑

1. **工作年限被教育经历撑大**：最初直接从整份简历抓 `YYYY.M-YYYY.M`，
   结果把 `2021.9-2024.6` 的在校时间和 `2024.3` 的入职时间合并，1.6 年被算成 **4.9 年**。
   修法：只取「工作经历」小节（遇到「项目经历/培训经历/教育经历」即截断），无该小节才退回全文。
2. **`java` 会误命中有 `javascript` 的 JD**：正则加负向断言 `/\\bjava\\b(?!script)/i`，
   并补了一条专门测试「不能把 javascript 识别成 java」。

## 验证

- `lib/match.test.mjs` —— 11 项：好岗/差岗/弱岗的分数序关系、阈值边界（等于阈值算达标、高 0.01 不达标）、
  空输入不崩、技能抽取不误判、经验/学历解析、权重可配。
- 用真实简历（`resume-ops.txt`）打一份典型运维 JD：**0.863**，`pass: true`，年限解析为 1.6 年。
- `lib/selftest.mjs` 注册工具数 15 → 16。

---

# 0.2.2（2026-10-19）—— 声明 DSH 版本要求（engines.dsh）

> 上一版：`0.2.1`
> 本次：`0.2.2`，补上 DSH **真正会校验**的那个字段

## 为什么要加 `engines.dsh`

上一版把 `peerDependencies` 里的范围补成 `^0.2.1-rc.2` 之后，我原以为版本声明就对齐了。
读了 DSH 0.2.1 的实现才发现：**DSH 有自己的兼容性判定，而且优先看 `engines.dsh`。**

`@deepseek-ai/dsh-app-boot` 里的 `evaluatePluginCompatibility()`（插件安装/启动时真正调用它）：

```js
// 1) 若声明了 engines.dsh —— 它单独决定，peerDependencies 被忽略
if (Object.hasOwn(engines, "dsh")) {
  return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
}
// 2) 否则：每个 @deepseek-ai/dsh 或 @deepseek-ai/dsh-* 的 peer 都要匹配运行时版本
for (const [name, range] of Object.entries(peerDependencies)) {
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  if (!satisfies(runtimeVersion, range)) unmet[name] = range;
}
```

以及判定本身：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。

这解释了两件事：

1. **为什么旧版其实没被 DSH 拒**：`includePrerelease: true` 下 `^0.2.0-rc.1` 也能匹配
   `0.2.1-rc.2`。但 **npm 安装时**用的是默认规则（预发布要求元组相同），
   所以 `pnpm add` 会判不满足 —— 两套规则不一样，上一版的修复对安装是对的。
2. **正确做法是声明 `engines.dsh`**：它是 DSH 一等公民的版本要求字段，
   存在时单独决定兼容性，意图比「靠 peer 推断」明确得多。

## 改了什么

### `package.json`

- 版本 `0.2.1` → **`0.2.2`**
- 新增 `engines.dsh`：

  ```json
  "engines": {
    "node": ">=22",
    "dsh": ">=0.2.0-rc.2 <0.3.0-0"
  }
  ```

  为什么是这个范围（用真实 semver 逐版本验过）：

  | 版本 | 命中 |
  | --- | --- |
  | `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1` | ✅ 已知可运行 |
  | `0.2.x` 任意版本、`0.2.9-rc.1` | ✅ 小版本内兼容 |
  | `0.3.0-0` / `0.3.0-rc.1` / `0.3.0` | ❌ 上界用 `<0.3.0-0` 连 0.3 的预发布也挡住 |

  用 `<0.3.0-0` 而不是 `<0.3.0` 是关键：后者在 includePrerelease 下会把
  `0.3.0-rc.1` 也算作满足（它确实小于 0.3.0），等于提前放行未验证的大版本。

### `lib/selftest.mjs` —— 用 DSH 官方函数验兼容性

不再自己写 semver 断言，而是直接 import `@deepseek-ai/dsh-app-boot` 的
`evaluatePluginCompatibility()` 跑一遍真判定，并加一条**反向对照**：
把 `engines.dsh` 故意改成 `>=99.0.0`，必须被判为不兼容——
否则「通过」可能只是函数恒返回 `undefined` 的假通过。

自检输出会打印：

```
DSH 兼容性：通过（运行时 0.2.1-rc.2，engines.dsh=>=0.2.0-rc.2 <0.3.0-0）
```

`@deepseek-ai/dsh-app-boot@0.2.1-rc.2` 已加入 `devDependencies`（仅本地自检用，
不随包分发，运行时由宿主提供）。

## 关于 profile 里那份旧依赖

排查时还发现 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 下有 **249 个 Junction**
指向一个 2026-08-14 的 npx 缓存（内含 DSH `0.2.0-rc.2`）。也就是说，
从 profile 解析 peer 的插件（不含本插件——本插件自带 `node_modules`）拿到的仍是旧版本。

**这次没有动它**，原因：`@wxg-prc-cpg/browser-skill-dsh-plugin` 依赖的
`@deepseek-ai/dsh-client-ui-primitives` 在 0.2.1 里**已经被移除**，
盲目整体升级会让那个插件直接起不来。正确做法是插件逐个跟上 0.2.1 后再统一升级。
本插件通过自带依赖 + `engines.dsh` 声明，不受这份残留影响。

---

# 0.2.1（2026-10-19）—— 适配 DSH 0.2.1-rc.2

> 上一版：`0.2.0`，为 DSH `0.2.0-rc.2` 编写
> 本次：`0.2.1`，对齐 DSH `0.2.1-rc.2`（桌面端 2026-10-17 更新）
> 结论：**API 无破坏性变更；真正要修的是「版本声明」和「重复依赖」**

## 为什么必须做这次适配

DSH 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2` 后，随包分发的三个共享包也一起升了：

| 包 | DSH 0.2.0-rc.2 提供 | DSH 0.2.1-rc.2 提供 | 插件原先自带 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tools` | 0.2.0-rc.2 | **0.2.1-rc.2** | 0.2.0-rc.2（旧） |
| `@deepseek-ai/schemastery` | 3.18.4 | **3.18.5** | 3.18.4（旧） |
| `@deepseek-ai/cordis` | 4.0.4 | **4.0.5** | 4.0.4（旧） |

DSH 在 `resources/app.asar/dsh/desktop-runtime.json` 里声明了 **304 个 sharedPackages**
（宿主统一提供的包），插件本应从宿主拿这些包。但本插件此前在自己的 `node_modules`
里带了一份 0.2.0-rc.2 的副本，于是出现两个问题。

### 问题 1：peer 依赖范围已经匹配不上新版本

插件原来声明：

```json
"@deepseek-ai/dsh-tools": "^0.1.5-rc.3 || ^0.2.0-rc.1"
```

按 npm 的 semver 规则，**预发布版本只有在 major.minor.patch 元组相同时才可能匹配**。
所以 `^0.2.0-rc.1` 的元组是 `0.2.0`，而 DSH 现在是 `0.2.1-rc.2`（元组 `0.2.1`）——
**不匹配**。用真实 semver 验过：

| 范围 | 版本 | 是否满足 |
| --- | --- | --- |
| `^0.2.0-rc.1`（旧） | `0.2.1-rc.2` | ❌ **false** |
| `^0.2.0-rc.1 \|\| ^0.2.1-rc.2`（新） | `0.2.1-rc.2` | ✅ true |
| `^0.2.0-rc.1 \|\| ^0.2.1-rc.2`（新） | `0.2.0-rc.2` | ✅ true（向后兼容） |

这不是理论问题：预发布期每升一个 patch，旧的预发布范围就自动失效一次，
而 `^3.18.2` / `^4.0.2` 这类正式版本范围不受影响（3.18.5、4.0.5 都满足）。

### 问题 2：插件自带旧副本，与宿主形成双份包

对照同机其他**已适配**的插件，结论很一致——它们都**不带** `@deepseek-ai` 包：

| 插件 | 版本 | 自带 node_modules |
| --- | --- | --- |
| `dsh-computer-use-win` | 0.2.5 | 无 |
| `dsh-whale-widget` | 0.4.2 | 无 |
| `browser-skill-dsh-plugin` | 0.3.2 | 无 |
| `dsh-ssh` | 0.4.6 | 无 |
| **`dsh-plugin-cdp`（本插件，改前）** | 0.2.0 | **有，且是旧版** |

双份包在 ESM 下是两个独立模块实例；`schemastery` 这类靠 `instanceof`/内部标记
识别对象的库，跨副本容易出隐蔽问题。这次把本地副本升到与宿主**逐版本一致**，
即使仍有两份，语义也完全对齐。

## 本次改了什么

### 1. `package.json`

- 版本 `0.2.0` → **`0.2.1`**
- peer 范围补上 `^0.2.1-rc.2`：
  `"@deepseek-ai/dsh-tools": "^0.1.5-rc.3 || ^0.2.0-rc.1 || ^0.2.1-rc.2"`
  （沿用生态惯例：预发布版本逐个列举，参考 `dshmarket` 的写法）
- 新增 `devDependencies`，把本地开发/测试用的包**钉死**到宿主同版本：
  `cordis 4.0.5`、`dsh-tools 0.2.1-rc.2`、`schemastery 3.18.5`
  （运行时仍由宿主提供，`devDependencies` 只为本地跑测试/自检）

### 2. `lib/selftest.mjs`——去掉写死的旧路径

原来硬编码：

```
file:///C:/Users/<用户名>/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js
```

两个毛病：机器专属；而且指向 **0.2.0-rc.2**，DSH 升级后
「用宿主校验器验证输出」这个前提就失效了（校验器已经是另一个版本）。
改为从插件自身解析 `@deepseek-ai/dsh-tools`，并**打印实际使用的版本**，
避免再次悄悄校验了别的副本：

```
ℹ dsh-tools 校验器: v0.2.1-rc.2（应为宿主同版本，DSH 0.2.1-rc.2 = 0.2.1-rc.2）
```

### 3. `lib/jobs.test.mjs`——修一个和数据文件数量绑死的断言

有一条断言写死 `sources.length === 1 + 15`（台账 + 15 个 `run-*.log`）。
但 `extract()` 早就把 `*.ndjson` 也算数据源了，数据目录里后来多了
`applied.ndjson` / `violations.ndjson`，实际变成 18 个，测试就误报失败。

这不是版本适配问题，但会在适配验证时把水搅浑。改成**按目录内容实时推导期望值**，
并把「所有数据文件都被纳入、路径不重复」作为真正的断言。

### 4. 新增 `run-all-tests.mjs`

一个总入口，跑 4 个测试文件 + 自检并汇总；退出码可直接接 CI。
（原来要逐个手跑，容易漏。）

## 验证结果

- **单元测试 161 条全过**：jobs 27 / report 28 / plugin 62 / supervisor 44
- **自检通过**：插件加载成功、注册 **15 个工具**、输出用 DSH 同版本校验器验过
- **在运行中的真实 DSH 0.2.1-rc.2 里逐个实测 15 个工具**：

| 工具 | 实测结果 |
| --- | --- |
| `cdp_status` / `cdp_browser_info` | ✅ |
| `cdp_navigate` | ✅ 自动启动受控 Chrome |
| `cdp_read` / `cdp_eval` / `cdp_screenshot` | ✅ 截图 1858×985 真实 PNG |
| `cdp_new_tab` / `cdp_use_tab` | ✅ |
| `cdp_apply_verified` | ✅ 选择器不存在时**优雅报错**（不崩） |
| `cdp_prefs` | ✅ 返回完整偏好与问卷 |
| `cdp_jobs_report` / `cdp_jobs_data` | ✅ 184 岗位 / 161 投递事件 / 18 数据源 |
| `cdp_runner_status` | ✅ |
| `cdp_runner_reload` | ✅ 启动 gen5 → 规则未变沿用 → 强制滚动 gen6 并让 gen5 退位 |
| `cdp_runner_stop` | ✅ gen6 已停止 |

## 升级指引

如果你是从 0.2.0 升级：

1. 插件本身只需更新到 0.2.1（`dsh plugin --profile desktop update dsh-plugin-cdp`，
   或本地 `link:` 的话直接拉代码）
2. **profile 里的 `@deepseek-ai` 包也要同步到 0.2.1-rc.2**。
   本次排查发现 `C:\Users\<用户名>\.dsh\profiles\node_modules\@deepseek-ai\*`
   仍是 0.2.0-rc.2（2026-10-13 装的），而应用已升到 0.2.1-rc.2（2026-10-17）——
   应用更新不会自动刷新 profile 的依赖树。在 profile 目录执行一次
   `pnpm install` 即可拉齐。**这一步影响所有插件，不只是本插件。**

## 自查命令

```powershell
cd <插件目录>
node run-all-tests.mjs
```
正常应输出：

```
✅ jobs.test.mjs          tests=27 pass=27 fail=0
✅ report.test.mjs        tests=28 pass=28 fail=0
✅ plugin.test.mjs        tests=1 pass=1 fail=0
✅ supervisor.test.mjs    tests=1 pass=1 fail=0
✅ selftest.mjs           注册工具数：15（…）
     ℹ dsh-tools 校验器: v0.2.1-rc.2（应为宿主同版本，DSH 0.2.1-rc.2 = 0.2.1-rc.2）

全部通过
```

---

# 0.2.0（2026-10-13）—— 功能大幅扩展

> 版本：`0.1.0` → 本轮功能大幅扩展
> 日期：2026-10-13
> 适用：DeepSeek Harness（DSH）桌面版 / Web 版
> 插件路径：`<插件目录>`

---

## 一、这个插件是什么

**dsh-plugin-cdp** 是一个 Chrome DevTools Protocol（CDP）自动化插件，为 DSH 提供一套可脚本化的浏览器操作工具，并附带投递数据的可视化与运行器热替换能力。

它之所以存在，是因为**基于浏览器扩展的通道驱动不了部分招聘网站**：

| 问题 | 表现 |
| --- | --- |
| 受控标签页被清空 | Boss直聘会让被控制的标签页变空白 |
| 必须借用用户标签页 | 猎聘在「借标签页」时会变空白 |
| 成功弹窗不可信 | 扩展通道会报告成功对话框，但投递并未真正入账 |

本插件因此**自带一个受控 Chrome 实例**、直接说 CDP 协议，并强制「可验证的投递流程」。

**零运行时依赖**：只用 Node 内置的 `fetch` 与 `WebSocket`（要求 Node ≥ 22）。

---

## 二、本轮的三个核心变化

### 1. 工具从 8 个扩展到 15 个

| 分类 | 工具 |
| --- | --- |
| 原有 CDP 操作（8） | `cdp_status` `cdp_navigate` `cdp_eval` `cdp_read` `cdp_screenshot` `cdp_new_tab` `cdp_use_tab` `cdp_apply_verified` |
| **本轮新增（7）** | `cdp_prefs` `cdp_browser_info` `cdp_jobs_report` `cdp_jobs_data` `cdp_runner_status` `cdp_runner_reload` `cdp_runner_stop` |

### 2. 新增「弹窗收集投递规则」能力

用户不再需要改代码或改配置文件来设定投递规则。首次使用时插件会返回一份问卷，由 DSH 内置的 `ask_user_question` 工具弹出询问，一屏收齐 6 项：

岗位方向 · 工作地点 · 薪资下限 · 投递平台 · 浏览器 · 排除规则

答案落盘到 `<本地目录>\.cdp-prefs.json`，之后不再重复询问。

**关键设计原则：插件不携带任何投递规则。**

- 所有规则字段默认为空（`[]` / `{}` / `""`），不预置任何城市、岗位方向、薪资数字
- 问卷的规则类问题**不生成选项**、不标 `(Recommended)` —— 一旦预置选项，就等于把某个人的规则当成新用户的默认答案
- 插件提供的是**能力**（问得出、存得下、读得回、能热替换），不是内容

### 3. 新增「运行器热替换」能力

用户改规则后，**不需要停掉再重启**投递进程。插件采用 **先起新的、再退旧的**：

```
1. 用户改规则 → 写新快照，规则指纹变化
2. 起新一代进程，与老一代并存
3. 等新一代写出心跳，证明它真的活着
4. 老一代退位，新一代成为唯一在跑
```

**为什么不是「原地重启」**：那必须先杀掉老进程，于是总有一段「没有任何进程在跑」的真空期，投递会断档。

**为什么重叠期是安全的**：两代共享同一份 **append-only** 的 `done.ndjson` / `events.ndjson`。已完成的事两边都读得到（不会重复做），新增记录只是追加（不会互相覆盖）。所以重叠本身就是「不断档」的实现手段。

**失败回滚**：新一代若在 15 秒就绪窗口内没写出心跳，判定启动失败，**保留老一代继续运行** —— 宁可用旧规则继续投，也不在新规则起不来时把投递彻底停掉。

---

## 三、新增工具详解

### `cdp_prefs` —— 投递偏好的读/写

| 参数 | 说明 |
| --- | --- |
| 不传 | 只读：返回当前偏好 + 缺失项 + 建议问卷 |
| `answers` | 把一次 `ask_user_question` 的返回合并落盘 |
| `salaryCities` | 显式限定薪资下限的城市集合（不在列表里的城市会被删除） |
| `reset` | 恢复默认偏好 |

**为什么需要 `salaryCities`**：薪资下限是**按城市合并**的（本次提到的城市覆盖、未提到的保留），这是对的——改一个城市的门槛不该弄丢其他城市。但它意味着「删城市」没有入口，误写入的城市会永久留在配置里。`salaryCities` 就是那个显式的删除入口。

**偏好字段**：`titles` `locations` `salaryFloor` `salaryCeil` `platforms` `browser` `excludeNotes` `notes` `confirmBeforeApply` `confirmedAt`

### `cdp_browser_info` —— 如实报告使用哪个浏览器

返回浏览器名称、可执行文件路径（**是否真的存在于磁盘**）、路径来源、独立用户目录、调试端口、当前是否在运行、以及三个平台的登录态提示。

### `cdp_jobs_report` —— 岗位 / 薪资 / 地点的文本可视化

零依赖的纯文本报告，含 Unicode 条形图、火花线（sparkline）与等宽明细表。

| 参数 | 说明 |
| --- | --- |
| `mode` | `brief`（默认，≤25 行，适合弹窗一眼看完）或 `full`（含明细表） |
| `platform` | 只看某平台：`zhaopin` / `boss` / `liepin`，也接受中文别名 |
| `city` | 只看某城市 |
| `decision` | 只看某判定：`applied` / `pending` / `skipped` / `unknown` |
| `top` | 明细表最多显示多少行 |

**可视化内容**：概览、平台分布、判定构成、薪资直方图（6 个月薪桶 + 独立的「薪资未明」桶，日薪不混入）、地点分布条形图、投递时间线火花线、日志事件构成、岗位明细表、误投与排除原因、解析告警面板。

### `cdp_jobs_data` —— 原始 JSON

返回符合契约的 `DashboardPayload`，供需要自行加工的场景使用。

### `cdp_runner_status` / `cdp_runner_reload` / `cdp_runner_stop`

热替换窗口的三个操作面。

`cdp_runner_status` 会明确报告 **`rulesChangedSinceStart`** —— 即「用户改了规则但还没生效」，并在 `detail` 里给出下一步指引。

`cdp_runner_reload` 的 `runnerCommand` / `runnerArgs` / `runnerCwd` / `runnerTimeoutMs` 由**用户自己指定**，插件不预设任何命令。未配置命令时运行器进入**心跳模式**：只证明运行链路是通的，不执行任何投递动作。

---

## 四、配置项

在 DSH 的插件配置里可覆盖：

```yaml
- id: cdp
  config:
    chromePath: ""                              # 留空则自动探测（或由偏好里的浏览器决定）
    userDataDir: "<本地目录>\\.browser-auto\\profile"
    port: 9222
    windowSize: "1500,950"
    defaultTimeoutMs: 120000                    # 单条 CDP 命令超时
    loadEventMs: 8000                           # 等待 Page.loadEventFired 的上限
    settleMs: 600                               # 导航后额外稳定等待
    prefsPath: "<本地目录>\\.cdp-prefs.json"       # 偏好落盘位置
    stateDir: "<本地目录>\\.cdp-runner"            # 运行器状态目录
    chromePathOverride: ""
```

**文件布局**

```
<插件目录>\lib\
├── contract.mjs          数据契约（DashboardPayload / JobRecord / parseSalary）
├── prefs.mjs             偏好存取、问卷、规则指纹
├── jobs.mjs              台账 + 日志 → 结构化岗位数据
├── logs.mjs              运行日志解析 + 归一工具
├── report.mjs            纯文本可视化渲染
├── supervisor.mjs        进程管理器（热替换）
├── worker.mjs            rule-free 运行器
├── index.mjs             插件主体（15 个工具）
└── *.test.mjs            测试
```

**运行期产物**

```
<本地目录>\.cdp-prefs.json          投递规则
<本地目录>\.cdp-runner\
├── rules.json                  当前规则快照（含规则指纹与代次）
├── status.genN.json            每一代自己的状态（不共用，避免互相覆盖）
├── done.ndjson                 append-only 完成记录
├── events.ndjson               append-only 事件流水
└── worker.log                  运行器日志
```

---

## 五、验证情况

### 测试规模

| 测试 | 断言数 |
| --- | --- |
| `jobs.test.mjs` | 27 |
| `report.test.mjs` | 28 |
| `plugin.test.mjs` | 62 |
| `supervisor.test.mjs` | 44 |
| `selftest.mjs` | 插件加载自检 |
| **合计** | **161** |

全部通过，退出码 0。

### 已实测的能力

- **真实 DSH 内调用**：15 个工具全部可用（含热替换完整流程）
- **热替换**：三代替换全部成功，`worker.log` 留下完整交接记录 —— 新一代先干活，老一代随后自主发现变更并退休，全程无断档
- **状态不丢**：`events.ndjson` 累积三代事件一条未丢（如 `gen1: 173 / gen2: 100 / gen3: 6 条`）
- **投递真实站点**：`cdp_navigate` 打开智联招聘成功
- **纯文本报告**：真实数据 81 岗位 / 537 事件 / 79 告警
  - 完整报告 217 行、最宽 108 字符
  - 表格对齐已程序化校验：全文 5 张表、113 行含竖线的行，**同一张表内所有行的竖线列位完全一致 → 错位 0 行**（按显示宽度计算，含中英文混排）

### 自检覆盖的三类「只有宿主才会拒绝」的错误

这三类错误本地跑 `execute()` 完全测不出，只有真实 DSH 会拒绝。现已全部变成自检断言：

1. **`output.schema` 漏声明字段** —— 返回对象里的字段必须在 `schema.properties` 中声明（`additionalProperties: false`）
2. **无损 JSON** —— 返回值里不能有 `undefined`，它不是合法 JSON 值
3. **输出必须通过 `validateJsonSchemaValue` 校验**

---

## 六、已知限制（如实说明）

1. **地点覆盖率 59.3%**（48/81 有地点，33 条为「地点未明」）。运行日志只有「岗位名 + 薪资」，没有城市；地点只存在于岗位列表卡片上。
   - **已修**：投递脚本改为每投一条追加一行结构化 JSON（`applied.ndjson`），数据管线已支持读取
   - **但只对新投递生效** —— 历史数据的落盘时机已过，地点补不回来
2. **猎聘记录暂无地点** —— `lp-two.js` 目前不返回地点字段
3. **智联历史投递有 4 条无精确时间** —— 台账里写的是「第3轮」这类轮次标签。数据层**拒绝编造日期**，标记为 `appliedAt=null` 并逐行告警
4. **`appliedCount` 在按城市/判定筛选时不变** —— 投递事件只有平台字段，无 city/decision，因此这两类筛选只作用于岗位列表。报告里已自动加注说明
5. **运行器默认是心跳模式** —— 未配置 `runnerCommand` 时不执行任何投递动作，这是有意为之：先证明链路通，再接入用户自己的脚本
6. **`example.com` 在当前网络不可达**，但招聘站点正常 —— 这是网络环境策略，不是插件问题

---

## 七、使用步骤

### 1. 重载 DSH

插件通过 `link:` 方式挂载，源码改动**磁盘上立即生效，但运行中的 DSH 需要重载**才会加载新代码。

> 已实测：未重载前调用新工具会报 `unknown tool`。

### 2. 首次使用：让它问你规则

调用 `cdp_prefs`（不传参数）。若返回 `needsAsk: true`，把返回的 `suggestedQuestions` 原样交给 `ask_user_question` 弹窗询问，拿到答案后用 `cdp_prefs` 的 `answers` 参数存回。

### 3. 确认浏览器

调用 `cdp_browser_info` 确认浏览器路径存在、独立用户目录正确。注意这是**独立实例**，需要单独登录一次三个平台。

### 4. 看数据

调用 `cdp_jobs_report`（`mode: brief` 或 `full`）看岗位/薪资/地点分布。

### 5. 起运行器

调用 `cdp_runner_reload`。先用默认的心跳模式确认链路通，再通过 `runnerCommand` 接入你自己的执行命令。

之后规则随时可以改：改完再调用 `cdp_runner_reload` 即可热替换，不用停投。

---

## 八、本轮修复过的缺陷（供参考）

以下问题都是**在真实 DSH 里手工使用才暴露**的，本地测试全绿：

| # | 缺陷 | 性质 |
| --- | --- | --- |
| 1 | `cdp_runner_status` 的 `output.schema` 漏声明 3 个字段 | 宿主拒绝输出 |
| 2 | `cdp_runner_reload` 返回 `undefined`，非无损 JSON | 序列化失败 |
| 3 | 偏好**只能加不能删**（清不掉已填规则） | 操作不可逆 |
| 4 | `cdp_prefs` 返回值缺 `excludeNotes` | 用户看不到自己的配置 |
| 5 | 薪资下限正则只认纯中文城市名 | 中英混合城市名解析失败 |
| 6 | 误写入的城市清不掉（缺删除入口） | 操作不可逆 |
| 7 | 反复 reload 会丢失快照里的代次 | 状态错配 |

**规律**：这些缺陷都长在**契约边界**上 —— schema 与返回值的对应、宿主对序列化的要求、「操作是否可逆」这类语义。它们不体现在任何单个函数的输入输出里，只有把工具当成用户会用的东西去用才会露出来。

已把能自动化的部分都变成断言，但**「换个角度手工用一遍」目前无法自动化**，建议每次改动契约字段后都手工走一遍。

---

## 九、协议与许可

- 私有插件（`"private": true`），未发布到 npm
- 零运行时依赖
- 对等依赖：`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`

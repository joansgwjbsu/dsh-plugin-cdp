# dsh-plugin-cdp

> DeepSeek Harness 插件：用 CDP 驱动一个受控 Chrome 实例，附带「弹窗收集规则 + 文本可视化 + 无停机热替换」能力。

[English](#english) | 中文

---

## 它解决什么问题

基于**浏览器扩展**的自动化通道驱动不了部分网站：

| 问题 | 表现 |
| --- | --- |
| 受控标签页被清空 | 目标站点会让被控制的标签页变空白 |
| 必须借用用户标签页 | 借来的标签页同样会变空白 |
| 成功弹窗不可信 | 页面报告了成功对话框，但操作并未真正生效 |

本插件因此**自带一个受控 Chrome 实例**、直接说 CDP 协议，并强制「可验证的操作流程」。

**零运行时依赖** —— 只用 Node 内置的 `fetch` 与 `WebSocket`（要求 Node ≥ 22）。

---

## 兼容性

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | **`>=0.2.0-rc.2 <0.3.0-0`**（即 `engines.dsh`，由 DSH 的兼容性判定直接校验）；**已验证 0.2.1-rc.2** |
| `@deepseek-ai/dsh-tools` | `^0.1.5-rc.3 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.2`（peer，由宿主提供） |
| `@deepseek-ai/schemastery` | `^3.18.2`（peer，由宿主提供） |
| `@deepseek-ai/cordis` | `^4.0.2`（peer，由宿主提供） |
| Node | ≥ 22（宿主自带 Node 24，无需另装） |

> **`engines.dsh` 是 DSH 真正会校验的字段。** DSH 的 `evaluatePluginCompatibility()`
> 在插件安装/启动时读取它；一旦声明，它**单独决定**兼容性（`peerDependencies` 不再参与判定）。
> 本插件声明 `>=0.2.0-rc.2 <0.3.0-0`：覆盖已验证的 0.2.x，并用 `<0.3.0-0`
> 挡住 0.3 的预发布版本（`<0.3.0` 在 `includePrerelease` 下会误放行 `0.3.0-rc.1`）。

> **注意**：DSH 升级后，请确认 profile 里的 `@deepseek-ai` 包也已拉齐到同版本。
> 应用更新**不会**自动刷新 profile 的依赖树。详见 [UPDATES.md](./UPDATES.md)。

各版本的封装产物、SHA256 与「该用哪个版本」见 **[RELEASES.md](./RELEASES.md)**。

自查一条命令（在**仓库目录**执行；单元测试文件不随 npm 包分发）：

```sh
node run-all-tests.mjs
```

---

## 安装

```sh
npm i dsh-plugin-cdp
```

或在 DSH 的插件配置里加入：

```yaml
- id: cdp
  name: "dsh-plugin-cdp"
  config:
    port: 9222
```

---

## 三个核心能力

### 1. 弹窗收集规则，插件本身不携带任何规则

首次使用时插件返回一份问卷，由 DSH 内置的 `ask_user_question` 弹窗询问，一屏收齐：

**岗位方向 · 工作地点 · 薪资下限 · 投递平台 · 浏览器 · 排除规则**

答案落盘后不再重复询问。

**设计红线**：所有规则字段默认为空，问卷的规则类问题**不生成选项**、不标 `(Recommended)`。一旦预置选项，就等于把某个人的规则当成新用户的默认答案。插件提供的是**能力**，不是**内容**。

### 2. 纯文本可视化，零依赖

不依赖浏览器、不依赖图表库，用 Unicode 字符画图：

```
── 薪资分布（月薪 · 按 salaryMin 分桶，n=80；日薪 1 单未计入） ───
  <7k      │████░░░░░░░░░░░░░│  7
  7-9k     │██████████░░░░░░░│ 19
  9-12k    │█████████████████│ 34
  12-15k   │██████░░░░░░░░░░░│ 12
  ≥20k     │█░░░░░░░░░░░░░░░░│  2
  薪资未明 │█░░░░░░░░░░░░░░░░│  2
── 投递时间线 ──────────────────────────
  ▂▁▁▁█  （5 天，49 单）  峰值 44 单
```

含薪资直方图、地点条形图、平台占比、判定构成、投递火花线、等宽明细表。中文按双宽计算，表格列不会错位。

### 3. 运行器热替换：改规则不用停

采用 **先起新的、再退旧的**，而不是原地重启：

```
1. 用户改规则 → 写新快照，规则指纹变化
2. 起新一代进程，与老一代并存
3. 等新一代写出心跳，证明它真的活着
4. 老一代退位
```

**为什么不是原地重启**：那必须先杀掉老进程，于是总有一段「没有任何进程在跑」的真空期。

**为什么重叠期安全**：两代共享同一份 **append-only** 的完成记录。已完成的事两边都读得到（不会重复做），新增记录只是追加（不会互相覆盖）。重叠本身就是「不断档」的实现手段。

**失败回滚**：新一代若在就绪窗口内没写出心跳，**保留老一代继续运行**，绝不在新规则起不来时把任务停掉。

---

## 工具一览（15 个）

| 工具 | 作用 |
| --- | --- |
| `cdp_status` | 受控 Chrome 的状态、端口、标签页 |
| `cdp_navigate` | 导航并等待加载 |
| `cdp_eval` | 在标签页里执行 JS 并返回 JSON |
| `cdp_read` | 读取标签页 URL / 标题 / 可见文本 |
| `cdp_screenshot` | 截图到本地文件 |
| `cdp_new_tab` / `cdp_use_tab` | 新建 / 切换受控标签页 |
| `cdp_apply_verified` | **带校验的操作**：等详情面板稳定且薪资与卡片一致才点击，且拒绝重复操作 |
| `cdp_prefs` | 读取 / 写入偏好（含弹窗问卷） |
| `cdp_browser_info` | 如实报告使用的浏览器与可执行文件是否存在 |
| `cdp_jobs_report` | 岗位 / 薪资 / 地点文本可视化报告 |
| `cdp_jobs_data` | 原始 JSON |
| `cdp_runner_status` | 运行器状态，含「规则改了但还没生效」提示 |
| `cdp_runner_reload` | 同步规则并热替换 |
| `cdp_runner_stop` | 停止运行器 |

---

## `cdp_apply_verified` 为什么存在

一次「点错岗位」的操作长这样：点击列表卡片 → 右侧详情面板其实还没切换 → 此时点「申请」→ **申请到了上一个岗位**。

这个工具强制三道闸门：

1. 等详情面板标题**连续 3 次读数稳定**
2. 面板薪资必须与卡片薪资**逐字相同**
3. 按钮文案若已是「继续沟通 / 已投递」则**直接拒绝**

任何一条不过就返回 `ok: false` 并说明原因，绝不「看起来成功」。

> ⚠️ 成功对话框**不等于**操作已记录。请始终到站点自己的记录页复核。

---

## 配置

```yaml
- id: cdp
  config:
    chromePath: ""                              # 留空则自动探测
    userDataDir: "你的独立浏览器目录"
    port: 9222
    windowSize: "1500,950"
    defaultTimeoutMs: 120000                    # 单条 CDP 命令超时
    loadEventMs: 8000                           # 等待页面加载事件的上限
    settleMs: 600                               # 导航后额外稳定等待
    prefsPath: "偏好落盘路径"
    stateDir: "运行器状态目录"
```

> **注意**：受控实例使用**独立的用户目录**，不复用你日常浏览器的配置，因此需要在该实例里单独登录一次目标站点。

---

## 开发与测试

```sh
node --test lib/jobs.test.mjs          # 27 项
node --test lib/report.test.mjs        # 28 项
node lib/plugin.test.mjs               # 62 项
node lib/supervisor.test.mjs           # 44 项
node lib/selftest.mjs                  # 插件加载自检
```

自检覆盖三类**只有宿主才会拒绝**的错误，本地跑 `execute()` 是测不出来的：

1. `output.schema` 漏声明返回字段
2. 返回值含 `undefined`（不是合法 JSON）
3. 输出未通过 `validateJsonSchemaValue`

---

## 已知限制

1. **输出字段必须与 `output.schema` 逐一对应** —— `additionalProperties: false`，多一个字段就会在宿主里被拒
2. **运行器默认是心跳模式** —— 未配置命令时不执行任何实际操作，这是有意为之：先证明链路通
3. **热替换依赖 append-only 状态** —— 若把共享状态改成「整份重写」，重叠期就会互相丢更新，那时「先起后杀」不再安全
4. **受控浏览器需要单独登录** —— 独立用户目录意味着不复用日常登录态

---

## License

MIT

---

<a id="english"></a>

## English

A DeepSeek Harness plugin providing Chrome DevTools Protocol automation with a **self-managed Chrome instance**, plus:

- **Popup-driven rule collection** — the plugin ships **no rules**; it asks the user once via DSH's built-in `ask_user_question` and stores the answers.
- **Zero-dependency text dashboards** — Unicode bar charts, sparklines and monospace tables for job / salary / location data (CJK double-width aware, so columns never misalign).
- **Zero-downtime hot-swap** — when rules change, a new worker generation starts and proves it is alive **before** the old one retires. The two generations share **append-only** state, so overlap is safe and there is no gap with nothing running. If the new generation fails to start, the old one is kept.

15 tools total. Zero runtime dependencies (Node ≥ 22 built-in `fetch` + `WebSocket`).

> ⚠️ A success dialog does **not** prove an action was recorded. Always verify on the site's own record page.

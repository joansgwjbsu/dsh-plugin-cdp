# liepin-runner

猎聘「扩展通道」批量投递运行器（PowerShell 5.1）。

通过 **BrowserSkill 扩展**驱动你自己的 Chrome，不另开受控 profile。适合这类站点：
它们会在被 CDP 驱动后让受控标签页变空白，但在用户自己登录的窗口里操作是正常的。

## 工作方式

每个岗位 **一次 `bsk evaluate` 跑完全流程**：判定 → 聊一聊 → 发简历 → 立即投递。
原因：猎聘岗位页在被脚本驱动后约 30 秒会自毁，分多步操作来不及。

其它行为：

- **账号体检**：开跑前先确认账号可用（未登录 / 验证码 / 限流 / 封禁），不通过就不启动。
- **封禁信号监控**：逐岗位检测验证码、限流、「访问受限」等文案，命中立即停止本场。
- **daemon 自愈**：每个候选之前轻量探一次 `bsk status`，掉了就拉起并重建会话。
- **只关自己的标签**：结束时清理 `scope=agent` 的残留标签，用户 `scope=user` 的标签一个都不碰。
- **投递间隔 60–180 秒**：实测 3 条/分钟的节奏会触发验证码，温和模式不会。

## 前置条件

1. `bsk` CLI（BrowserSkill）在 PATH 里，daemon 可用
2. 装有 BrowserSkill 扩展、且已登录目标站点的 Chrome
3. `settings.json` 指向的数据目录里存在下列文件

## 配置

复制 `settings.example.json` 为 `settings.json`，改 `dataRoot` 指向你的数据目录。

| 字段 | 作用 |
| --- | --- |
| `dataRoot` | 数据根目录；`paths` 里的相对路径都相对它解析 |
| `browserSkill.autoStart` | 对应环境变量 `BSK_AUTO_START` |
| `paths.*` | 所有输入/输出文件；可写绝对路径覆盖 |
| `behavior.default*` | 时间窗、加载等待、条间间隔的默认值（命令行参数优先） |
| `behavior.closeAgentLiepinAndBlankTabsOnExit` | 结束时是否清理 agent 残留标签 |

## 需要的伴随文件

本目录**只发布驱动循环本身**。下面这些是调用方自己的「策略层」，未包含在仓库里，
因为它们通常含有个人化的城市/薪资规则与公司名单：

| 文件 | 提供什么 |
| --- | --- |
| `runner-lib.ps1` | `Invoke-Bsk`、`Test-BskDaemon`、`Ensure-BskDaemon`、`Get-PlatformConfig`、`Get-CityRuleMap` |
| `blocked-companies.ps1` | `Get-BlockedCompanyNames` |
| `lp-ext-one.js` | 页面内的判定与投递流程（一次求值跑完） |
| `lp-account-check.js` | 账号体检脚本 |

## `Invoke-Bsk` 为什么必须存在

PowerShell 5.1 把变量当原生参数传给 `bsk.exe` 时不转义字符串里的双引号，
含引号的 JS 会被空格切碎，bsk 报 `invalid_params: unexpected argument`。
调用方如果 `catch` 掉再当成「没取到结果」，就会变成**静默放行**。

正确做法是按 CRT 规则自己拼命令行：整体加双引号、内部 `"` 转成 `\"`、末尾反斜杠加倍。

## 用法

```powershell
# 只做就绪检查与预览，不投递
.\run-liepin.ps1 -DryRun

# 投到 15:30
.\run-liepin.ps1 -EndHour 15 -EndMin 30

# 本次最多 6 条
.\run-liepin.ps1 -Max 6
```

退出码：`0` 正常收工（含「无事可做」「已过窗口」），`1` 前置条件不满足。

## 日志与产出

- `paths.log`：逐条流水（成功/跳过/失败/封禁信号）
- `paths.health`：本次运行的 JSON 汇总（尝试/成功/跳过/失败/停止原因/daemon 重建次数）
- `paths.applied`：结构化投递记录（追加写）
- `paths.done`：已处理队列 id

**注意**：脚本自报的「成功」只代表页面回执出现成功信号，**不等于平台侧真的落库**。
落库必须另外到站点自己的记录页逐条比对。

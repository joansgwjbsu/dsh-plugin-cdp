# platform-guard — 通用「账号异常 → 暂停」弹窗

一个 Windows 桌面弹窗，用于自动化流程遇到**账号被限/被封/需要验证**时，立即停下来并让人决定停多久。

典型场景：批量提交类脚本跑到一半被平台风控，继续跑只会加重风险，但脚本自己不知道该停多久——交给人在弹窗上选。

## 文件

| 文件 | 作用 |
| --- | --- |
| `platform-guard.ps1` | 主弹窗。显示异常原因、5 个常用时长、自定义小时数，倒计时兜底 |
| `set-dialog-color.ps1` | 配色选择器。三套内置模板 + 自定义主色 + 系统取色盘 |
| `dialog-theme-presets.json` | 三套配色模板（靛蓝 / 青绿 / 石墨蓝）的完整色值 |

## 用法

```powershell
# 弹窗（异常时调用）
./platform-guard.ps1 -Platform boss -Reason "403 访问被拒绝（账号受限/封禁）"

# 无人值守：不弹窗，直接按默认时长暂停
./platform-guard.ps1 -Platform boss -Reason "..." -NoPrompt -DefaultHours 24
```

用户在弹窗上选完后，会写入 `platform-pause.json`：

```json
{
  "boss": {
    "until": "2026-11-10T15:22:32",
    "hours": 48,
    "reason": "403 访问被拒绝（账号受限/封禁）",
    "setAt": "2026-11-09T15:22:32",
    "decidedBy": "用户选择停 48 小时"
  }
}
```

调用方在每次启动自动化流程前读这个文件、比较 `until` 与当前时间即可实现「暂停期内不跑、到期自动恢复」。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Platform` | 必填 | 平台标识，会显示在标题里，也是 `platform-pause.json` 的键 |
| `-Reason` | `账号异常` | 异常原因，红色显示 |
| `-DefaultHours` | `24` | 弹窗超时/无人值守时的默认暂停时长（支持小数） |
| `-TimeoutSec` | `120` | 弹窗自动关闭秒数 |
| `-AccentColor` | 空 | 临时覆盖主色（`#RRGGBB`），不写盘 |
| `-NoPrompt` | 关 | 不弹窗，直接按默认时长写文件 |
| `-PauseFile` | 脚本同目录 `platform-pause.json` | 暂停记录路径 |
| `-ThemeFile` | 脚本同目录 `platform-guard-theme.json` | 当前配色选择 |
| `-PresetsFile` | 脚本同目录 `dialog-theme-presets.json` | 配色模板定义 |

三个路径参数默认都落在脚本同目录，调用方可以指向自己的数据目录，因此这个组件本身不带任何本机路径。

## 弹窗上能选什么

| 选项 | 结果 |
| --- | --- |
| 停 2 小时 | `hours: 2` |
| 停到今天结束 | `hours: 0`，`until` 为次日零点 |
| 停 1 天 / 停 2 天 | `hours: 24` / `48` |
| 不暂停 | 清除该条记录 |
| 自定义 N 小时 | `0.5 ~ 720`，支持小数 |
| 右上角 X | 等同于不暂停，`decidedBy` 记「用户关闭弹窗」 |
| 倒计时结束 | 按 `DefaultHours` 处理，`decidedBy` 记「弹窗超时默认」 |

弹窗**无操作超时也会落一个保守决策**，所以无人值守时不会卡住流程。

## 配色

三套内置模板：

| 预设 | 名称 | 主色 |
| --- | --- | --- |
| `indigo` | 靛蓝可信 | `#4E63C2` |
| `teal` | 青绿清爽 | `#12838D` |
| `slate` | 石墨蓝专业 | `#355478`（默认） |

```powershell
./set-dialog-color.ps1                  # 交互式：三张模板卡片 + 自定义
./set-dialog-color.ps1 -List            # 列出模板
./set-dialog-color.ps1 -Preset teal     # 直接切
./set-dialog-color.ps1 -Color 7E57C2    # 自定义主色（深浅自动派生）
./set-dialog-color.ps1 -Reset           # 回默认模板
```

也可以直接在弹窗里点右下角「更换配色」入口，选完会按剩余时间重新打开弹窗，倒计时不清零。

模板文件存的是**完整色值**（主色、标题渐变起止、选中态底色与描边），不是靠算法派生，所以每套的还原度是准的；只有自定义主色时才走派生。

## 依赖

Windows + Windows PowerShell 5.1（用到 `System.Windows.Forms` / `System.Drawing`）。无需额外模块。

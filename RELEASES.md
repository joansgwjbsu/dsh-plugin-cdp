# 版本与封装产物

本文件记录**每个已发布版本**的封装产物、DSH 兼容范围与校验值，供回退或按 DSH 版本选择插件时使用。

> ⚠️ 仓库里开发中的版本号不代表已发布。当前 `package.json` 是 `0.3.0`（新增简历 × JD 匹配，
> 并于 2026-10-25 **适配 DSH 0.2.1-rc.3**），**尚未打 tag / 打包发布**；
> 下表三个是它之前的已发布产物。

> 说明：本文件是**仓库级文档**，不随 npm tarball 分发（`package.json` 的 `files` 未包含它）。
> 各版本的 tarball 由 `npm pack` 从对应 git tag 构建，哈希如下。

---

## 版本矩阵

| 版本 | DSH 兼容范围 | 产物大小 | 产物 SHA256 |
| --- | --- | --- | --- |
| **v0.2.2**（当前） | `>=0.2.0-rc.2 <0.3.0-0`（`engines.dsh`，DSH 直接校验） | 84,072 字节 | `FF36C7D5634B38CF9E2626CC26E6F3A4F90AA17EB3F0D45782F1EC896B60899A` |
| v0.2.1（上一版） | 同上（由 peer 推断，未声明 `engines.dsh`） | 82,416 字节 | `2A34C797C3092789919A68355EBD6736413109BAD1E155DE5C521532242EC24C` |
| v0.2.0（初版） | DSH `0.2.0-rc.2` 时期产物 | 79,471 字节 | `C73BE7537011034F62A219A7EE7C0E9EBF4F9F2E8BF45D5AEEDC903DABDA2615` |

对应 git tag 与提交：

| 版本 | tag | 提交 |
| --- | --- | --- |
| v0.2.2 | `v0.2.2` | `25d6875` |
| v0.2.1 | `v0.2.1` | `645f1cb` |
| v0.2.0 | `v0.2.0` | `2748d7b` |

---

## 下载

> ⚠️ 2026-10-25：因历史产物里带作者邮箱等个人信息，已**删除全部历史 Release 与 tag**（含 tgz）。
> 下面的固定版本链接不再可用；需要旧版本请按上表的提交号自行 checkout 并 `npm pack`。
> 当前推荐直接从仓库安装（见 README 的「安装」一节）。

```text
# 已删除（2026-10-25 隐私清理）
# https://github.com/joansgwjbsu/dsh-plugin-cdp/releases/download/v0.2.2/dsh-plugin-cdp-0.2.2.tgz
# https://github.com/joansgwjbsu/dsh-plugin-cdp/releases/download/v0.2.1/dsh-plugin-cdp-0.2.1.tgz
# https://github.com/joansgwjbsu/dsh-plugin-cdp/releases/download/v0.2.0/dsh-plugin-cdp-0.2.0.tgz
```

---

## 安装后校验

自行打包后应校验哈希（Windows PowerShell）：

```powershell
Get-FileHash .\dsh-plugin-cdp-0.3.0.tgz -Algorithm SHA256
```

也可直接解包确认清单里的版本与兼容声明：

```powershell
tar -xzf .\dsh-plugin-cdp-0.2.2.tgz -C $env:TEMP
Get-Content "$env:TEMP\package\package.json" | Select-String 'version|engines|dsh-tools'
```

---

## 如何选择版本

- **DSH ≥ 0.2.0-rc.2**：用 **v0.2.2**（首次声明 `engines.dsh`，DSH 的兼容性判定可直接识别）。
  它在 `0.2.1-rc.2` / `0.2.1-rc.3` 上都仍然可用 —— 这两个运行时之间，
  插件面向的 API 面（`defineTool` / `Schema` / `ctx.tools`）逐字节未变（证据见 [UPDATES.md](./UPDATES.md)）。
- **需要与 v0.2.1 行为完全一致**（例如排查回归）：可回退到 **v0.2.1**。
  v0.2.1 与 v0.2.2 的**插件代码完全相同**，差异只在 `package.json`
  的版本号与 `engines.dsh` 声明——所以功能上可互换。
- **v0.2.0**：为 DSH `0.2.0-rc.2` 时期的产物，`peerDependencies` 未包含
  `^0.2.1-rc.2`；在 0.2.1 上用 `pnpm add` 安装会被判为不满足。仅在复现旧环境时使用。

---

## 各版本改了什么

| 版本 | 变更 |
| --- | --- |
| v0.2.2 | 声明 `engines.dsh`（DSH 真正校验的字段）；自检改用 DSH 官方 `evaluatePluginCompatibility` 并加反向对照 |
| v0.2.1 | 修 peer 预发布范围（`^0.2.0-rc.1` 不匹配 `0.2.1-rc.2`）；本地依赖对齐宿主；修 selftest 写死的旧路径；修一条与数据文件数量绑死的测试 |
| v0.2.0 | 15 个工具、弹窗规则收集、文本可视化、运行器热替换 |

详细说明见 [UPDATES.md](./UPDATES.md)。

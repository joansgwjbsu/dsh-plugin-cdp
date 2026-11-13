# lp-ext-run.ps1 — 猎聘「扩展通道」批量投递运行器。
#
# 与 run-platform.ps1 的猎聘分支（CDP 通道）并列，由 platforms.json 的
# liepin.channel = "extension" 选择。核心差异：
#   · 走用户自己登录的 Chrome（BrowserSkill 扩展），不开受控 profile；
#   · 每个岗位一次 evaluate 跑完「判定 → 聊一聊 → 发简历 → 立即投递」，
#     因为猎聘岗位页被驱动后约 30 秒会自毁（详见 lp-ext-one.js 头部注释）；
#   · 全程监控封禁信号，一旦出现验证码/频繁/受限等提示立即停投并记录。
#
# 前置条件（runner 会自己检查）：
#   1) bsk daemon 在跑        —— 用 `bsk daemon start --foreground` 常驻
#   2) Chrome 已连上扩展      —— daemon 重启后扩展不会自己重连，需要重启一次 Chrome
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-liepin.ps1
#   ... -EndHour 11 -EndMin 30      # 时间窗（默认上午场）
#   ... -Max 6                      # 本次最多投几条（不传=队列长度）
#   ... -DryRun                     # 只做就绪检查与规则预览，不投递
param(
  [int]$EndHour = -1,
  [int]$EndMin = -1,
  [int]$Max = 0,
  [switch]$DryRun,
  [int]$LoadWaitSec = -1,
  [int]$GapMin = -1,
  [int]$GapMax = -1
)
# 配置是此规范副本唯一的可调变量入口；不修改原目录的源脚本或用户数据。
$ErrorActionPreference = 'Continue'
$script:ConfigPath = Join-Path $PSScriptRoot 'settings.json'
if (-not (Test-Path -LiteralPath $script:ConfigPath)) { throw "缺少配置文件：$script:ConfigPath" }
$script:Config = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($EndHour -lt 0) { $EndHour = [int]$script:Config.behavior.defaultEndHour }
if ($EndMin -lt 0) { $EndMin = [int]$script:Config.behavior.defaultEndMinute }
if ($LoadWaitSec -lt 0) { $LoadWaitSec = [int]$script:Config.behavior.defaultLoadWaitSeconds }
if ($GapMin -lt 0) { $GapMin = [int]$script:Config.behavior.defaultGapMinSeconds }
if ($GapMax -lt 0) { $GapMax = [int]$script:Config.behavior.defaultGapMaxSeconds }
if ($GapMin -gt $GapMax) { throw "GapMin($GapMin) 不得大于 GapMax($GapMax)" }
$script:DataRoot = [System.IO.Path]::GetFullPath([string]$script:Config.dataRoot)
if (-not (Test-Path -LiteralPath $script:DataRoot -PathType Container)) { throw "数据目录不存在：$script:DataRoot" }
function Resolve-DataPath([string]$key) {
  $relative = [string]$script:Config.paths.$key
  if ([System.IO.Path]::IsPathRooted($relative)) { return [System.IO.Path]::GetFullPath($relative) }
  return [System.IO.Path]::GetFullPath((Join-Path $script:DataRoot $relative))
}
$env:BSK_AUTO_START = if ([bool]$script:Config.browserSkill.autoStart) { '1' } else { '0' }
Set-Location $script:DataRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
. (Resolve-DataPath 'runnerLibrary')
. (Resolve-DataPath 'blockedCompaniesLibrary')

$logPath = Resolve-DataPath 'log'
$healthPath = Resolve-DataPath 'health'
$queueFile = Resolve-DataPath 'queue'
$doneFile = Resolve-DataPath 'done'
$companyFile = Resolve-DataPath 'companyDay'
$appliedPath = Resolve-DataPath 'applied'

function Log($m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  # 2026-11-10：这里必须 Write-Host 而不是 Write-Output。
  # 教训：Log 是给函数内部用的，Write-Output 会把它混进函数的返回值 —— 实测
  #   $session = Start-LpSession ... 拿到的是 Object[]（[日志行, "dswx"]），
  #   于是后面 `bsk tab create --session $session` 全废、`session stop` 静默失败，
  #   还残留了一个会话。Write-Host 只进控制台，不参与管道，返回值就干净了。
  Write-Host $line
  [System.IO.File]::AppendAllText($logPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

# 2026-11-09：人工暂停守卫（与 run-platform.ps1 同口径）。体检发现异常时由
# platform-guard.ps1 弹窗写入 platform-pause.json；暂停期内猎聘同样不启动。
$pauseFile = (Resolve-DataPath 'pause')
if (Test-Path $pauseFile) {
  try {
    $pf = Get-Content $pauseFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $pe = $pf.liepin
    if ($pe -and $pe.until) {
      $pauseUntil = [datetime]$pe.until
      if ((Get-Date) -lt $pauseUntil) {
        Log "!! 猎聘处于人工暂停期（至 $($pe.until)，原因：$($pe.reason)），本场跳过"
        Log '=== 收工：暂停期内，未投递 ==='
        exit 0
      }
      Log "  猎聘暂停期已过（$($pe.until)），恢复正常投递"
    }
  } catch { Log "  !! 读取暂停记录失败（$($_.Exception.Message)），按未暂停处理" }
}

# 同一时间只允许一个扩展运行器接管 BrowserSkill/Chrome，避免重启 daemon 或 Chrome 时打断另一场。
$script:RunMutex = $null
$script:OwnsRunMutex = $false
try {
  $script:RunMutex = [System.Threading.Mutex]::new($false, 'Local\DshLiepinExtensionRunner')
  try { $script:OwnsRunMutex = $script:RunMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $script:OwnsRunMutex = $true; Log '回收已异常退出的猎聘扩展运行锁' }
} catch {
  Log "!! 无法获取猎聘扩展运行锁：$($_.Exception.Message)"
  exit 1
}
if (-not $script:OwnsRunMutex) {
  Log '已有猎聘扩展运行器占用 BrowserSkill，本次不启动，队列保持不变'
  try { $script:RunMutex.Dispose() } catch {}
  exit 0
}
function Release-LiepinRunLock {
  if ($script:OwnsRunMutex -and $script:RunMutex) {
    try { $script:RunMutex.ReleaseMutex() } catch {}
    $script:OwnsRunMutex = $false
  }
  if ($script:RunMutex) { try { $script:RunMutex.Dispose() } catch {}; $script:RunMutex = $null }
}

# ---------- 就绪检查（带自愈） ----------
# 2026-11-02：清晨无人值守时，daemon 或扩展连接很可能不在状态，所以这里先尝试拉起，
# 再判定失败。已知规律：daemon 重启后 MV3 service worker 多数情况 2-4 秒会自己连上
# （daemon 日志里能看到 browser connected），偶尔需要人来重启一次 Chrome。
#
# 2026-11-10：拉起逻辑统一收进 runner-lib.ps1 的 Ensure-BskDaemon。原来那段
#   Start-Process -WindowStyle Hidden powershell + 固定 60 秒轮询有两个要命的问题：
#   · 拉起后没有真正用 `bsk status --json` 确认，起没起来照样往下跑，
#     最终打出「!! bsk daemon 仍不可用，放弃本次投递」——看起来试过了，其实没成；
#   · 只在开场看一眼。跑到一半 daemon 空闲自退（600 秒没有 bsk 调用就退）没人管，
#     15:07:48 之后日志再无输出，静默卡死到人工 kill，白丢 17 分钟。
# 现在：拉起用「cmd start /b 脱离父进程 + --daemon-idle 12h」（顺手掐掉空闲自退这个
# 根因），拉起后必须实测确认；并且每个候选之间再检查一次（见循环里），
# 掉了就拉起 + 重建会话，不让整场就此结束。
$daemonLog = { param($m) Log $m }

function Test-Ready {
  $p = Test-BskDaemon
  if ($p.Alive) { return $p.Status }
  return $null
}

Log '检查 bsk daemon（不在就用 cmd start /b 脱离父进程拉起，并实测确认）…'
if (-not (Ensure-BskDaemon -Log $daemonLog)) {
  Log '!! bsk daemon 不可用（Ensure-BskDaemon 已实测拉起失败），放弃本次投递'
  Log '=== 收工：前置条件不满足，未投递 ==='
  Release-LiepinRunLock
  exit 1
}
$st = Test-Ready

if ($st -and $st.daemon_version -and (-not $st.browsers -or $st.browsers.Count -eq 0)) {
  # 2026-11-06 修：原版在这里 taskkill 掉所有非受控 profile 的 chrome.exe 再重开一个。
  # 人可能正在用那些窗口，自动关掉的代价太大（11-06 14:00 就关过一次）。
  # 现在改成：只等一小会儿看扩展是否自己连上；连不上就明确报错退出，由人来决定怎么处理。
  Log 'daemon 在跑但没有浏览器连扩展。不再自动重启 Chrome（那会关掉你正在用的浏览器）；等待扩展自行重连…'
  for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 2
    $st = Test-Ready
    if ($st -and $st.browsers -and $st.browsers.Count -gt 0) { Log '  扩展已自行连上'; break }
  }
  if (-not $st -or -not $st.browsers -or $st.browsers.Count -eq 0) {
    Log '  仍未连上：请在装有 BrowserSkill 扩展的 Chrome 里打开该扩展（或重启该 Chrome），然后重跑本脚本'
  }
}

$ready = $true
# 选浏览器：settings.json 的 browserSkill.instanceId 优先。
# 2026-11-13：受控 Chrome 也装了 BrowserSkill 扩展（instance 38985223 / ext 0.5.0），
# 于是可能同时有「用户自己的 Chrome」和「受控 Chrome」连着 daemon。
# 原来取 browsers[0]，谁排前面用谁 —— 会出现「以为在受控 profile 里跑，其实在你窗口里」的错位。
# 钉死实例后，指定实例没连上就明确失败，不静默改用别的浏览器。
function Select-BskBrowser($browsers) {
  $list = @($browsers)
  if ($list.Count -eq 0) { return $null }
  $want = [string]$script:Config.browserSkill.instanceId
  if ($want) {
    $hit = $list | Where-Object { "$($_.instance_id)" -eq $want } | Select-Object -First 1
    if ($hit) { return $hit }
    Log "  !! 配置钉死实例 $want，但它没有连上；当前连接：$(($list | ForEach-Object { $_.instance_id }) -join ', ')"
    return $null
  }
  return $list[0]
}

if (-not $st -or -not $st.daemon_version) {
  Log '!! bsk daemon 仍不可用，放弃本次投递'
  $ready = $false
} elseif (-not $st.browsers -or $st.browsers.Count -eq 0) {
  Log '!! 仍没有浏览器连上扩展，放弃本次投递'
  $ready = $false
} else {
  $b = Select-BskBrowser $st.browsers
  if (-not $b) {
    $ready = $false
  } else {
    Log "扩展就绪：实例 $($b.instance_id) / 扩展 $($b.extension_version) / 协议 $($b.extension_protocol_version)（daemon $($st.daemon_version)/$($st.protocol_version)）"
    $Browser = $b.instance_id
  }
}
if (-not $ready) {
  Log '=== 收工：前置条件不满足，未投递 ==='
  Release-LiepinRunLock
  exit 1
}

# ---------- 队列与当日状态 ----------
$queue = @()
if (Test-Path $queueFile) { $queue = @(Get-Content $queueFile -Encoding UTF8 | Where-Object { $_ -match '\S' }) }
$done = @()
if (Test-Path $doneFile) { $done = @(Get-Content $doneFile -Encoding UTF8 | Where-Object { $_ -match '\S' }) }
$todo = @($queue | Where-Object { $done -notcontains $_ })
$todayPrefix = (Get-Date -Format 'yyyy-MM-dd')
$doneCompanies = @()
if (Test-Path $companyFile) {
  $doneCompanies = @(Get-Content $companyFile -Encoding UTF8 |
    Where-Object { $_ -match '\S' -and $_.StartsWith($todayPrefix) } |
    ForEach-Object { ($_ -split "`t")[1] } | Where-Object { $_ } | Select-Object -Unique)
}
$rules = Get-CityRuleMap
$flow = [System.IO.File]::ReadAllText((Resolve-DataPath 'flowScript'), [System.Text.UTF8Encoding]::new($false))

$cfg = Get-PlatformConfig -Quiet
$lpCfg = $cfg.platforms.liepin
$limitSource = '队列长度'
if ($Max -gt 0) {
  $limit = $Max
  $limitSource = '本次命令行'
} elseif ($null -ne $lpCfg.maxApply) {
  $limit = [int]$lpCfg.maxApply
  $limitSource = 'platforms.json maxApply'
} else {
  $limit = $todo.Count
}
$todayApplied = 0
if (Test-Path $appliedPath) {
  foreach ($line in (Get-Content $appliedPath -Encoding UTF8)) {
    try { $row = $line | ConvertFrom-Json } catch { continue }
    if ($row.platform -ne 'liepin' -or $row.signal -ne '投递成功') { continue }
    try { $stamp = [datetime]$row.ts } catch { continue }
    if ($stamp.ToString('yyyy-MM-dd') -eq $todayPrefix) { $todayApplied++ }
  }
}
$dailyRemaining = $null
if ($null -ne $lpCfg.dailyMax) {
  $dailyRemaining = [math]::Max(0, ([int]$lpCfg.dailyMax - $todayApplied))
  $limit = [math]::Min($limit, $dailyRemaining)
  $limitSource += ' + dailyMax'
}

# 关键：bsk.exe 是原生程序，Windows 传参时字符串里的双引号会被剥掉，
# 于是 {"allow":["北京"]} 变成 {allow:[北京]}，页面报 ReferenceError: 北京 is not defined。
# 改写成单引号形式的 JS 对象字面量（内容里没有撇号，安全）。
# 2026-11-03 修正：种子必须在【每个岗位】重新生成。原先只在循环外算一次，
# 于是本次运行里新投的公司不会进入去重集合 —— 实测当天对「慧策」连投了 2 个岗位。
function New-JobScript {
  $rows = @()
  if (Test-Path $companyFile) {
    $rows = @(Get-Content $companyFile -Encoding UTF8 |
      Where-Object { $_ -match '\S' -and $_.StartsWith($todayPrefix) } |
      ForEach-Object { ($_ -split "`t")[1] } | Where-Object { $_ } | Select-Object -Unique)
  }
  $blockedCompanies = @(Get-BlockedCompanyNames)
  $seedObj = [ordered]@{ allow = @($rules.allow); floors = $rules.floors; companies = @($rows); blockedCompanies = $blockedCompanies }
  $seedJson = ($seedObj | ConvertTo-Json -Depth 5 -Compress) -replace '"', "'"
  return "window.__LP_EXT_SEED = $seedJson;`n" + $flow
}

$blockedCompaniesForLog = @(Get-BlockedCompanyNames)
$blockedCompanyCount = $blockedCompaniesForLog.Count
Log "=== 猎聘扩展通道启动：队列剩余 $($todo.Count)，成功上限 $limit（$limitSource），今日台账 $todayApplied 条，同公司当日已投 $($doneCompanies.Count) 家，永久屏蔽公司 $blockedCompanyCount 家 ==="
Log "  城市规则：$(($rules.floors.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' / ')"

$endTime = (Get-Date).Date.AddHours($EndHour).AddMinutes($EndMin)
if ((Get-Date) -ge $endTime) { Log "!! 已过 $EndHour`:$EndMin，不启动"; Release-LiepinRunLock; exit 0 }

# ---------- 会话 ----------
# 2026-11-10：会话建立收进 Start-LpSession。原因：daemon 中途重启后原来的 $session
# 会失效（旧 session 属于死掉的 daemon），必须能重建。重建就是把 $session 换成新 id，
# 全脚本只认这一个变量，所以后面所有 `bsk tab create --session` / `cooperate sync` /
# `evaluate` / `tab close` / 末尾 `session stop` 自然都指向新会话（不另存副本）。
function Start-LpSession {
  param([string]$Browser)
  if (-not $Browser) { return $null }
  $sessRaw = & bsk session start --browser $Browser --json 2>&1 | Out-String
  $sj = $null; try { $sj = $sessRaw | ConvertFrom-Json } catch {}
  if (-not $sj -or -not $sj.session_id) {
    $why = ($sessRaw -replace '[\r\n\t]+', ' ').Trim()
    if ($why.Length -gt 200) { $why = $why.Substring(0, 200) }
    Log "  !! 会话启动失败：$why"
    return $null
  }
  Log "  会话 $($sj.session_id) 已建立（浏览器 $Browser）"
  return "$($sj.session_id)"
}

$session = Start-LpSession -Browser $Browser
if (-not $session) { Release-LiepinRunLock; exit 1 }

if ($DryRun) {
  Log '（-DryRun：只做就绪检查与预览，不投递）'
  Log "  待处理前 5 条：$((@($todo | Select-Object -First 5)) -join ', ')"
  try { [void](& bsk session stop $session 2>&1) } catch {}
  Log '=== DryRun 结束 ==='
  Release-LiepinRunLock
  exit 0
}

# 2026-11-09：账号级体检（与 Boss / 智联同口径）。开跑前先确认猎聘账号可用，
# 避免封禁或验证码状态下把整场时间耗在「求值失败」上。
# 猎聘的判定比另两家保守：只认登录域跳转、验证码/滑块、封禁文案，
# 不因为页面出现「登录/注册」四个字就报警（11-06 就是这么误停的）。
$lpCheckJs = [System.IO.File]::ReadAllText((Resolve-DataPath 'accountCheckScript'), [System.Text.UTF8Encoding]::new($false))
# 注意：这个文件**本身已经是 IIFE**（前 6 行注释，末行是 `})()`），不要再包一层，
# 否则会变成 `((...))()` → TypeError: ... is not a function（2026-11-11 实测踩过）。
$lpCheckTab = $null
try {
  $ckRaw = & bsk tab create --session $session --url "https://www.liepin.com/" --json 2>&1 | Out-String
  $ckJ = $null; try { $ckJ = $ckRaw | ConvertFrom-Json } catch {}
  $lpCheckTab = $ckJ.tab_id
} catch {}
$lpCheck = $null
$lpCheckErr = ''
if ($lpCheckTab) {
  Start-Sleep -Seconds 6
  for ($ci = 1; $ci -le 5; $ci++) {
    # 必须用 Invoke-Bsk：直接 `& bsk evaluate ... $lpCheckJs` 会把 JS 里的双引号吃掉，
    # bsk 报 invalid_params，调用方再当成"没取到结果"→ 体检静默通过（2026-11-11 就这样漏了未登录）。
    $ckSync = Invoke-Bsk @('cooperate','sync','--session',$session,'--tab-id',$lpCheckTab,'--policy','strict','--json') 40
    $ckSj = $null; try { $ckSj = $ckSync.out | ConvertFrom-Json } catch {}
    if (-not $ckSj.context_id) { $lpCheckErr = 'cooperate sync 未返回 context_id'; Start-Sleep -Milliseconds 900; continue }
    $ckOut = Invoke-Bsk @('evaluate','--session',$session,'--tab-id',$lpCheckTab,'--context',$ckSj.context_id,'--timeout','30s','--json',$lpCheckJs) 50
    $ckOj = $null; try { $ckOj = $ckOut.out | ConvertFrom-Json } catch {}
    if ($ckOj.value) {
      # bsk --json 已经把 value 解析成对象了；此时再 ConvertFrom-Json 会抛错，
      # 于是被当成"体检返回值不是合法 JSON"——这才是今天那条误报的根因。
      try {
        if ($ckOj.value -is [string]) { $lpCheck = $ckOj.value | ConvertFrom-Json }
        else { $lpCheck = $ckOj.value }
      } catch { $lpCheck = $null }
      if (-not $lpCheck) { $lpCheckErr = '体检返回值既不是合法 JSON 串也不是对象' }
    } elseif ($ckOj -and $ckOj.error -and $ckOj.error.text) {
      $lpCheckErr = [string]$ckOj.error.text
    } else {
      $t = ($ckOut.out -replace '\s+',' ')
      $lpCheckErr = if ($t) { $t.Substring(0,[Math]::Min(160,$t.Length)) } else { 'evaluate 无输出' }
    }
    break
  }
  try { [void](& bsk tab close --session $session $lpCheckTab 2>&1) } catch {}
}

if ($lpCheck -and -not $lpCheck.ok) {
  $lpKind = if ($lpCheck.banned) { 'banned' } elseif ($lpCheck.needLogin) { 'needLogin' } else { 'throttled' }
  Log "  !! 猎聘账号体检未通过（$lpKind：$($lpCheck.reason)），本场不启动"
  $lpViol = [ordered]@{
    ts = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); platform = 'liepin'; type = 'account-check-failed'
    severity = 'critical'; company = ''; jobTitle = ''
    rootCause = "开跑前账号体检未通过（$lpKind）：$($lpCheck.reason)"
    impact = '本场未投递任何岗位，避免在封禁/限流状态下继续触发风控。'
    note = '由 lp-ext-run.ps1 的猎聘账号体检自动记录。'
  }
  try { [System.IO.File]::AppendAllText((Resolve-DataPath 'violations'), (($lpViol | ConvertTo-Json -Compress -Depth 4) + "`r`n"), (New-Object System.Text.UTF8Encoding($false))) } catch {}
  Log '  正在弹窗询问暂停时长（2 分钟无操作则默认暂停 24 小时）…'
  try {
    $lgOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Resolve-DataPath 'platformGuardScript') -Platform 'liepin' -Reason "账号异常（$lpKind）：$($lpCheck.reason)" -DefaultHours 24 -TimeoutSec 120 2>&1 | Out-String
    foreach ($gl in ($lgOut -split "`r?`n")) { if ($gl.Trim()) { Log "  [守卫] $($gl.Trim())" } }
  } catch { Log "  [守卫] 调用失败：$($_.Exception.Message)" }
  try { [void](& bsk session stop $session 2>&1) } catch {}
  Release-LiepinRunLock
  exit 0
}
Log "  账号体检通过$(if (-not $lpCheck) { "（未取到体检结果，按通过处理；原因：$lpCheckErr）" } else { '' })"
if (-not $lpCheck) {
  # 体检取不到结果不等于账号正常。这里不再沉默：写一条 warn 级记录，让"未登录/验证码/封禁"
  # 这类前置问题在日志里留下痕迹（真正的拦截靠下面逐岗位的封禁信号检测）。
  try {
    $lpViol = [ordered]@{
      ts = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); platform = 'liepin'; type = 'account-check-inconclusive'
      severity = 'minor'; company = ''; jobTitle = ''
      rootCause = "开跑前账号体检没有取到结果：$lpCheckErr"
      impact = '体检闸门形同虚设；若账号实际处于未登录/验证码/封禁状态，只能靠逐岗位的页面信号兜住。'
      note = '由 lp-ext-run.ps1 自动记录；若同一天反复出现，说明体检脚本或通道有问题，需要修。'
    }
    [System.IO.File]::AppendAllText((Resolve-DataPath 'violations'), (($lpViol | ConvertTo-Json -Compress -Depth 4) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# ---------- daemon 掉线自愈（2026-11-10，配合 runner-lib.ps1 的 Ensure-BskDaemon） ----------
# 猎聘一条要 60-180 秒（温和模式，刻意的，别动），这期间 daemon 完全可能空闲自退。
# 一旦掉了：后面的 tab create / cooperate 全失败，原来会被当成「建标签失败」连数 3 次
# 就收工 —— 整场白丢。现在每个候选之前探一次（一次 status，约 70ms），掉了就拉起并重建会话。
function Get-LpBrowser {
  $p = Test-BskDaemon
  if (-not $p.Alive) { return $null }
  $b = Select-BskBrowser $p.Status.browsers
  if (-not $b) { return $null }
  return "$($b.instance_id)"
}

# daemon 重启后扩展一般 2-4 秒自己重连；连不上不是「daemon 没起来」，要分开报。
function Wait-LpBrowser {
  param([int]$TimeoutSec = 25)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $b = Get-LpBrowser
    if ($b) { return $b }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Milliseconds 800
  }
}

# 拉起 daemon + 用新会话替换旧会话。成功返回 @{Session;Browser}，失败返回 $null。
# 注意：旧 $session 属于已经死掉的 daemon，不能复用，必须重新 session start
# （否则后面 tab create --session 全部报错，这正是本次故障后的次生问题）。
function Restore-LpDaemonSession {
  param([string]$Reason)
  Log "  !! daemon 掉线：$Reason"
  if (-not (Ensure-BskDaemon -Log $daemonLog)) {
    Log '  !! Ensure-BskDaemon 未能拉起 daemon（已用 status 实测确认，不是猜的）'
    return $null
  }
  Log '  daemon 已拉起，等扩展自己重连…'
  $nb = Wait-LpBrowser -TimeoutSec 25
  if (-not $nb) {
    Log '  !! daemon 起来了，但 25 秒内没有浏览器连上扩展（扩展/Chrome 可能没在跑）'
    return $null
  }
  $ns = Start-LpSession -Browser $nb
  if (-not $ns) { Log '  !! 会话重建失败'; return $null }
  return [pscustomobject]@{ Session = $ns; Browser = $nb }
}

$ok = 0; $skip = 0; $fail = 0; $attempted = 0; $consecFail = 0
$daemonRestarts = 0
$banHit = $false
$health = [ordered]@{ date = $todayPrefix; startedAt = (Get-Date -Format 's'); limit = $limit; limitSource = $limitSource; todayApplied = $todayApplied; attempted = 0; ok = 0; skip = 0; fail = 0; ban = $false; banSignal = ''; stopReason = ''; daemonRestarts = 0; attempts = @() }

try {
  foreach ($jobId in $todo) {
    if ($ok -ge $limit) { Log "已达本次上限 $limit 条，收工"; break }
    if ((Get-Date) -ge $endTime) { Log '时间窗到，收工'; break }
    if ($banHit) { break }

    # 2026-11-10：每个候选之前轻量探一次 daemon。上一个候选之后那 60-180 秒间隔
    # 正好是 daemon 空闲自退的窗口，所以这一步必须在「下一个 job 真正开干之前」——
    # 这就是 15:07:48 之后静默卡死 17 分钟的直接补丁。
    $probe = Test-BskDaemon
    if (-not $probe.Alive) {
      $fix = Restore-LpDaemonSession -Reason "$($probe.Message)（status exit=$($probe.Exit)）"
      if ($fix) {
        $session = $fix.Session
        $Browser = $fix.Browser
        $daemonRestarts++
        $health.daemonRestarts = $daemonRestarts
        Log "  daemon 已恢复并重建会话（新会话 $session / 浏览器 $Browser），继续投递"
      } else {
        $health.stopReason = 'daemon_unavailable'
        Log '  !! daemon 无法恢复，停止本场（剩余岗位保留在队列，下次运行会重投）'
        break
      }
    }

    $attempted++
    Log "[$jobId]"
    $tabId = $null
    try {
      $createRaw = & bsk tab create --session $session --url "https://www.liepin.com/job/$jobId.shtml" --json 2>&1 | Out-String
      $createExit = $LASTEXITCODE
      $cj = $null; try { $cj = $createRaw | ConvertFrom-Json } catch {}
      $tabId = $cj.tab_id
      if (-not $tabId) {
        $detail = if ($cj -and $cj.error) { "$($cj.error)" } elseif ($cj -and $cj.message) { "$($cj.message)" } elseif ($null -ne $createExit -and $createExit -ne 0) { "bsk exit=$createExit" } elseif (-not $cj) { '返回内容无法解析' } else { '响应缺少 tab_id' }
        $detail = ($detail -replace '[\r\n\t]+', ' ').Trim()
        if ($detail.Length -gt 180) { $detail = $detail.Substring(0, 180) }

        # 2026-11-10：半路掉的 daemon 不能按「建标签失败」记账 —— 那样连数 3 次就把
        # 整场收了，而根因只是 daemon 不在了（不是扩展/浏览器坏了）。先重建会话，
        # 本轮跳过这个岗位（不写 done，下次运行会重投），只要还有时间窗就继续下一个。
        if (-not (Test-BskDaemon).Alive) {
          $fix = Restore-LpDaemonSession -Reason "建标签时 daemon 已不在（$detail）"
          if ($fix) {
            $session = $fix.Session
            $Browser = $fix.Browser
            $daemonRestarts++
            $health.daemonRestarts = $daemonRestarts
            Log "  daemon 已恢复并重建会话（新会话 $session / 浏览器 $Browser），跳过 [$jobId]（未写 done，下次会重试）"
            continue
          }
          $health.stopReason = 'daemon_unavailable'
          Log '  !! daemon 无法恢复，停止本场（剩余岗位保留在队列，下次运行会重投）'
          break
        }

        $fail++; $consecFail++
        $health.attempts += [ordered]@{ jobId = "$jobId"; stage = 'tab_create_failed'; error = $detail; at = (Get-Date -Format 's') }
        Log "  建标签失败（$detail；连续失败=$consecFail）"
        if ($consecFail -ge 3) {
          $health.stopReason = 'three_consecutive_tab_create_failures'
          Log '  !! 连续 3 次建标签失败，判定为扩展/浏览器连接异常；停止本场，剩余岗位保留在队列'
          break
        }
        Start-Sleep -Seconds 3
        continue
      }
      Start-Sleep -Seconds $LoadWaitSec

      # 等标签真的落到岗位页（新建标签初始是 pending URL）
      $landed = $false
      for ($w = 1; $w -le 30; $w++) {
        $tl = & bsk tab list --session $session --json 2>&1 | Out-String
        $tj = $null; try { $tj = $tl | ConvertFrom-Json } catch {}
        $cur = @($tj.tabs | Where-Object { $_.tab_id -eq $tabId }) | Select-Object -First 1
        if ($cur -and $cur.url -match [regex]::Escape($jobId)) { $landed = $true; break }
        Start-Sleep -Milliseconds 800
      }
      if (-not $landed) {
        $fail++; $consecFail++
        $health.attempts += [ordered]@{ jobId = "$jobId"; stage = 'navigation_failed'; at = (Get-Date -Format 's') }
        Log "  导航未落到岗位页（连续失败=$consecFail）"
        if ($consecFail -ge 3) {
          $health.stopReason = 'three_consecutive_navigation_failures'
          Log '  !! 连续 3 次岗位页未就绪，停止本场，剩余岗位保留在队列'
          break
        }
        Start-Sleep -Seconds 3
        continue
      }

      # 每个岗位都用「最新的已投公司集合」重建种子，否则同一家公司会在本次运行内被连投
      $js = New-JobScript
      # 一次求值跑完判定+投递
      $res = $null
      for ($i = 1; $i -le 6; $i++) {
        [void](& bsk cooperate wait --session $session --tab-id $tabId --timeout-ms 5000 --json 2>&1)
        $syncRaw = Invoke-Bsk @('cooperate','sync','--session',$session,'--tab-id',$tabId,'--policy','strict','--json') 40
        $sj2 = $null; try { $sj2 = $syncRaw.out | ConvertFrom-Json } catch {}
        if (-not $sj2.context_id) { continue }
        $outObj = Invoke-Bsk @('evaluate','--session',$session,'--tab-id',$tabId,'--context',$sj2.context_id,'--timeout','60s','--json',$js) 80
        $out = $outObj.out
        if ($out -match 'permission_denied|cooperation_sync_required') { Start-Sleep -Milliseconds 600; continue }
        $oj = $null; try { $oj = $out | ConvertFrom-Json } catch {}
        if ($oj.value) { $res = $oj.value | ConvertFrom-Json; break }
        break
      }

      if (-not $res) { Log '  求值失败'; $fail++; $consecFail++; }
      else {
        $stage = "$($res.stage)"
        $co = "$($res.company)"; $ci = "$($res.city)"; $sa = "$($res.salary)"
        $health.attempts += [ordered]@{ jobId = "$jobId"; stage = $stage; company = $co; city = $ci; salary = $sa; at = (Get-Date -Format 's') }
        switch ($stage) {
          'applied' {
            $ok++; $consecFail = 0
            $rec = [ordered]@{
              ts = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); platform = 'liepin'
              title = "北京 $($res.title)"; company = $co; location = $ci; salary = $sa
              keyword = "$jobId"; signal = '投递成功'
            }
            [System.IO.File]::AppendAllText($appliedPath, (($rec | ConvertTo-Json -Compress) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
            if ($co) { [System.IO.File]::AppendAllText($companyFile, "$todayPrefix`t$co`n", (New-Object System.Text.UTF8Encoding($false))) }
            Log "  OK $($res.title) @ $co $sa（$ci，$((($res.log) -join '/'))）"
          }
          'risk' {
            $banHit = $true; $health.ban = $true; $health.banSignal = "$($res.riskText)"
            Log "  !! 封禁/风控信号：$($res.riskText) —— 立即停止投递"
          }
          'company' { $skip++; $consecFail = 0; Log "  skip 同公司当日已投（$co）" }
          'blockedCompany' { $skip++; $consecFail = 0; Log "  skip 永久屏蔽公司（$co）" }
          'city'    { $skip++; $consecFail = 0; Log "  skip 城市不符（$ci）" }
          'salary'  { $skip++; $consecFail = 0; Log "  skip 薪资上限不够（$sa，城市 $ci）" }
          'paused'  { $skip++; $consecFail = 0; Log '  skip 已暂停招聘' }
          'nochat'  { $fail++; $consecFail++; Log '  未找到聊一聊按钮' }
          default   { $fail++; $consecFail++; Log "  未成功（$stage：$($res.reason)）" }
        }
        # 只有「结论明确」的岗位才写 done：投成功、或确定不投（同公司/城市/薪资/暂停）。
        # 求值失败、找不到按钮这类属于可恢复问题，写了 done 就再也不会重试
        # （2026-11-02 踩过：一次求值全失败，把 17 个岗位一次性标记成已完成，队列被清空）。
        # 2026-11-11 修正：risk（封禁/风控信号）**不能**算结论明确 —— 它只说明"这一刻不能投"，
        # 那条岗位根本没投出去，写 done 等于永久丢弃（当天 1986599575 就这样被吞掉，需手动捞回）。
        $conclusive = $stage -in @('applied', 'company', 'blockedCompany', 'city', 'salary', 'paused')
        if ($conclusive) {
          [System.IO.File]::AppendAllText($doneFile, "$jobId`n", (New-Object System.Text.UTF8Encoding($false)))
        } else {
          Log '  （未写 done，下次会重试）'
        }
      }
      # 连续失败 3 次：可能是页面风控，也可能是扩展通信异常；先停下并保留队列。
      if ($consecFail -ge 3 -and -not $banHit) {
        $banHit = $true; $health.ban = $true; $health.banSignal = '连续 3 次未成功，需人工确认'
        $health.stopReason = 'three_consecutive_flow_failures'
        Log '  !! 连续 3 次流程未成功，停止本场，剩余岗位保留在队列'
        break
      }
    }
    catch {
      Log "  异常：$($_.Exception.Message)"
      $fail++; $consecFail++
      if ($consecFail -ge 3) {
        $health.stopReason = 'three_consecutive_runner_exceptions'
        Log '  !! 连续 3 次运行器异常，停止本场，剩余岗位保留在队列'
        break
      }
    }
    finally {
      if ($tabId) { try { [void](& bsk tab close --session $session $tabId 2>&1) } catch {} }
    }
    # 2026-11-03：节奏从「3-8 秒」改成「60-180 秒」。
    # 实测 7 条 / 2分33秒（约 3 条/分钟）就触发了猎聘验证码；
    # CDP 通道一直是 60-180 秒的温和模式，从没在早场撞过验证码。
    Start-Sleep -Seconds (Get-Random -Minimum $GapMin -Maximum $GapMax)
  }
}
finally {
  # $session 可能已被 daemon 重启替换过；只认当前值，且允许为空（会话没建成时）。
  if ($session) {
    if ([bool]$script:Config.behavior.closeAgentLiepinAndBlankTabsOnExit) {
      # 收尾清场：Agent Window 里会留下 session 起始时的 about:blank 以及可能的猎聘残留标签。
      # 只关 scope=agent 的，用户自己 scope=user 的标签一个都不碰。
      try {
        $tl = Invoke-Bsk @('tab','list','--session',$session,'--json') 20
        $tj = $null; try { $tj = $tl.out | ConvertFrom-Json } catch {}
        $leftovers = @()
        if ($tj -and $tj.tabs) {
          $leftovers = @($tj.tabs | Where-Object { $_.scope -eq 'agent' -and ([string]$_.url -match 'about:blank|liepin\.com') })
        }
        if ($leftovers.Count -gt 0) {
          Log "  收尾：关闭 $($leftovers.Count) 个残留标签（scope=agent）"
          foreach ($t in $leftovers) { try { [void](& bsk tab close --session $session $t.tab_id 2>&1) } catch {} }
        }
      } catch {}
    }
    try { [void](& bsk session stop $session 2>&1) } catch {}
  }
  $health.ok = $ok; $health.skip = $skip; $health.fail = $fail
  $health.attempted = $attempted
  $health.daemonRestarts = $daemonRestarts
  $health.finishedAt = (Get-Date -Format 's')
  [System.IO.File]::WriteAllText($healthPath, ($health | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Log "=== 猎聘扩展通道收工：尝试=$attempted 成功=$ok 跳过=$skip 失败=$fail 封禁信号=$(if ($banHit) { $health.banSignal } else { '无' }) stop=$(if ($health.stopReason) { $health.stopReason } else { 'none' }) daemon重建=$daemonRestarts ==="
  Log '注意：成功=页面回执出现「发送成功」，真正落库仍要用记录页核验（verify-run.ps1）。'
  Release-LiepinRunLock
}

# platform-guard.ps1 — 平台账号异常时的「临时停止 + 弹窗问时长」守卫。
#
# 版式：2026-11-09 按「03 石墨蓝专业」方案重做（主色 #355478，标题条渐变，
# 圆角卡片，异常提示浅橙底 + 橙红竖条，按钮带选中态）。
# 主色可由 platform-guard-theme.json 覆盖，见 set-dialog-color.ps1。
#
# 用法：
#   powershell -File platform-guard.ps1 -Platform boss -Reason "403 访问被拒绝（账号受限/封禁）"
#   ... -DefaultHours 24       # 弹窗无响应时的默认暂停时长（小时，支持小数）
#   ... -TimeoutSec 120        # 弹窗自动关闭的秒数
#   ... -AccentColor '#355478' # 临时覆盖主色（不写盘）
#   ... -NoPrompt              # 无人值守：不弹窗，直接按默认时长暂停
param(
  [Parameter(Mandatory = $true)][string]$Platform,
  [string]$Reason = '账号异常',
  [double]$DefaultHours = 24,
  [int]$TimeoutSec = 120,
  # ⚠️ 参数名不能叫 $Accent：脚本里有 $accent 面板，PowerShell 变量不区分大小写。
  [string]$AccentColor = '',
  [switch]$NoPrompt,
  # 三个路径默认落在脚本同目录，调用方可用这三个参数覆盖（例如指向自己的数据目录）。
  [string]$PauseFile = '',
  [string]$ThemeFile = '',
  [string]$PresetsFile = ''
)

$ErrorActionPreference = 'Continue'
$pauseFile = if ($PauseFile) { $PauseFile } else { Join-Path $PSScriptRoot 'platform-pause.json' }

function Write-Pause {
  param([double]$Hours, [string]$How)
  $now = Get-Date
  $until = if ($Hours -eq 0) { $now.Date.AddDays(1) } else { $now.AddHours($Hours) }
  $obj = [ordered]@{}
  if (Test-Path $pauseFile) {
    try {
      $old = Get-Content $pauseFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($old) { foreach ($p in $old.PSObject.Properties) { $obj[$p.Name] = $p.Value } }
    } catch {}
  }
  if ($Hours -lt 0) {
    if ($obj.Contains($Platform)) { $obj.Remove($Platform) }
  } else {
    $obj[$Platform] = [ordered]@{
      until = $until.ToString('yyyy-MM-ddTHH:mm:ss'); hours = $Hours
      reason = $Reason; setAt = $now.ToString('yyyy-MM-ddTHH:mm:ss'); decidedBy = $How
    }
  }
  [System.IO.File]::WriteAllText($pauseFile, ($obj | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  if ($Hours -lt 0) { Write-Output "不暂停：已清除 $Platform 的暂停记录" }
  else { Write-Output ("已暂停 {0} 至 {1}（{2}）" -f $Platform, $until.ToString('yyyy-MM-dd HH:mm:ss'), $How) }
}

if ($NoPrompt) {
  Write-Pause -Hours $DefaultHours -How '无人值守默认'
  exit 0
}

$script:chosen = $null          # 小时数；0=到今天结束；-1=不暂停；-2=关闭窗口
$script:dragOffset = $null

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  # ---------- 颜色工具 ----------
  function Parse-HexColor([string]$hex) {
    $h = "$hex".Trim().TrimStart('#')
    if ($h.Length -eq 3) { $h = '' + $h[0] + $h[0] + $h[1] + $h[1] + $h[2] + $h[2] }
    if ($h -notmatch '^[0-9a-fA-F]{6}$') { return $null }
    return [System.Drawing.Color]::FromArgb(
      [Convert]::ToInt32($h.Substring(0, 2), 16),
      [Convert]::ToInt32($h.Substring(2, 2), 16),
      [Convert]::ToInt32($h.Substring(4, 2), 16))
  }
  function Get-Shade($c, [double]$f) {
    return [System.Drawing.Color]::FromArgb($c.A,
      [Math]::Min(255, [int]($c.R * $f)), [Math]::Min(255, [int]($c.G * $f)), [Math]::Min(255, [int]($c.B * $f)))
  }
  function Get-Tint($c, [double]$r) {
    return [System.Drawing.Color]::FromArgb($c.A,
      [int]($c.R + (255 - $c.R) * $r), [int]($c.G + (255 - $c.G) * $r), [int]($c.B + (255 - $c.B) * $r))
  }
  function Set-Rounded([System.Windows.Forms.Control]$ctrl, [int]$r) {
    if ($ctrl.Width -le 0 -or $ctrl.Height -le 0) { return }
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc(0, 0, $d, $d, 180, 90)
    $p.AddArc($ctrl.Width - $d, 0, $d, $d, 270, 90)
    $p.AddArc($ctrl.Width - $d, $ctrl.Height - $d, $d, $d, 0, 90)
    $p.AddArc(0, $ctrl.Height - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    $ctrl.Region = New-Object System.Drawing.Region($p)
  }

  # ---------- 配色模板 ----------
  # 三套内置预设（靛蓝 / 青绿 / 石墨蓝）来自 dialog-theme-presets.json；
  # platform-guard-theme.json 只记「用哪套」或「自定义主色」：
  #   {"preset":"teal"}          → 用预设的完整色值（标题渐变、选中态都是原样）
  #   {"accent":"#7E57C2"}       → 自定义主色，其余三档按算法派生
  # 两者都没有则用预设文件里的 default。
  $presetFile = if ($PresetsFile) { $PresetsFile } else { Join-Path $PSScriptRoot 'dialog-theme-presets.json' }
  $themeFile = if ($ThemeFile) { $ThemeFile } else { Join-Path $PSScriptRoot 'platform-guard-theme.json' }

  $presets = $null; $defaultPresetName = 'slate'; $sharedCfg = $null
  if (Test-Path $presetFile) {
    try {
      $pd = Get-Content $presetFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $presets = $pd.presets
      if ($pd.default) { $defaultPresetName = "$($pd.default)" }
      $sharedCfg = $pd.shared
    } catch {}
  }

  $usePreset = $defaultPresetName
  $customAccent = ''
  if (Test-Path $themeFile) {
    try {
      $th = Get-Content $themeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($th.preset) { $usePreset = "$($th.preset)" }
      elseif ($th.accent) { $customAccent = "$($th.accent)" }
    } catch {}
  }
  if ($AccentColor) { $customAccent = $AccentColor; $usePreset = '' }

  function Get-Preset([string]$name) {
    if (-not $presets) { return $null }
    $p = $presets.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
  }

  $ps = if ($usePreset) { Get-Preset $usePreset } else { $null }

  if ($customAccent) {
    $C_ACCENT = Parse-HexColor $customAccent
    if (-not $C_ACCENT) { $C_ACCENT = [System.Drawing.Color]::FromArgb(53, 84, 120) }
    $C_HDR1   = Get-Shade $C_ACCENT 0.72
    $C_HDR2   = Get-Tint  $C_ACCENT 0.20
    $C_SEL_BG = Get-Tint  $C_ACCENT 0.90
    $C_SEL_BD = Get-Tint  $C_ACCENT 0.62
  } elseif ($ps) {
    $C_ACCENT = Parse-HexColor $ps.accent
    $C_HDR1   = Parse-HexColor $ps.headerFrom
    $C_HDR2   = Parse-HexColor $ps.headerTo
    $C_SEL_BG = Parse-HexColor $ps.selBg
    $C_SEL_BD = Parse-HexColor $ps.selBorder
    if (-not $C_ACCENT) { $C_ACCENT = [System.Drawing.Color]::FromArgb(53, 84, 120) }
    if (-not $C_HDR1) { $C_HDR1 = Get-Shade $C_ACCENT 0.72 }
    if (-not $C_HDR2) { $C_HDR2 = Get-Tint $C_ACCENT 0.20 }
    if (-not $C_SEL_BG) { $C_SEL_BG = Get-Tint $C_ACCENT 0.90 }
    if (-not $C_SEL_BD) { $C_SEL_BD = Get-Tint $C_ACCENT 0.62 }
  } else {
    $C_ACCENT = [System.Drawing.Color]::FromArgb(53, 84, 120)
    $C_HDR1   = Get-Shade $C_ACCENT 0.72
    $C_HDR2   = Get-Tint  $C_ACCENT 0.20
    $C_SEL_BG = Get-Tint  $C_ACCENT 0.90
    $C_SEL_BD = Get-Tint  $C_ACCENT 0.62
  }
  $C_PALE = Get-Tint $C_ACCENT 0.94

  # 共用色（三套方案一致）；有不一致的就按 shared 覆盖
  function Get-Shared([string]$key, [string]$fallbackHex) {
    if ($sharedCfg) {
      $v = $sharedCfg.PSObject.Properties[$key]
      if ($v -and $v.Value) { $c = Parse-HexColor "$($v.Value)"; if ($c) { return $c } }
    }
    return (Parse-HexColor $fallbackHex)
  }

  $C_WIN     = [System.Drawing.Color]::White
  $C_TITLE   = Get-Shared 'title'  '#1D2740'
  $C_MUTED   = Get-Shared 'muted'  '#758098'
  $C_LABEL   = Get-Shared 'label'  '#536078'
  $C_TXT     = Get-Shared 'text'   '#34405C'
  $C_BD      = Get-Shared 'border' '#DCE2EF'
  $C_SEP     = Get-Shared 'sep'    '#E9EDF4'
  $C_ERR_BG  = Get-Shared 'errBg'  '#FFF5F2'
  $C_ERR_BD  = Get-Shared 'errBorder' '#F6D6CE'
  $C_ERR_BAR = Get-Shared 'errBar' '#E8745C'
  $C_ERR_TAG = Get-Shared 'errTag' '#9B6358'
  $C_ERR_TXT = Get-Shared 'errText' '#B8402F'
  $C_WHITE   = [System.Drawing.Color]::White

  $fontMain  = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
  $fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
  $fontTiny  = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
  $fontTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Bold)
  $fontErr   = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $fontBtn   = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)

  # ---------- 窗体 ----------
  $W = 720; $H = 466
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "平台账号异常 - $Platform"
  $form.ClientSize = New-Object System.Drawing.Size($W, $H)
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $form.FormBorderStyle = 'None'
  $form.BackColor = $C_WIN
  $form.Font = $fontMain
  $form.Padding = New-Object System.Windows.Forms.Padding(0)

  $shell = New-Object System.Windows.Forms.Panel
  $shell.SetBounds(0, 0, $W, $H)
  $shell.BackColor = $C_WIN
  $form.Controls.Add($shell)

  # ---------- 标题条（渐变 + 圆角）----------
  $header = New-Object System.Windows.Forms.Panel
  $header.SetBounds(24, 22, ($W - 48), 64)
  $header.BackColor = $C_HDR1
  $header.Add_Paint({
    param($s, $e)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point(0, 0)),
      (New-Object System.Drawing.Point($s.Width, $s.Height)),
      $C_HDR1, $C_HDR2)
    $e.Graphics.FillRectangle($brush, 0, 0, $s.Width, $s.Height)
    $brush.Dispose()
  })
  $shell.Controls.Add($header)
  Set-Rounded $header 12

  # 左侧圆形时钟图标
  $ico = New-Object System.Windows.Forms.Panel
  $ico.SetBounds(18, 20, 24, 24)
  $ico.BackColor = $C_HDR2
  $ico.Add_Paint({
    param($s, $e)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(48, 255, 255, 255))
    $e.Graphics.FillEllipse($b, 0, 0, 24, 24)
    $b.Dispose()
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1.6)
    $e.Graphics.DrawLine($pen, 12, 7, 12, 13)
    $e.Graphics.DrawLine($pen, 12, 13, 16, 16)
    $pen.Dispose()
  })
  $header.Controls.Add($ico)
  Set-Rounded $ico 12

  $lblHead = New-Object System.Windows.Forms.Label
  $lblHead.Text = '账户异常 · 投递已暂停'
  $lblHead.Font = $fontTitle
  $lblHead.ForeColor = $C_WHITE
  $lblHead.AutoSize = $false
  $lblHead.SetBounds(52, 20, 420, 24)
  $lblHead.BackColor = [System.Drawing.Color]::Transparent
  $header.Controls.Add($lblHead)

  $lblSub = New-Object System.Windows.Forms.Label
  $lblSub.Text = "平台 $Platform"
  $lblSub.Font = $fontTiny
  $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(210, 226, 240)
  $lblSub.AutoSize = $false
  $lblSub.SetBounds(52, 42, 420, 18)
  $lblSub.BackColor = [System.Drawing.Color]::Transparent
  $header.Controls.Add($lblSub)

  # 关闭按钮（圆形）
  $btnClose = New-Object System.Windows.Forms.Label
  $btnClose.Text = 'X'
  $btnClose.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $btnClose.ForeColor = [System.Drawing.Color]::FromArgb(225, 235, 245)
  $btnClose.BackColor = $C_HDR1
  $btnClose.TextAlign = 'MiddleCenter'
  $btnClose.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btnClose.SetBounds((($W - 48) - 40), 20, 24, 24)
  $btnClose.Add_Click({ $script:chosen = -2; $form.Close() })
  $header.Controls.Add($btnClose)
  Set-Rounded $btnClose 12

  # ---------- 异常卡片 ----------
  $card = New-Object System.Windows.Forms.Panel
  $card.SetBounds(24, 102, ($W - 48), 84)
  $card.BackColor = $C_ERR_BG
  $card.Add_Paint({
    param($s, $e)
    $pen = New-Object System.Drawing.Pen($C_ERR_BD, 1)
    $e.Graphics.DrawRectangle($pen, 0, 0, $s.Width - 1, $s.Height - 1)
    $pen.Dispose()
  })
  $shell.Controls.Add($card)
  Set-Rounded $card 9

  $bar = New-Object System.Windows.Forms.Panel
  $bar.SetBounds(0, 0, 4, 84)
  $bar.BackColor = $C_ERR_BAR
  $card.Controls.Add($bar)
  Set-Rounded $bar 2

  $lblTag = New-Object System.Windows.Forms.Label
  $lblTag.Text = '异常原因'
  $lblTag.Font = $fontTiny
  $lblTag.ForeColor = $C_ERR_TAG
  $lblTag.SetBounds(20, 14, 200, 16)
  $lblTag.BackColor = $C_ERR_BG
  $card.Controls.Add($lblTag)

  $lblReason = New-Object System.Windows.Forms.Label
  $lblReason.Text = $Reason
  $lblReason.Font = $fontErr
  $lblReason.ForeColor = $C_ERR_TXT
  $lblReason.AutoSize = $false
  $lblReason.SetBounds(20, 36, ($W - 48 - 44), 40)
  $lblReason.BackColor = $C_ERR_BG
  $card.Controls.Add($lblReason)

  # ---------- 选择暂停时长 ----------
  $lblPick = New-Object System.Windows.Forms.Label
  $lblPick.Text = '选择暂停时长'
  $lblPick.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
  $lblPick.ForeColor = $C_LABEL
  $lblPick.SetBounds(24, 204, 300, 20)
  $shell.Controls.Add($lblPick)

  # ---------- 常用选项 ----------
  $specs = @(
    @{ t = '停 2 小时'; h = 2.0 },
    @{ t = '停到今天结束'; h = 0.0 },
    @{ t = '停 1 天'; h = 24.0 },
    @{ t = '停 2 天'; h = 48.0 },
    @{ t = '不暂停'; h = -1.0 }
  )
  $bx = 24
  $bw = 128
  foreach ($s in $specs) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $s.t
    $btn.Font = $fontMain
    $btn.FlatStyle = 'Flat'
    $btn.FlatAppearance.BorderSize = 1
    $btn.FlatAppearance.BorderColor = $C_BD
    $btn.BackColor = $C_WIN
    $btn.ForeColor = $C_TXT
    $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
    $btn.SetBounds($bx, 230, $bw, 54)
    $btn.Tag = $s.h
    $btn.Add_Click({
      $script:chosen = [double]$this.Tag
      $form.Close()
    })
    $btn.Add_MouseEnter({
      $this.BackColor = $C_SEL_BG
      $this.FlatAppearance.BorderColor = $C_SEL_BD
    })
    $btn.Add_MouseLeave({
      $this.BackColor = $C_WIN
      $this.FlatAppearance.BorderColor = $C_BD
    })
    $shell.Controls.Add($btn)
    Set-Rounded $btn 8
    $bx += ($bw + 10)
  }

  # ---------- 自定义时长 + 主按钮 ----------
  $lblCustom = New-Object System.Windows.Forms.Label
  $lblCustom.Text = '自定义'
  $lblCustom.Font = $fontMain
  $lblCustom.ForeColor = $C_LABEL
  $lblCustom.SetBounds(24, 306, 52, 24)
  $shell.Controls.Add($lblCustom)

  $numHours = New-Object System.Windows.Forms.NumericUpDown
  $numHours.Font = $fontMain
  $numHours.Minimum = [decimal]0.5
  $numHours.Maximum = [decimal]720
  $numHours.DecimalPlaces = 1
  $numHours.Increment = [decimal]0.5
  $numHours.Value = [decimal]6
  $numHours.SetBounds(78, 304, 88, 28)
  $numHours.TextAlign = 'Center'
  $shell.Controls.Add($numHours)

  $lblUnit = New-Object System.Windows.Forms.Label
  $lblUnit.Text = '小时'
  $lblUnit.Font = $fontMain
  $lblUnit.ForeColor = $C_MUTED
  $lblUnit.SetBounds(172, 308, 40, 22)
  $shell.Controls.Add($lblUnit)

  $btnCustom = New-Object System.Windows.Forms.Button
  $btnCustom.Text = '按此时长暂停'
  $btnCustom.Font = $fontBtn
  $btnCustom.FlatStyle = 'Flat'
  $btnCustom.FlatAppearance.BorderSize = 0
  $btnCustom.BackColor = $C_ACCENT
  $btnCustom.ForeColor = $C_WHITE
  $btnCustom.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btnCustom.SetBounds(24, 348, ($W - 48), 46)
  $btnCustom.Add_Click({
    $script:chosen = [double]$numHours.Value
    $form.Close()
  })
  $btnCustom.Add_MouseEnter({ $this.BackColor = $C_HDR1 })
  $btnCustom.Add_MouseLeave({ $this.BackColor = $C_ACCENT })
  $shell.Controls.Add($btnCustom)
  Set-Rounded $btnCustom 9

  # ---------- 分隔线 + 倒计时 ----------
  # 2026-11-09：删掉底部的「主题色 #xxxxxx / 结果写入 …」整块——
  # 那两行是给开发看的调试信息，用户看不懂也不需要。只留倒计时。
  $sep = New-Object System.Windows.Forms.Panel
  $sep.SetBounds(24, 412, ($W - 48), 1)
  $sep.BackColor = $C_SEP
  $shell.Controls.Add($sep)

  $lblCount = New-Object System.Windows.Forms.Label
  $lblCount.Font = $fontSmall
  $lblCount.ForeColor = $C_MUTED
  $lblCount.TextAlign = 'MiddleCenter'
  $lblCount.SetBounds(24, 422, 470, 20)
  $shell.Controls.Add($lblCount)

  # 「更换配色」入口：点它 → 关闭本窗 → 弹模板选择 → 用新配色重开（倒计时接着走）
  # 注意与倒计时左右错开，两个 Label 重叠时后加的在上面、会把前一个整块遮住。
  $btnTheme = New-Object System.Windows.Forms.Label
  $btnTheme.Text = '更换配色'
  $btnTheme.Font = $fontSmall
  $btnTheme.ForeColor = $C_ACCENT
  $btnTheme.BackColor = $C_WIN
  $btnTheme.TextAlign = 'MiddleRight'
  $btnTheme.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btnTheme.SetBounds(522, 422, 174, 20)
  $btnTheme.Add_Click({ $script:chosen = '__retheme__'; $form.Close() })
  $btnTheme.Add_MouseEnter({ $this.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5, [System.Drawing.FontStyle]::Underline) })
  $btnTheme.Add_MouseLeave({ $this.Font = $fontSmall })
  $shell.Controls.Add($btnTheme)

  # 窗体圆角
  Set-Rounded $form 16

  # ---------- 拖动 ----------
  $onDown = {
    $script:dragOffset = New-Object System.Drawing.Point(
      ([System.Windows.Forms.Cursor]::Position.X - $form.Location.X),
      ([System.Windows.Forms.Cursor]::Position.Y - $form.Location.Y))
  }
  $onMove = {
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:dragOffset) {
      $form.Location = New-Object System.Drawing.Point(
        ([System.Windows.Forms.Cursor]::Position.X - $script:dragOffset.X),
        ([System.Windows.Forms.Cursor]::Position.Y - $script:dragOffset.Y))
    }
  }
  $onUp = { $script:dragOffset = $null }
  $header.Add_MouseDown($onDown); $header.Add_MouseMove($onMove); $header.Add_MouseUp($onUp)
  $lblHead.Add_MouseDown($onDown); $lblHead.Add_MouseMove($onMove); $lblHead.Add_MouseUp($onUp)
  $lblSub.Add_MouseDown($onDown); $lblSub.Add_MouseMove($onMove); $lblSub.Add_MouseUp($onUp)

  # ---------- 倒计时 ----------
  $script:left = $TimeoutSec
  $lblCount.Text = "$($script:left) 秒后默认暂停 $DefaultHours 小时"
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1000
  $timer.Add_Tick({
    $script:left -= 1
    if ($script:left -le 0) {
      $script:chosen = $null
      $timer.Stop()
      $form.Close()
    } else {
      $lblCount.Text = "$($script:left) 秒后默认暂停 $DefaultHours 小时"
    }
  })
  $timer.Start()

  [void]$form.ShowDialog()
  $timer.Stop()
  $form.Dispose()
} catch {
  Write-Output "弹窗失败：$($_.Exception.Message)；按默认时长处理"
  Write-Pause -Hours $DefaultHours -How '弹窗失败默认'
  exit 0
}

if ($script:chosen -eq '__retheme__') {
  # 用户在弹窗里点了「更换配色」：先弹模板选择，再用新配色把弹窗重开，
  # 倒计时按剩余秒数接着走，避免换色就把等待时间清零。
  $leftSec = [Math]::Max(10, [int]$script:left)
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'set-dialog-color.ps1') -PauseFile $pauseFile -ThemeFile $themeFile -PresetsFile $presetFile
  } catch { Write-Output "打开配色选择失败：$($_.Exception.Message)" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
    -Platform $Platform -Reason $Reason -DefaultHours $DefaultHours -TimeoutSec $leftSec
  exit 0
}

if ($null -eq $script:chosen) {
  Write-Pause -Hours $DefaultHours -How '弹窗超时默认'
} elseif ($script:chosen -eq -2) {
  Write-Pause -Hours -1 -How '用户关闭弹窗'
} elseif ($script:chosen -eq -1) {
  Write-Pause -Hours -1 -How '用户选择不暂停'
} elseif ($script:chosen -eq 0) {
  Write-Pause -Hours 0 -How '用户选择停到今天结束'
} else {
  Write-Pause -Hours $script:chosen -How ("用户选择停 {0} 小时" -f $script:chosen)
}
exit 0

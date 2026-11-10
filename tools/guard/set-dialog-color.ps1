# set-dialog-color.ps1 — 切换「平台账号异常」弹窗的配色模板。
#
# 三套内置模板定义在 dialog-theme-presets.json（靛蓝可信 / 青绿清爽 / 石墨蓝专业），
# 本脚本只负责把「用哪一套」或「自定义主色」写进 platform-guard-theme.json。
#
# 用法：
#   powershell -File set-dialog-color.ps1                 # 交互式：选一套或自定义（推荐）
#   powershell -File set-dialog-color.ps1 -List           # 列出可用模板
#   powershell -File set-dialog-color.ps1 -Preset teal    # 直接用某套模板
#   powershell -File set-dialog-color.ps1 -Color 7E57C2   # 自定义主色（派生深浅）
#   powershell -File set-dialog-color.ps1 -Reset          # 恢复默认模板
#   ... 任意命令加 -Preview                                # 立刻弹一次预览
param(
  [string]$Preset = '',
  [string]$Color = '',
  [switch]$Reset,
  [switch]$List,
  [switch]$Preview,
  [string]$PauseFile = '',
  [string]$ThemeFile = '',
  [string]$PresetsFile = ''
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing

$presetFile = if ($PresetsFile) { $PresetsFile } else { Join-Path $PSScriptRoot 'dialog-theme-presets.json' }
$themeFile = if ($ThemeFile) { $ThemeFile } else { Join-Path $PSScriptRoot 'platform-guard-theme.json' }

function Parse-HexColor([string]$hex) {
  $h = "$hex".Trim().TrimStart('#')
  if ($h.Length -eq 3) { $h = '' + $h[0] + $h[0] + $h[1] + $h[1] + $h[2] + $h[2] }
  if ($h -notmatch '^[0-9a-fA-F]{6}$') { return $null }
  return [System.Drawing.Color]::FromArgb(
    [Convert]::ToInt32($h.Substring(0, 2), 16),
    [Convert]::ToInt32($h.Substring(2, 2), 16),
    [Convert]::ToInt32($h.Substring(4, 2), 16))
}

$cfg = $null
if (Test-Path $presetFile) {
  try { $cfg = Get-Content $presetFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
if (-not $cfg) { Write-Output "找不到配色模板文件：$presetFile"; exit 1 }

$defaultName = if ($cfg.default) { "$($cfg.default)" } else { 'slate' }
$presets = $cfg.presets

function Get-PresetNames { return @($presets.PSObject.Properties | ForEach-Object { $_.Name }) }
function Get-PresetObj([string]$n) {
  $p = $presets.PSObject.Properties[$n]
  if ($p) { return $p.Value }
  return $null
}

function Show-List {
  $cur = $null
  if (Test-Path $themeFile) {
    try {
      $t = Get-Content $themeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($t.preset) { $cur = "预设 $($t.preset)" }
      elseif ($t.accent) { $cur = "自定义主色 $($t.accent)" }
    } catch {}
  }
  if (-not $cur) { $cur = "默认（$defaultName）" }
  Write-Output "可用配色模板："
  foreach ($n in (Get-PresetNames)) {
    $o = Get-PresetObj $n
    $mark = if ($n -eq $defaultName) { ' *默认' } else { '' }
    Write-Output ("  {0,-8} {1,-10} 主色 {2}  {3}{4}" -f $n, $o.name, $o.accent, $o.desc, $mark)
  }
  Write-Output ''
  Write-Output "当前使用：$cur"
}

function Save-Theme([string]$presetName, [string]$accentHex) {
  $obj = [ordered]@{ updatedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') }
  if ($presetName) { $obj.preset = $presetName }
  if ($accentHex) { $obj.accent = $accentHex }
  [System.IO.File]::WriteAllText($themeFile, ($obj | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
  if ($presetName) {
    $o = Get-PresetObj $presetName
    Write-Output ("已切换到模板 {0}（{1}，主色 {2}）" -f $presetName, $o.name, $o.accent)
  } else {
    Write-Output "已保存自定义主色 $accentHex"
  }
}

$pausePath = if ($PauseFile) { $PauseFile } else { Join-Path $PSScriptRoot 'platform-pause.json' }

function Invoke-Preview([string]$accentOverride) {
  Write-Output '正在弹出预览（关闭或选择都不会写暂停记录）…'
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'platform-guard.ps1'), '-PauseFile', $pausePath, '-ThemeFile', $themeFile, '-PresetsFile', $presetFile,
    '-Platform', 'preview', '-Reason', '预览：当前配色效果', '-DefaultHours', '1', '-TimeoutSec', '30')
  if ($accentOverride) { $args2 += @('-AccentColor', $accentOverride) }
  & powershell @args2
}

# ---------- 列表 ----------
if ($List) { Show-List; exit 0 }

# ---------- 恢复默认 ----------
if ($Reset) {
  if (Test-Path $themeFile) { Remove-Item $themeFile -Force; Write-Output "已删除主题文件，恢复默认模板 $defaultName" }
  else { Write-Output "本来就是默认模板 $defaultName" }
  if ($Preview) { Invoke-Preview '' }
  exit 0
}

# ---------- 直接指定模板 ----------
if ($Preset) {
  $o = Get-PresetObj $Preset
  if (-not $o) { Write-Output "未知模板「$Preset」。可用：$((Get-PresetNames) -join ', ')"; exit 2 }
  Save-Theme $Preset ''
  if ($Preview) { Invoke-Preview '' }
  exit 0
}

# ---------- 直接指定颜色 ----------
if ($Color) {
  $c = Parse-HexColor $Color
  if (-not $c) { Write-Output "颜色格式无效：$Color（需要 #RRGGBB 或 RRGGBB）"; exit 2 }
  $hex = ('#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B)
  Save-Theme '' $hex
  if ($Preview) { Invoke-Preview $hex }
  exit 0
}

# ---------- 交互式选择 ----------
try {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $C_BG   = [System.Drawing.Color]::FromArgb(243, 245, 250)
  $C_TXT  = [System.Drawing.Color]::FromArgb(29, 39, 64)
  $C_MUT  = [System.Drawing.Color]::FromArgb(117, 128, 152)
  $C_CARD = [System.Drawing.Color]::White
  $C_BD   = [System.Drawing.Color]::FromArgb(220, 226, 239)

  $fMain  = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
  $fSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
  $fBold  = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)

  $result = $null
  $form = New-Object System.Windows.Forms.Form
  $form.Text = '选择弹窗配色'
  $form.ClientSize = New-Object System.Drawing.Size(520, 400)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.BackColor = $C_BG
  $form.Font = $fMain

  $lblH = New-Object System.Windows.Forms.Label
  $lblH.Text = '选择弹窗配色模板'
  $lblH.Font = $fBold
  $lblH.ForeColor = $C_TXT
  $lblH.SetBounds(24, 18, 400, 26)
  $form.Controls.Add($lblH)

  $lblS = New-Object System.Windows.Forms.Label
  $lblS.Text = '三套模板的标题渐变、选中态都是原样色值；选「自定义」则按主色派生。'
  $lblS.Font = $fSmall
  $lblS.ForeColor = $C_MUT
  $lblS.SetBounds(24, 46, 470, 20)
  $form.Controls.Add($lblS)

  $y = 80
  foreach ($n in (Get-PresetNames)) {
    $o = Get-PresetObj $n
    $row = New-Object System.Windows.Forms.Panel
    $row.SetBounds(24, $y, 470, 66)
    $row.BackColor = $C_CARD
    $row.Cursor = [System.Windows.Forms.Cursors]::Hand
    $row.Tag = $n
    $form.Controls.Add($row)

    $chip = New-Object System.Windows.Forms.Panel
    $chip.SetBounds(14, 13, 40, 40)
    $chip.BackColor = (Parse-HexColor $o.accent)
    $chip.Cursor = [System.Windows.Forms.Cursors]::Hand
    $chip.Tag = $n
    $row.Controls.Add($chip)

    $t1 = New-Object System.Windows.Forms.Label
    $t1.Text = $o.name
    $t1.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $t1.ForeColor = $C_TXT
    $t1.SetBounds(68, 10, 300, 22)
    $t1.Cursor = [System.Windows.Forms.Cursors]::Hand
    $t1.Tag = $n
    $row.Controls.Add($t1)

    $t2 = New-Object System.Windows.Forms.Label
    $t2.Text = "$($o.desc)　$($o.accent)"
    $t2.Font = $fSmall
    $t2.ForeColor = $C_MUT
    $t2.SetBounds(68, 34, 380, 20)
    $t2.Cursor = [System.Windows.Forms.Cursors]::Hand
    $t2.Tag = $n
    $row.Controls.Add($t2)

    $pick = {
      $script:pickedPreset = "$($this.Tag)"
      $form.Close()
    }
    $row.Add_Click($pick); $chip.Add_Click($pick); $t1.Add_Click($pick); $t2.Add_Click($pick)
    $row.Add_MouseEnter({ $this.BackColor = [System.Drawing.Color]::FromArgb(238, 242, 250) })
    $row.Add_MouseLeave({ $this.BackColor = $C_CARD })

    $y += 74
  }

  $lblDiv = New-Object System.Windows.Forms.Label
  $lblDiv.Text = '或者'
  $lblDiv.Font = $fSmall
  $lblDiv.ForeColor = $C_MUT
  $lblDiv.SetBounds(24, $y + 4, 60, 18)
  $form.Controls.Add($lblDiv)

  $btnCustom = New-Object System.Windows.Forms.Button
  $btnCustom.Text = '自定义主色…'
  $btnCustom.Font = $fMain
  $btnCustom.FlatStyle = 'Flat'
  $btnCustom.FlatAppearance.BorderSize = 1
  $btnCustom.FlatAppearance.BorderColor = $C_BD
  $btnCustom.BackColor = $C_CARD
  $btnCustom.ForeColor = $C_TXT
  $btnCustom.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btnCustom.SetBounds(84, $y, 160, 32)
  $btnCustom.Add_Click({ $script:pickedPreset = '__custom__'; $form.Close() })
  $form.Controls.Add($btnCustom)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Font = $fMain
  $btnCancel.FlatStyle = 'Flat'
  $btnCancel.FlatAppearance.BorderSize = 1
  $btnCancel.FlatAppearance.BorderColor = $C_BD
  $btnCancel.BackColor = $C_CARD
  $btnCancel.ForeColor = $C_MUT
  $btnCancel.Cursor = [System.Windows.Forms.Cursors]::Hand
  $btnCancel.SetBounds(254, $y, 100, 32)
  $btnCancel.Add_Click({ $script:pickedPreset = ''; $form.Close() })
  $form.Controls.Add($btnCancel)

  $script:pickedPreset = $null
  [void]$form.ShowDialog()
  $result = $script:pickedPreset
  $form.Dispose()
} catch {
  Write-Output "选择窗口打开失败：$($_.Exception.Message)"
  exit 1
}

if (-not $result) { Write-Output '已取消，配色未修改'; exit 0 }

if ($result -eq '__custom__') {
  try {
    $dlg = New-Object System.Windows.Forms.ColorDialog
    $dlg.FullOpen = $true
    $dlg.AnyColor = $true
    $dlg.CustomColors = @(
      [int]0x4E63C2, [int]0x12838D, [int]0x355478,
      [int]0x1E88E5, [int]0x00897B, [int]0x43A047,
      [int]0xE53935, [int]0xFB8C00, [int]0x8E24AA,
      [int]0x546E7A, [int]0x6D4C41, [int]0x00ACC1
    )
    Write-Output '请在弹出的取色盘里选择主色…'
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      $hex = ('#{0:X2}{1:X2}{2:X2}' -f $dlg.Color.R, $dlg.Color.G, $dlg.Color.B)
      Save-Theme '' $hex
      if ($Preview) { Invoke-Preview $hex }
    } else {
      Write-Output '已取消，配色未修改'
    }
  } catch {
    Write-Output "取色盘打开失败：$($_.Exception.Message)"
    exit 1
  }
  exit 0
}

Save-Theme $result ''
if ($Preview) { Invoke-Preview '' }
exit 0

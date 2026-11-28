# choose.ps1 - 无解处置弹窗
#
# 由 oneclick.js 以同步方式调用：
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File choose.ps1 -MsgFile <utf8 path>
#
# stdout 只输出一个数字（0-3），供 node 解析。
# 窗口被直接关闭（X）视为 3 = 退出。

param([string]$MsgFile, [switch]$Confirm, [int]$AutoPick = -1)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$msg = ''
try {
    if ($MsgFile -and (Test-Path -LiteralPath $MsgFile)) {
        $msg = [System.IO.File]::ReadAllText($MsgFile, [System.Text.Encoding]::UTF8)
    }
} catch { $msg = '' }
if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = 'The current board is unsolvable without props.'
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '羊了个羊 · 无可执行方案'
$form.ClientSize = New-Object System.Drawing.Size(560, 412)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 34)
$form.ForeColor = [System.Drawing.Color]::FromArgb(235, 235, 235)

$label = New-Object System.Windows.Forms.Label
$label.Text = $msg
$label.Location = New-Object System.Drawing.Point(24, 18)
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$label.ForeColor = [System.Drawing.Color]::FromArgb(225, 225, 225)
# 正文长短差别很大（有无诊断、有无试算结论），按实际排版量一遍，别把最后几行压在按钮底下
$labelH = 168
try {
    $sz = [System.Windows.Forms.TextRenderer]::MeasureText([string]$msg, $label.Font,
        (New-Object System.Drawing.Size(512, 2000)))
    if ($sz -and $sz.Height -gt 0) {
        $labelH = [Math]::Max(150, [Math]::Min(400, $sz.Height + 8))
    }
} catch { $labelH = 168 }
$label.Size = New-Object System.Drawing.Size(512, $labelH)
$form.Controls.Add($label)

$script:choice = 6

if ($Confirm) {
    # 确认模式：只有一个「继续」按钮，用于等待用户手动完成游戏内操作
    $form.ClientSize = New-Object System.Drawing.Size(560, 300)
    $label.Size = New-Object System.Drawing.Size(512, 180)
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = '已完成，继续'
    $ok.Location = New-Object System.Drawing.Point(24, 216)
    $ok.Size = New-Object System.Drawing.Size(512, 44)
    $ok.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
    $ok.FlatStyle = 'Flat'
    $ok.BackColor = [System.Drawing.Color]::FromArgb(52, 96, 160)
    $ok.ForeColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
    $ok.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(80, 130, 200)
    $ok.Add_Click({
        $f = $this.FindForm()
        $f.Tag = 0
        $f.Close()
    })
    $form.Controls.Add($ok)
} else {
    $items = @(
        @{ text = '使用移出道具     （把手牌前 3 张移到暂存区）'; value = 0 },
        @{ text = '使用洗牌道具     （重排骨面后重新求解，推荐）'; value = 1 },
        @{ text = '默认模式         （不用道具，换种子再试一次）'; value = 2 },
        @{ text = '无限移出 · 开 mod （次数不再受限，按最多 6 次移出重算）'; value = 3 },
        @{ text = '无限撤回 · 开 mod （点错可一直回退，脚本换种子重解）'; value = 4 },
        @{ text = '无限洗牌 · 开 mod （自动连洗最多 12 次，洗到能解为止）'; value = 5 },
        @{ text = '退出脚本         （立即结束，不点击任何牌）'; value = 6 }
    )

    # 窗口高度跟着"正文实高 + 按钮数"走：196 是老的 4 项布局，现在改成算出来的
    $y = 18 + $labelH + 12
    $form.ClientSize = New-Object System.Drawing.Size(560, ($y + $items.Count * 50 + 16))
    foreach ($it in $items) {
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text = $it.text
        $btn.Tag = $it.value
        $btn.Location = New-Object System.Drawing.Point(24, $y)
        $btn.Size = New-Object System.Drawing.Size(512, 42)
        $btn.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
        $btn.FlatStyle = 'Flat'
        $btn.BackColor = [System.Drawing.Color]::FromArgb(52, 52, 56)
        $btn.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 240)
        $btn.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(90, 90, 96)
        $btn.Add_Click({
            $f = $this.FindForm()
            $f.Tag = [int]$this.Tag
            $f.Close()
        })
        $form.Controls.Add($btn)
        $y += 50
    }
}

# -AutoPick 仅用于自动化测试：窗口出现后按索引自动点击某个按钮
if ($AutoPick -ge 0) {
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 900
    $timer.Tag = @{ form = $form; idx = $AutoPick }
    $timer.Add_Tick({
        $st = $this.Tag
        $btns = @($st.form.Controls | Where-Object { $_ -is [System.Windows.Forms.Button] })
        if ($btns.Count -gt $st.idx) { $btns[$st.idx].PerformClick() }
        $this.Stop()
    })
    $timer.Start()
}

[void]$form.ShowDialog()

$result = 3
if ($null -ne $form.Tag) { $result = [int]$form.Tag }
$form.Dispose()

Write-Output $result

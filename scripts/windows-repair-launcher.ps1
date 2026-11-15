[CmdletBinding()]
param(
    [ValidateSet('Scan', 'Install', 'Recover')][string]$Mode = 'Scan',
    [string]$ManifestPath = '',
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Assert-Hash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "缺少文件：$Path" }
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw "校验清单缺少合法 SHA-256：$Path" }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Expected) {
        throw "文件与本次修复构建不一致，已停止：$Path"
    }
}

function Assert-HostsClosed {
    # Read CommandLine only to recognize Node-hosted CLI sessions; never print or persist it.
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $busy = @($processes | Where-Object {
        $_.Name -match '^(Percho|electron)\.exe$' -or
        ($_.Name -match '^node(?:\.exe)?$' -and $_.CommandLine -match '(?i)pi-coding-agent|[\\/]pi[\\/](?:dist|src)[\\/]|[\\/]pi(?:\.m?js)?(?:\s|"|$)')
    })
    if ($busy.Count -gt 0) {
        $labels = ($busy | ForEach-Object { "$($_.Name) (PID $($_.ProcessId))" }) -join ', '
        throw "请正常退出 Percho、开发版及 Pi CLI 后重试。脚本不会强杀进程。当前检测到：$labels"
    }
}

function Assert-Repository($Manifest) {
    if (-not (Test-Path -LiteralPath $Manifest.repositoryRoot -PathType Container)) {
        throw '源码目录已移动或删除。请保留本机 Percho 仓库后重试，不要从网上临时下载依赖。'
    }
    foreach ($item in $Manifest.repositoryFiles) { Assert-Hash $item.path $item.sha256 }
    if (-not (Test-Path -LiteralPath (Join-Path $Manifest.repositoryRoot 'node_modules/esbuild/package.json'))) {
        throw '缺少已安装的仓库依赖，已停止。'
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)\.') { throw '无法确定 Node 版本。' }
    if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 19)) {
        throw '此工具需要 Node >= 22.19。'
    }
    return $node
}

function Invoke-RepairNode([string]$Node, [string[]]$NodeArgs, [string]$LogBase) {
    $stdout = "$LogBase.stdout.log"
    $stderr = "$LogBase.stderr.log"
    $oldPreference = $ErrorActionPreference
    try {
        # Native stderr is logged separately; determine success from the actual exit code.
        $ErrorActionPreference = 'Continue'
        & $Node @NodeArgs 1> $stdout 2> $stderr
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    return [PSCustomObject]@{ ExitCode = $code; Stdout = $stdout; Stderr = $stderr }
}

function New-Scan($Manifest, [string]$Node, [string]$RunDir) {
    $reportFile = Join-Path $RunDir 'reviewed-report.json'
    $cli = Join-Path $Manifest.repositoryRoot 'scripts/recover-session-subagent-relations.mjs'
    $nodeArgs = @($cli, '--agent-dir', $Manifest.agentDir)
    foreach ($target in $Manifest.targets) { $nodeArgs += @('--parent', $target.parentFile) }
    $nodeArgs += @('--report', $reportFile)
    $result = Invoke-RepairNode $Node $nodeArgs (Join-Path $RunDir 'scan')
    if ($result.ExitCode -ne 0) { throw "只读扫描失败，请查看：$($result.Stderr)" }
    $report = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $records = 0
    $children = 0
    Write-Host "`n扫描结果（只读，尚未修改历史）：" -ForegroundColor Cyan
    foreach ($parent in $report.parents) {
        $target = @($Manifest.targets | Where-Object { $_.parentFile -ieq $parent.parentFile })
        if ($target.Count -ne 1) { throw '扫描报告中出现清单外的父会话，已停止。' }
        $count = 0
        foreach ($candidate in $parent.candidates) { $count += @($candidate.record.runs).Count }
        $records += @($parent.candidates).Count
        $children += $count
        Write-Host ("  {0}`n    可补 {1} 个子会话 / {2} 条记录；拒绝 {3} 项；日志缺口 {4} 项；预算问题 {5} 项" -f
            $target[0].name, $count, @($parent.candidates).Count, @($parent.rejected).Count, @($parent.gaps).Count, @($parent.budget).Count)
    }
    Write-Host "`n总计：$records 条记录，$children 个子会话。报告：$reportFile"
    Write-Host '证据不足或冲突的项目不会强行恢复，完整原因在报告中。'
    return [PSCustomObject]@{ File = $reportFile; Records = $records; Children = $children }
}

try {
    if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot 'repair-manifest.json' }
    if ($NonInteractive -and $Mode -ne 'Scan') { throw '非交互模式只允许只读扫描，不能安装或恢复。' }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne 1 -or @($manifest.targets).Count -ne 5) { throw '修复清单格式或会话数量不符。' }
    $base = Split-Path -Parent (Resolve-Path -LiteralPath $ManifestPath).Path
    Write-Host 'Percho v0.7.5 本地会话关系修复' -ForegroundColor Cyan
    Write-Host '版本号仍为 0.7.5；通过安装包和 app.asar 的 SHA-256 确认修复构建。'

    if ($Mode -eq 'Install') {
        Assert-HostsClosed
        $installer = Join-Path $base $manifest.installerFile
        Assert-Hash $installer $manifest.installerSha256
        Write-Host "即将打开安装向导：$installer"
        Write-Host "请保留原安装范围和目录：$($manifest.installDirectory)"
        Write-Host '安装完成时取消“运行 Percho”，稍后还需要在关闭状态恢复旧关联。'
        $process = Start-Process -FilePath $installer -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "安装器退出码 $($process.ExitCode)。请保留弹窗/诊断日志，不要强行覆盖。" }
        Assert-Hash (Join-Path $manifest.installDirectory 'resources/app.asar') $manifest.installedAsarSha256
        Write-Host '安装文件校验通过。请确保 Percho 已退出，再运行“02-扫描并恢复旧关联.cmd”。' -ForegroundColor Green
    } else {
        if ($Mode -eq 'Recover') {
            Assert-HostsClosed
            Assert-Hash (Join-Path $manifest.installDirectory 'resources/app.asar') $manifest.installedAsarSha256
        }
        $node = Assert-Repository $manifest
        $runDir = Join-Path $base ('records/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $runDir -ErrorAction Stop | Out-Null
        Push-Location -LiteralPath $manifest.repositoryRoot
        try {
            $scan = New-Scan $manifest $node $runDir
            if ($Mode -eq 'Scan' -or $scan.Records -eq 0) {
                Write-Host '仅扫描结束，没有写入任何会话。' -ForegroundColor Green
            } else {
                Write-Host "`n恢复会先逐文件备份，只追加关系元数据，不改聊天正文。"
                Write-Host '必须已经退出该目录的所有 Percho / Pi CLI；不要在执行期间重新启动。'
                $answer = Read-Host "确认恢复这 $($scan.Children) 个关联请输入 RESTORE；直接回车取消"
                if ($answer -cne 'RESTORE') {
                    Write-Host '已取消，历史文件没有改动。'
                } else {
                    Assert-HostsClosed
                    Assert-Hash (Join-Path $manifest.installDirectory 'resources/app.asar') $manifest.installedAsarSha256
                    $null = Assert-Repository $manifest
                    $cli = Join-Path $manifest.repositoryRoot 'scripts/recover-session-subagent-relations.mjs'
                    $result = Invoke-RepairNode $node @($cli, '--agent-dir', $manifest.agentDir, '--apply', $scan.File, '--confirm-host-closed') (Join-Path $runDir 'apply')
                    if (Test-Path -LiteralPath $result.Stdout) {
                        $content = Get-Content -LiteralPath $result.Stdout -Raw
                        if ($content) {
                            $applied = $content | ConvertFrom-Json
                            foreach ($item in $applied.results) {
                                Write-Host ("{0}: {1}" -f $item.status, $item.parentFile)
                                if ($item.PSObject.Properties.Name -contains 'backup' -and $item.backup) { Write-Host "  备份：$($item.backup)" }
                            }
                        }
                    }
                    if ($result.ExitCode -ne 0) { throw "恢复有拒绝或失败项，可能部分成功。不要盲目重跑，请保留整个 $runDir 并反馈。" }
                    Write-Host "`n恢复工具执行成功。结果及回滚校验值：$($result.Stdout)" -ForegroundColor Green
                    Write-Host '现在可以打开 Percho，悬停 1029 会话检查子代理列表。请保留 records 目录及备份。'
                }
            }
        } finally { Pop-Location }
    }
    exit 0
} catch {
    Write-Host "`n已停止：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '脚本不会强杀进程、跳过校验或删除历史。请保留日志后反馈。'
    exit 1
}

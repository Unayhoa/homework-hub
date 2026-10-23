#!/usr/bin/env pwsh
# 开发辅助脚本：以 UTF-8 编码运行 CLI 并把输出保存到文件。
#
# 为什么需要它：Windows PowerShell 5.1 默认按 OEM 代码页解码子进程输出，
# 中文会变成乱码；而且原生命令写到 stderr 的内容会被包装成 ErrorRecord，
# 混进输出里。两个问题在这里一次性解决。
#
# 用法：
#   ./scripts/run.ps1 demo          # 跑演示，输出写入 _demo.out.txt
#   ./scripts/run.ps1 list --days 7 # 其他命令直接回显
#
# 注意：这里刻意使用自动变量 $args 而不是自定义 param，
# 因为声明名为 Args 的参数会与 PowerShell 的自动变量冲突。

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# SilentlyContinue 让原生命令的 stderr 作为普通字符串并入管道，而不是 ErrorRecord
$ErrorActionPreference = 'SilentlyContinue'
$env:NODE_NO_WARNINGS = '1'

$node = 'C:\Users\14841\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cliArgs = @($args)
if ($cliArgs.Count -eq 0) { $cliArgs = @('demo') }

$out = & $node 'apps/cli/src/main.ts' @cliArgs 2>&1 | Out-String
$code = $LASTEXITCODE

if ($cliArgs[0] -eq 'demo') {
    Set-Content -Path '_demo.out.txt' -Value $out -Encoding utf8
    Add-Content -Path '_demo.out.txt' -Value "EXIT=$code" -Encoding utf8
    Write-Output "输出已写入 _demo.out.txt（EXIT=$code）"
} else {
    Write-Output $out
}

exit $code

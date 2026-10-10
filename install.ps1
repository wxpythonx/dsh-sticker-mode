<#
.SYNOPSIS
    把 dsh-sticker-mode 安装进 DSH 的 web profile。

.DESCRIPTION
    幂等，改动任何文件前都先备份。做四件事：

      1) 复制插件到   <ProfileDir>\plugins\<PluginName>
      2) 建 junction  <ProfileDir>\node_modules\<PluginName>  ->  上面那个目录
      3) 追加 patch 行 <ProfileDir>\cordis.patch.yml         （insert id: ui-sticker-mode）
      4) 加依赖项     <ProfileDir>\package.json              （file: 依赖）

    为什么用 cordis.patch.yml 的 insert，而不是 package.json 的 dsh.profile.bundles：
      两者**只能选一个** —— 同时注册会以 "duplicate loader entry id" 崩掉 loader。
      本脚本用前者，并且如果发现它已经在 bundles 里会直接报错退出（而不是默默搞坏）。

    安装完需要：**重启 dsh web**，然后**强刷浏览器页面**。
      · bundle 行与插件行只在冷启动时组合（实测新增 insert 行不会热生效）
      · 客户端半边要重新进 boot graph

.EXAMPLE
    pwsh -File .\install.ps1

.EXAMPLE
    # 自定义 profile 位置
    pwsh -File .\install.ps1 -ProfileDir 'D:\tmp\dsh\profiles\web'
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
    [string]$PluginName = 'dsh-sticker-mode',
    [string]$LoaderId = 'ui-sticker-mode'
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = Join-Path $ProfileDir "plugins\$PluginName"
$link = Join-Path $ProfileDir "node_modules\$PluginName"
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$manifest = Join-Path $ProfileDir 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($required in @($src, $patchFile, $manifest, (Join-Path $ProfileDir 'node_modules'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "missing required path: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $src 'package.json'))) {
    throw "$src does not look like the plugin package (no package.json)"
}

# --- 0. 拒绝会崩 loader 的重复注册 -------------------------------------------
$manifestText = Get-Content -LiteralPath $manifest -Raw
if ($manifestText -match 'dsh\.profile' -and $manifestText -match "\`"$PluginName\`"") {
    $bundlesHit = $manifestText -match "(?s)dsh\s*:\s*\{.*?bundles.*?$PluginName"
    if ($bundlesHit) {
        throw @"
$PluginName 已经注册在 dsh.profile.bundles 里了。
本脚本走的是 cordis.patch.yml 的 insert，两者同时存在会
  duplicate loader entry id
直接崩掉 loader。请先从 dsh.profile.bundles 里删掉它，再跑本脚本。
"@
    }
}

# --- 1. 复制插件本体 ----------------------------------------------------------
# 先清空目标目录：源码里删掉的文件否则会残留在 profile 里（曾留下过脏图）。
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
# 策展过程的中间产物（抓取暂存 + 每个标签的对比图）不装进 profile
$staging = Join-Path $dst 'library\_staging'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
Write-Host "copied package  -> $dst"

# --- 2. 让 loader 能解析到它 --------------------------------------------------
if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Recurse -Force }
New-Item -ItemType Junction -Path $link -Target $dst | Out-Null
Write-Host "linked module   -> $link"

# --- 3. patch 行（幂等）------------------------------------------------------
$patchText = Get-Content -LiteralPath $patchFile -Raw
if ($patchText -match [regex]::Escape($LoaderId)) {
    Write-Host "patch row       -> already present, left untouched"
}
else {
    Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$PluginName-$stamp" -Force
    $block = @"

# --- $PluginName (toggle that appends a sticker to every reply) ---
# Dual-face plugin: host half registers the /sticker-mode/* routes, the per-step
# prompt section and the sticker tools; browser half renders the composer toggle
# and serves the vetted local library.
# Remove this block (and the node_modules junction) to uninstall.
- insert:
    - id: $LoaderId
      name: '$PluginName'
"@
    Add-Content -LiteralPath $patchFile -Value $block -Encoding utf8
    Write-Host "patch row       -> appended (backup: $patchFile.bak-$PluginName-$stamp)"
}

# --- 4. 依赖项（幂等）--------------------------------------------------------
if ($manifestText -match [regex]::Escape("`"$PluginName`"")) {
    Write-Host "manifest dep    -> already present, left untouched"
}
else {
    Copy-Item -LiteralPath $manifest -Destination "$manifest.bak-$PluginName-$stamp" -Force
    $editScript = Join-Path ([System.IO.Path]::GetTempPath()) "$PluginName-manifest-$stamp.mjs"
    @'
import { readFileSync, writeFileSync } from 'node:fs'
const [, , file, name] = process.argv
const manifest = JSON.parse(readFileSync(file, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[name] = `file:./plugins/${name}`
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
'@ | Set-Content -LiteralPath $editScript -Encoding utf8
    node $editScript $manifest $PluginName
    Remove-Item -LiteralPath $editScript -Force
    Write-Host "manifest dep    -> added (backup: $manifest.bak-$PluginName-$stamp)"
}

Write-Host ''
Write-Host 'installed. next steps:'
Write-Host '  1) restart dsh web        (the loader row is composed at boot)'
Write-Host '  2) hard-refresh the GUI   (the browser half joins the boot graph on load)'
Write-Host ''
Write-Host 'verify:'
Write-Host "  Invoke-RestMethod http://127.0.0.1:3080/sticker-mode/state"

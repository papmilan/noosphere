#Requires -Version 5.1
<#
.SYNOPSIS
  Windows verification for the SEC-03 filesystem containment boundary.

.DESCRIPTION
  Recreates the SEC-03 attack on Windows: a Noosphere state directory
  (.noosphere / .noosphere/execution / ~/.noosphere) is turned into a symlink or
  a junction (reparse point) pointing outside the project, then each real store
  operation is driven through the branch code. The safety invariant is that the
  operation is refused by the containment guard and, above all, that NOTHING is
  written or re-permissioned outside the intended root.

  This script exercises the actual branch code via a Node probe
  (secure-fs-windows-probe.mjs). It never prints secret material; the only
  outside file is an inert sentinel it creates and then confirms survives.

.NOTES
  Prerequisites:
    - Node.js (a supported version; see docs/security/windows-filesystem-verification.md)
    - git on PATH (the project-state scenario runs `git init`)
    - Run from the repository root or anywhere; paths resolve from this script.
  Symbolic-link creation needs Developer Mode or an elevated shell. Junctions do
  not, so the reparse-point scenarios always run. Symlink scenarios are skipped
  (reported as SKIP, not PASS) when symlink creation is unavailable.

  Exit code: 0 when every executed scenario is SAFE; non-zero otherwise.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Probe    = Join-Path $PSScriptRoot 'secure-fs-windows-probe.mjs'
$WorkRoot = Join-Path $env:TEMP ("noosphere-secfs-" + [System.Guid]::NewGuid().ToString('N'))

$Results = New-Object System.Collections.ArrayList
$Unsafe  = $false

function New-Sentinel {
    param([string]$OutsideDir)
    New-Item -ItemType Directory -Path $OutsideDir -Force | Out-Null
    Set-Content -Path (Join-Path $OutsideDir 'KEEP.txt') -Value 'inert-sentinel' -NoNewline
}

function Test-SymlinkCapability {
    $probeDir = Join-Path $WorkRoot 'symcap'
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    $target = Join-Path $probeDir 'target'
    $link   = Join-Path $probeDir 'link'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    try {
        New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function New-ReparsePoint {
    param([string]$Path, [string]$Target, [ValidateSet('SymbolicLink', 'Junction')][string]$Kind)
    if ($Kind -eq 'Junction') {
        # mklink /J is the most widely available junction creator and needs no
        # elevation. Fall back to New-Item if cmd is unavailable.
        & cmd /c ('mklink /J "{0}" "{1}"' -f $Path, $Target) 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null }
    } else {
        New-Item -ItemType SymbolicLink -Path $Path -Target $Target | Out-Null
    }
}

function Invoke-Scenario {
    param(
        [string]$Label,
        [ValidateSet('project-state', 'execution-state', 'credential')][string]$Scenario,
        [ValidateSet('SymbolicLink', 'Junction')][string]$Kind,
        [string]$LinkName = '.noosphere'
    )

    $caseDir = Join-Path $WorkRoot ($Label -replace '[^A-Za-z0-9]', '_')
    $repo    = Join-Path $caseDir 'repo'
    $outside = Join-Path $caseDir 'OUT'
    New-Item -ItemType Directory -Path $repo -Force | Out-Null
    New-Sentinel -OutsideDir $outside

    if ($Scenario -eq 'project-state') {
        & git -C $repo init -q 2>&1 | Out-Null
        & git -C $repo -c user.email=t@t -c user.name=t commit --allow-empty -q -m x 2>&1 | Out-Null
    }

    New-ReparsePoint -Path (Join-Path $repo $LinkName) -Target $outside -Kind $Kind

    $stdout = & node $Probe $Scenario $repo $outside $RepoRoot 2>$null
    $exit   = $LASTEXITCODE

    $parsed = $null
    try { $parsed = $stdout | ConvertFrom-Json } catch { }

    $outsideFiles = @(Get-ChildItem -Force -Path $outside | Select-Object -ExpandProperty Name)
    $sentinelOnly = ($outsideFiles.Count -eq 1) -and ($outsideFiles[0] -eq 'KEEP.txt')
    $safe = ($exit -eq 0) -and $sentinelOnly -and $parsed -and $parsed.safe

    if (-not $safe) { $script:Unsafe = $true }

    $refused  = $false
    $boundary = $false
    $code     = 'no-json'
    if ($parsed) {
        $refused  = [bool]$parsed.refused
        $boundary = [bool]$parsed.boundaryError
        $code     = $parsed.code
    }
    $result = if ($safe) { 'PASS' } else { 'FAIL' }

    [void]$Results.Add([pscustomobject]@{
        Scenario = $Label
        Link     = $Kind
        Refused  = $refused
        Boundary = $boundary
        Code     = $code
        Sentinel = $sentinelOnly
        Result   = $result
    })
}

function Add-Skip {
    param([string]$Label, [string]$Reason)
    [void]$Results.Add([pscustomobject]@{
        Scenario = $Label; Link = 'SymbolicLink'; Refused = $false; Boundary = $false
        Code = $Reason; Sentinel = $true; Result = 'SKIP'
    })
}

try {
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    $symlinksOk = Test-SymlinkCapability
    $symState = if ($symlinksOk) { 'available' } else { 'unavailable (junction-only)' }

    Write-Host "Noosphere SEC-03 Windows filesystem verification"
    Write-Host "repo root : $RepoRoot"
    Write-Host "symlinks  : $symState"
    Write-Host ""

    # Reparse-point (junction) scenarios always run.
    Invoke-Scenario -Label 'ACP Project State (junction)'  -Scenario 'project-state'   -Kind 'Junction'
    Invoke-Scenario -Label 'Execution State (junction)'    -Scenario 'execution-state' -Kind 'Junction'
    Invoke-Scenario -Label 'Credential store (junction)'   -Scenario 'credential'      -Kind 'Junction'

    # Case-insensitive path handling: link named .NOOSPHERE, code uses .noosphere.
    Invoke-Scenario -Label 'ACP Project State (case-insensitive)' -Scenario 'project-state' -Kind 'Junction' -LinkName '.NOOSPHERE'

    # Symbolic-link scenarios when the platform permits creating them.
    if ($symlinksOk) {
        Invoke-Scenario -Label 'ACP Project State (symlink)' -Scenario 'project-state'   -Kind 'SymbolicLink'
        Invoke-Scenario -Label 'Execution State (symlink)'   -Scenario 'execution-state' -Kind 'SymbolicLink'
        Invoke-Scenario -Label 'Credential store (symlink)'  -Scenario 'credential'      -Kind 'SymbolicLink'
    } else {
        Add-Skip -Label 'ACP Project State (symlink)' -Reason 'symlink-create-denied'
        Add-Skip -Label 'Execution State (symlink)'   -Reason 'symlink-create-denied'
        Add-Skip -Label 'Credential store (symlink)'  -Reason 'symlink-create-denied'
    }

    $Results | Format-Table -AutoSize | Out-String | Write-Host

    $fail = @($Results | Where-Object { $_.Result -eq 'FAIL' }).Count
    $skip = @($Results | Where-Object { $_.Result -eq 'SKIP' }).Count
    $pass = @($Results | Where-Object { $_.Result -eq 'PASS' }).Count
    Write-Host ("PASS={0}  FAIL={1}  SKIP={2}" -f $pass, $fail, $skip)

    if ($Unsafe) {
        Write-Host "RESULT: UNSAFE — a state store wrote outside its root or the guard did not refuse." -ForegroundColor Red
        exit 1
    }
    if ($skip -gt 0) {
        Write-Host "RESULT: SAFE for executed scenarios; symlink scenarios SKIPPED (enable Developer Mode to cover them)." -ForegroundColor Yellow
        exit 0
    }
    Write-Host "RESULT: SAFE — all scenarios refused and contained." -ForegroundColor Green
    exit 0
}
finally {
    if (Test-Path $WorkRoot) {
        # Remove reparse points without following them into the outside targets.
        Get-ChildItem -Path $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } |
            ForEach-Object { & cmd /c ('rmdir "{0}"' -f $_.FullName) 2>&1 | Out-Null }
        Remove-Item -Path $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

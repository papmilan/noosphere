param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('write', 'read', 'repair', 'verify', 'write-sids', 'sid', 'copy-acl')]
  [string]$Action,

  [Parameter(Mandatory = $false, Position = 1)]
  [string]$LiteralPath,

  [Parameter(Mandatory = $false, Position = 2)]
  [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Code, [string]$Message) {
  [Console]::Error.WriteLine("NOOSPHERE_ACL_ERROR:${Code}:$Message")
  exit 1
}

function Current-UserSid {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.User.Value)) {
      Fail 'state-acl-sid-failed' 'the current process token has no user SID'
    }
    return $identity.User
  } catch {
    Fail 'state-acl-sid-failed' $_.Exception.Message
  }
}

function Allowed-Sids {
  $user = Current-UserSid
  return @(
    $user,
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
}

function Set-ExactOwnerOnlyAcl([string]$Path) {
  try {
    $allowed = Allowed-Sids
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowed) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      [void]$security.AddAccessRule($rule)
    }
    [System.IO.File]::SetAccessControl($Path, $security)
  } catch {
    Fail 'state-acl-mutation-failed' $_.Exception.Message
  }
}

function Verify-ExactOwnerOnlyAcl([string]$Path) {
  try {
    $allowed = Allowed-Sids
    $allowedValues = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in $allowed) { [void]$allowedValues.Add($sid.Value) }

    $security = [System.IO.File]::GetAccessControl(
      $Path,
      [System.Security.AccessControl.AccessControlSections]::Access
    )
    $rules = @($security.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))

    if ($rules.Count -ne $allowedValues.Count) {
      Fail 'state-acl-broad' "expected exactly $($allowedValues.Count) access rules, found $($rules.Count)"
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in $rules) {
      $sid = ([System.Security.Principal.SecurityIdentifier]$rule.IdentityReference).Value
      if ($rule.IsInherited) { Fail 'state-acl-broad' "inherited ACE remains for SID $sid" }
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        Fail 'state-acl-broad' "non-allow ACE remains for SID $sid"
      }
      if (-not $allowedValues.Contains($sid)) { Fail 'state-acl-broad' "unexpected grant SID $sid" }
      if (-not $seen.Add($sid)) { Fail 'state-acl-broad' "duplicate grant SID $sid" }
      $full = [System.Security.AccessControl.FileSystemRights]::FullControl
      if (($rule.FileSystemRights -band $full) -ne $full) {
        Fail 'state-acl-incomplete' "SID $sid does not have FullControl"
      }
    }
    foreach ($sid in $allowedValues) {
      if (-not $seen.Contains($sid)) { Fail 'state-acl-incomplete' "required SID $sid is absent" }
    }
    return $seen
  } catch {
    if ($_.Exception.Message -like 'NOOSPHERE_ACL_ERROR:*') { throw }
    Fail 'state-acl-readback-failed' $_.Exception.Message
  }
}

# SEC-05 Phase 4C Finding 4 — the Windows mirror of the POSIX `mode & 0o022`
# destination check.
#
# A restore destination is a REPOSITORY file, not owner-only state: it inherits
# the repository's ACL by design, exactly as a POSIX repository file keeps its
# 0644 mode. Verify-ExactOwnerOnlyAcl is the wrong question for it — it refuses
# every inherited ACE, so it refuses every real repository file.
#
# The right question is the POSIX one: can any principal OTHER than the file's
# owner modify it? So this action reports facts and leaves the policy to the
# caller — the owner SID, then one line per distinct SID holding a write-ish
# right through an Allow ACE. Inherited ACEs are included; inheritance is not
# the hazard, foreign write is.
#
# Deny ACEs are skipped because a Deny can only remove access, never grant it.
$WriteMask =
  [int][System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [int][System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [int][System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [int][System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [int][System.Security.AccessControl.FileSystemRights]::Delete -bor
  [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership

function Report-WriteSids([string]$Path) {
  try {
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('owner:' + (Current-UserSid).Value)

    $security = [System.IO.File]::GetAccessControl(
      $Path,
      [System.Security.AccessControl.AccessControlSections]::Access
    )
    $rules = @($security.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if ((([int]$rule.FileSystemRights) -band $WriteMask) -eq 0) { continue }
      $sid = ([System.Security.Principal.SecurityIdentifier]$rule.IdentityReference).Value
      if ($seen.Add($sid)) { $lines.Add('write:' + $sid) }
    }
    return $lines
  } catch {
    if ($_.Exception.Message -like 'NOOSPHERE_ACL_ERROR:*') { throw }
    Fail 'state-acl-readback-failed' $_.Exception.Message
  }
}

if ($Action -eq 'sid') {
  [Console]::Out.Write((Current-UserSid).Value)
  exit 0
}

if ([string]::IsNullOrWhiteSpace($LiteralPath)) {
  Fail 'state-acl-failed' 'a literal file path is required'
}

$stream = $null
try {
  if ($Action -eq 'copy-acl') {
    if ([string]::IsNullOrWhiteSpace($SourcePath)) {
      Fail 'state-acl-copy-failed' 'a source file path is required'
    }
    try {
      $sections = [System.Security.AccessControl.AccessControlSections]::Access
      $sourceSecurity = [System.IO.File]::GetAccessControl(
        $SourcePath,
        $sections
      )
      $sddl = $sourceSecurity.GetSecurityDescriptorSddlForm($sections)
      $destinationSecurity = [System.Security.AccessControl.FileSecurity]::new()
      $destinationSecurity.SetSecurityDescriptorSddlForm($sddl, $sections)
      [System.IO.File]::SetAccessControl($LiteralPath, $destinationSecurity)
      exit 0
    } catch {
      Fail 'state-acl-copy-failed' $_.Exception.Message
    }
  }

  if ($Action -eq 'write') {
    try {
      $stream = [System.IO.FileStream]::new(
        $LiteralPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None,
        4096,
        [System.IO.FileOptions]::WriteThrough
      )
    } catch [System.IO.IOException] {
      if ([System.IO.File]::Exists($LiteralPath)) {
        Fail 'state-file-exists' 'the exclusive secure file already exists'
      }
      throw
    }
    if ($stream.Length -ne 0) { Fail 'state-write-incomplete' 'new secure file is not empty' }
    Set-ExactOwnerOnlyAcl $LiteralPath
    [void](Verify-ExactOwnerOnlyAcl $LiteralPath)
    $inputStream = [Console]::OpenStandardInput()
    $inputStream.CopyTo($stream)
    $stream.Flush($true)
    exit 0
  }

  if ($Action -eq 'read') {
    $stream = [System.IO.FileStream]::new(
      $LiteralPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
    Set-ExactOwnerOnlyAcl $LiteralPath
    [void](Verify-ExactOwnerOnlyAcl $LiteralPath)
    $stream.Position = 0
    $outputStream = [Console]::OpenStandardOutput()
    $stream.CopyTo($outputStream)
    $outputStream.Flush()
    exit 0
  }

  if ($Action -eq 'repair') {
    Set-ExactOwnerOnlyAcl $LiteralPath
    [void](Verify-ExactOwnerOnlyAcl $LiteralPath)
    exit 0
  }

  if ($Action -eq 'verify') {
    $verified = Verify-ExactOwnerOnlyAcl $LiteralPath
    [Console]::Out.Write((@($verified) | Sort-Object) -join "`n")
    exit 0
  }

  if ($Action -eq 'write-sids') {
    $reported = Report-WriteSids $LiteralPath
    [Console]::Out.Write((@($reported)) -join "`n")
    exit 0
  }
} catch {
  Fail 'state-acl-failed' $_.Exception.Message
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('write', 'read', 'repair', 'verify', 'write-sids', 'sid', 'copy-acl', 'serve')]
  [string]$Action,

  [Parameter(Mandatory = $false, Position = 1)]
  [string]$LiteralPath,

  [Parameter(Mandatory = $false, Position = 2)]
  [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Every refusal in this script is one of these tagged strings, and the tag is the
# contract the Node side parses. `Fail` throws rather than exits because `serve`
# answers many requests from one process: an exiting refusal would take the host
# down with it and turn a single refused file into a dead session. The one-shot
# driver at the bottom turns the throw back into the historical
# "stderr line + exit 1", so single-invocation behaviour is unchanged.
$ErrorTag = 'NOOSPHERE_ACL_ERROR:'

function Fail([string]$Code, [string]$Message) {
  throw "${ErrorTag}${Code}:$Message"
}

# A catch block must never re-wrap an already-tagged refusal: the first tag names
# the real cause (`state-acl-sid-failed`), and wrapping it would relabel it as
# whatever the outer block happens to be about (`state-acl-mutation-failed`).
function Is-Tagged([string]$Message) {
  return $Message -like "${ErrorTag}*"
}

function Current-UserSid {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.User.Value)) {
      Fail 'state-acl-sid-failed' 'the current process token has no user SID'
    }
    return $identity.User
  } catch {
    if (Is-Tagged $_.Exception.Message) { throw }
    Fail 'state-acl-sid-failed' $_.Exception.Message
  }
}

# The process token cannot change identity for the life of the process, so the
# owner SID is resolved once. `serve` answers thousands of requests from one
# process and every one of them needs this triple; re-deriving it per request
# was pure waste. A one-shot invocation resolves it exactly once either way.
$script:AllowedSidsCache = $null

function Allowed-Sids {
  if ($null -eq $script:AllowedSidsCache) {
    $user = Current-UserSid
    $script:AllowedSidsCache = @(
      $user,
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
  }
  return $script:AllowedSidsCache
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
    if (Is-Tagged $_.Exception.Message) { throw }
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
    if (Is-Tagged $_.Exception.Message) { throw }
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
    if (Is-Tagged $_.Exception.Message) { throw }
    Fail 'state-acl-readback-failed' $_.Exception.Message
  }
}

# The transport bound. `read` in serve mode frames a whole response, so it
# buffers the file; the one-shot path is bounded by the Node side's 16 MiB
# maxBuffer, and this keeps the two paths refusing the same sizes.
$TransportLimit = 16777216

function Write-Utf8([System.IO.Stream]$Stream, [string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  if ($bytes.Length -gt 0) { $Stream.Write($bytes, 0, $bytes.Length) }
}

# One action, one place, both transports. `serve` and the one-shot driver differ
# only in which streams they hand in and how they report a refusal — never in
# what is applied or verified.
function Invoke-AclAction {
  param(
    [string]$Name,
    [string]$Path,
    [string]$Source,
    [System.IO.Stream]$InputStream,
    [System.IO.Stream]$OutputStream
  )

  if ($Name -eq 'sid') {
    Write-Utf8 $OutputStream (Current-UserSid).Value
    return
  }

  if ([string]::IsNullOrWhiteSpace($Path)) {
    Fail 'state-acl-failed' 'a literal file path is required'
  }

  $stream = $null
  try {
    if ($Name -eq 'copy-acl') {
      if ([string]::IsNullOrWhiteSpace($Source)) {
        Fail 'state-acl-copy-failed' 'a source file path is required'
      }
      try {
        $sections = [System.Security.AccessControl.AccessControlSections]::Access
        $sourceSecurity = [System.IO.File]::GetAccessControl(
          $Source,
          $sections
        )
        $sddl = $sourceSecurity.GetSecurityDescriptorSddlForm($sections)
        $destinationSecurity = [System.Security.AccessControl.FileSecurity]::new()
        $destinationSecurity.SetSecurityDescriptorSddlForm($sddl, $sections)
        [System.IO.File]::SetAccessControl($Path, $destinationSecurity)
        return
      } catch {
        if (Is-Tagged $_.Exception.Message) { throw }
        Fail 'state-acl-copy-failed' $_.Exception.Message
      }
    }

    if ($Name -eq 'write') {
      try {
        $stream = [System.IO.FileStream]::new(
          $Path,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::ReadWrite,
          [System.IO.FileShare]::None,
          4096,
          [System.IO.FileOptions]::WriteThrough
        )
      } catch [System.IO.IOException] {
        if ([System.IO.File]::Exists($Path)) {
          Fail 'state-file-exists' 'the exclusive secure file already exists'
        }
        throw
      }
      if ($stream.Length -ne 0) { Fail 'state-write-incomplete' 'new secure file is not empty' }
      Set-ExactOwnerOnlyAcl $Path
      [void](Verify-ExactOwnerOnlyAcl $Path)
      $InputStream.CopyTo($stream)
      $stream.Flush($true)
      return
    }

    if ($Name -eq 'read') {
      $stream = [System.IO.FileStream]::new(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
      )
      Set-ExactOwnerOnlyAcl $Path
      [void](Verify-ExactOwnerOnlyAcl $Path)
      if ($stream.Length -gt $TransportLimit) {
        Fail 'state-acl-failed' "secure read exceeds the $TransportLimit-byte transport bound"
      }
      $stream.Position = 0
      $stream.CopyTo($OutputStream)
      return
    }

    if ($Name -eq 'repair') {
      Set-ExactOwnerOnlyAcl $Path
      [void](Verify-ExactOwnerOnlyAcl $Path)
      return
    }

    if ($Name -eq 'verify') {
      $verified = Verify-ExactOwnerOnlyAcl $Path
      Write-Utf8 $OutputStream ((@($verified) | Sort-Object) -join "`n")
      return
    }

    if ($Name -eq 'write-sids') {
      $reported = Report-WriteSids $Path
      Write-Utf8 $OutputStream ((@($reported)) -join "`n")
      return
    }

    Fail 'state-acl-failed' "unsupported action: $Name"
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Tagged-Message([string]$Message) {
  if (Is-Tagged $Message) { return $Message }
  return "${ErrorTag}state-acl-failed:$Message"
}

# ---------------------------------------------------------------------------
# serve: one process, many requests.
#
# PowerShell startup — loading the CLR, the engine, and the assemblies these ACL
# calls need — costs orders of magnitude more than the ACL calls themselves, and
# the restore paths perform many file operations per transaction. So the host
# pays startup once and then answers framed requests over its own stdin/stdout.
# The trust boundary is unchanged: this is the same script, spawned the same way
# by the same parent, talking over the same kind of pipe execFileSync uses. No
# file, socket, or shared directory is introduced that a third party could write.
#
# Framing, both directions: one ASCII header line terminated by LF, then exactly
# the declared number of raw payload bytes.
#   request   "<id> <action> <payloadLength> <base64Path> <base64Source>\n" + payload
#   response  "<id> ok <length>\n"  + payload
#             "<id> err <length>\n" + tagged UTF-8 refusal
# Paths travel base64-encoded so a path containing a space or a newline cannot
# shift a field. The id is echoed so the caller can detect a desynchronised
# stream rather than match an answer to the wrong question.
# ---------------------------------------------------------------------------

function Read-HeaderLine([System.IO.Stream]$Stream) {
  $bytes = [System.Collections.Generic.List[byte]]::new()
  while ($true) {
    $next = $Stream.ReadByte()
    if ($next -lt 0) {
      # EOF between requests is the parent closing the pipe: shut down.
      if ($bytes.Count -eq 0) { return $null }
      throw 'serve request header was truncated'
    }
    if ($next -eq 10) { break }
    $bytes.Add([byte]$next)
    if ($bytes.Count -gt 8192) { throw 'serve request header exceeded 8192 bytes' }
  }
  return [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
}

function Read-Exactly([System.IO.Stream]$Stream, [int]$Count) {
  $buffer = [byte[]]::new($Count)
  $read = 0
  while ($read -lt $Count) {
    $chunk = $Stream.Read($buffer, $read, $Count - $read)
    if ($chunk -le 0) { throw 'serve request payload was truncated' }
    $read += $chunk
  }
  # The leading comma is load-bearing. PowerShell unrolls a collection on return,
  # so a zero-byte payload — which is what `verify`, `write-sids`, `read` and
  # `sid` all send — would come back as $null, and a one-byte payload as a bare
  # byte. Wrapping keeps it a byte[] at every length.
  return ,$buffer
}

function Write-Frame([System.IO.Stream]$Stream, [string]$Id, [string]$Status, [byte[]]$Body) {
  $header = [System.Text.Encoding]::ASCII.GetBytes("$Id $Status $($Body.Length)`n")
  $Stream.Write($header, 0, $header.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

function Decode-Field([string]$Value) {
  if ($Value -eq '-') { return '' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

if ($Action -eq 'serve') {
  $requestStream = [System.IO.BufferedStream]::new([Console]::OpenStandardInput(), 65536)
  $responseStream = [Console]::OpenStandardOutput()
  # Resolve the owner SID before the first request so a broken process token
  # fails the host immediately rather than one arbitrary request later.
  [void](Allowed-Sids)
  try {
    while ($true) {
      $header = Read-HeaderLine $requestStream
      if ($null -eq $header) { break }
      $fields = $header.Split(' ')
      if ($fields.Count -ne 5) { throw "serve request header had $($fields.Count) fields, expected 5" }
      $id = $fields[0]
      $name = $fields[1]
      $length = [int]::Parse($fields[2], [System.Globalization.CultureInfo]::InvariantCulture)
      if ($length -lt 0 -or $length -gt $TransportLimit) {
        throw "serve request payload length $length is out of range"
      }
      $payload = Read-Exactly $requestStream $length
      $body = [byte[]]::new(0)
      $status = 'ok'
      $buffer = [System.IO.MemoryStream]::new()
      $payloadStream = [System.IO.MemoryStream]::new($payload, $false)
      try {
        [void](Invoke-AclAction `
          -Name $name `
          -Path (Decode-Field $fields[3]) `
          -Source (Decode-Field $fields[4]) `
          -InputStream $payloadStream `
          -OutputStream $buffer)
        $body = $buffer.ToArray()
      } catch {
        $status = 'err'
        $body = [System.Text.Encoding]::UTF8.GetBytes((Tagged-Message $_.Exception.Message))
      } finally {
        $payloadStream.Dispose()
        $buffer.Dispose()
      }
      Write-Frame $responseStream $id $status $body
    }
    exit 0
  } catch {
    # A framing fault is not a refusal of one file — the stream is no longer
    # trustworthy, so the host dies and the caller falls back to one-shot
    # invocations rather than risking a mismatched answer.
    [Console]::Error.WriteLine((Tagged-Message $_.Exception.Message))
    exit 1
  }
}

# One-shot: historical behaviour, byte for byte. A tagged refusal goes to stderr
# and the process exits 1; anything untagged is wrapped as state-acl-failed.
try {
  $inputStream = if ($Action -eq 'write') { [Console]::OpenStandardInput() } else { [System.IO.Stream]::Null }
  $outputStream = [Console]::OpenStandardOutput()
  [void](Invoke-AclAction `
    -Name $Action `
    -Path $LiteralPath `
    -Source $SourcePath `
    -InputStream $inputStream `
    -OutputStream $outputStream)
  $outputStream.Flush()
  exit 0
} catch {
  [Console]::Error.WriteLine((Tagged-Message $_.Exception.Message))
  exit 1
}

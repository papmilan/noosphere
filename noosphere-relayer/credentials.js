import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertContainedChainSync, ensureContainedDirSync, readFileNoFollowSync, writeFileNoFollowSync } from './secure-fs.js';

const SERVICE_NAME = 'noosphere';
const CREDENTIAL_KEYS = [
  'MEMWAL_ACCOUNT_ID',
  'MEMWAL_PRIVATE_KEY',
  'MEMWAL_NETWORK',
];

// Only the delegate key is a secret; the account id and network are
// identifiers and stay in the owner-only .env. On macOS this is not merely
// tidier, it is the only workable shape: `security`'s safe prompt truncates at
// 128 bytes, and a full three-field payload is around 205, so storing all of
// them cannot use Apple's secure input path at all — the alternative is
// publishing the key in argv, which Apple's own help calls insecure.
//
// Reads stay tolerant of the legacy full payload, so installs that already
// stored all three keep working untouched.
export const SECRET_CREDENTIAL_KEYS = ['MEMWAL_PRIVATE_KEY'];

export function toStoredCredentialPayload(credentials) {
  const stored = {};
  for (const key of SECRET_CREDENTIAL_KEYS) {
    const value = credentials?.[key];
    if (typeof value === 'string' && value) stored[key] = value;
  }
  if (!stored.MEMWAL_PRIVATE_KEY) {
    throw new Error('A delegate private key is required');
  }
  return JSON.stringify(stored);
}

export class CredentialStore {
  constructor(
    account = 'default',
    {
      platform = process.platform,
      home = os.homedir(),
      run = spawnSync,
      secureFileOptions = {},
    } = {},
  ) {
    this.account = account;
    this.platform = platform;
    this.run = run;
    this.home = home;
    this.secureFileOptions = secureFileOptions;
    this.fallbackPath = path.join(
      home,
      '.noosphere',
      `credentials-${account}.json`,
    );
  }

  setPassword(secret) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('Credential payload must be a non-empty string');
    }

    if (this.platform === 'darwin') {
      // `-w` with no value makes security prompt twice — "password data for
      // new item:" then "retype password for new item:" — so a single line on
      // stdin hits EOF on the retype, security reports "passwords don't match",
      // stores nothing, and still exits 0. The write silently did nothing and
      // no exit status revealed it; only the readback in migrateEnvironmentFile
      // caught it, and only after the caller had been told the write succeeded.
      // Answer both prompts.
      //
      // The secret stays on stdin rather than moving into `-w <value>`, which
      // would work but publish it in the process arguments for any `ps` on the
      // machine to read.
      this.#runChecked(
        '/usr/bin/security',
        [
          'add-generic-password',
          '-U',
          '-a',
          this.account,
          '-s',
          SERVICE_NAME,
          '-w',
        ],
        { input: `${secret}\n${secret}\n` },
      );
      return { backend: 'macos-keychain', encryptedAtRest: true };
    }

    if (this.platform === 'win32') {
      this.#ensureDirectory();
      const dpapiPath = `${this.fallbackPath}.dpapi`;
      const tmpPath = `${dpapiPath}.tmp`;
      const secretB64 = Buffer.from(secret, 'utf8').toString('base64');
      // Secret travels via env var instead of stdin: PowerShell stdin
      // redirection with -EncodedCommand has been observed to drop input
      // on Windows, producing a 0-byte ciphertext file. Env var + atomic
      // temp+move + $ErrorActionPreference='Stop' guarantees we either
      // write a complete file or fail loudly.
      const script = [
        '$ErrorActionPreference = "Stop"',
        // PowerShell 5.1 does not load System.Security by default, so
        // [System.Security.Cryptography.ProtectedData] is not resolvable
        // ("Unable to find type") and the call silently never runs without
        // ErrorAction=Stop. Load the assembly explicitly.
        'Add-Type -AssemblyName System.Security',
        '$secretB64 = $env:NOOSPHERE_CREDENTIAL_SECRET_B64',
        'if (-not $secretB64) { throw "NOOSPHERE_CREDENTIAL_SECRET_B64 is empty" }',
        '$bytes = [Convert]::FromBase64String($secretB64)',
        'if ($bytes.Length -eq 0) { throw "Decoded secret payload is empty" }',
        '$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(',
        '  $bytes, $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ')',
        'if (-not $encrypted -or $encrypted.Length -eq 0) { throw "DPAPI Protect returned empty ciphertext" }',
        '$value = [Convert]::ToBase64String($encrypted)',
        'if ([string]::IsNullOrEmpty($value)) { throw "Base64-encoded ciphertext is empty" }',
        '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
        '[IO.File]::WriteAllText($env:NOOSPHERE_CREDENTIAL_TMP, $value, $utf8NoBom)',
        '$tmpInfo = Get-Item -LiteralPath $env:NOOSPHERE_CREDENTIAL_TMP',
        'if ($tmpInfo.Length -eq 0) { throw "Wrote 0 bytes to temp file" }',
        'Move-Item -LiteralPath $env:NOOSPHERE_CREDENTIAL_TMP -Destination $env:NOOSPHERE_CREDENTIAL_PATH -Force',
      ].join('\n');
      try {
        this.#runPowerShell(script, {
          env: {
            ...process.env,
            NOOSPHERE_CREDENTIAL_PATH: dpapiPath,
            NOOSPHERE_CREDENTIAL_TMP: tmpPath,
            NOOSPHERE_CREDENTIAL_SECRET_B64: secretB64,
          },
        });
      } catch (error) {
        // Surface as much detail as possible and never leave a stale 0-byte
        // file behind that would mask the failure on the next read.
        this.#cleanupZeroByte(dpapiPath);
        fs.rmSync(tmpPath, { force: true });
        throw error;
      }

      let stat;
      try {
        stat = fs.statSync(dpapiPath);
      } catch (error) {
        throw new Error(
          `DPAPI write reported success but produced no file at ${dpapiPath}: ${error.message}`,
        );
      }
      if (stat.size === 0) {
        fs.rmSync(dpapiPath, { force: true });
        fs.rmSync(tmpPath, { force: true });
        throw new Error(
          `DPAPI write produced a 0-byte file at ${dpapiPath}; refusing to leave it on disk`,
        );
      }

      return { backend: 'windows-dpapi', encryptedAtRest: true };
    }

    if (this.platform === 'linux' && this.#hasSecretTool()) {
      try {
        this.#runChecked(
          'secret-tool',
          [
            'store',
            '--label=Noosphere Credentials',
            'service',
            SERVICE_NAME,
            'account',
            this.account,
          ],
          { input: secret },
        );
        fs.rmSync(this.fallbackPath, { force: true });
        return { backend: 'linux-secret-service', encryptedAtRest: true };
      } catch {
        // Headless Linux often has secret-tool installed without a running
        // Secret Service. Use the documented owner-only fallback in that case.
      }
    }

    this.#fallbackStore(secret);
    return { backend: 'owner-only-file', encryptedAtRest: false };
  }

  getPassword() {
    try {
      if (this.platform === 'darwin') {
        return this.#runChecked(
          '/usr/bin/security',
          [
            'find-generic-password',
            '-a',
            this.account,
            '-s',
            SERVICE_NAME,
            '-w',
          ],
        ).stdout.trim() || null;
      }

      if (this.platform === 'win32') {
        const dpapiPath = `${this.fallbackPath}.dpapi`;
        if (!fs.existsSync(dpapiPath)) return null;
        // A 0-byte file is a partial-write artifact, not a valid credential.
        // Remove it so callers report "no credentials" instead of "corrupt
        // credentials" and so the next setPassword starts from a clean slate.
        if (this.#cleanupZeroByte(dpapiPath)) return null;
        const script = [
          '$ErrorActionPreference = "Stop"',
          // System.Security must be loaded explicitly under PowerShell 5.1;
          // otherwise ProtectedData is "Unable to find type".
          'Add-Type -AssemblyName System.Security',
          '$value = Get-Content -Raw -LiteralPath $env:NOOSPHERE_CREDENTIAL_PATH',
          '$encrypted = [Convert]::FromBase64String($value.Trim())',
          '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(',
          '  $encrypted, $null,',
          '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
          ')',
          '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
        ].join('\n');
        return this.#runPowerShell(script, {
          env: {
            ...process.env,
            NOOSPHERE_CREDENTIAL_PATH: dpapiPath,
          },
        }).stdout || null;
      }

      if (this.platform === 'linux' && this.#hasSecretTool()) {
        const result = this.run(
          'secret-tool',
          ['lookup', 'service', SERVICE_NAME, 'account', this.account],
          textOptions(),
        );
        if (result.status === 0 && result.stdout.trim()) {
          return result.stdout.trim();
        }
      }

      return this.#fallbackGet();
    } catch {
      return null;
    }
  }

  deletePassword() {
    try {
      if (this.platform === 'darwin') {
        this.run(
          '/usr/bin/security',
          [
            'delete-generic-password',
            '-a',
            this.account,
            '-s',
            SERVICE_NAME,
          ],
          textOptions(),
        );
      } else if (this.platform === 'win32') {
        fs.rmSync(`${this.fallbackPath}.dpapi`, { force: true });
      } else if (this.platform === 'linux' && this.#hasSecretTool()) {
        this.run(
          'secret-tool',
          ['clear', 'service', SERVICE_NAME, 'account', this.account],
          textOptions(),
        );
        fs.rmSync(this.fallbackPath, { force: true });
      } else {
        fs.rmSync(this.fallbackPath, { force: true });
      }
    } catch {
      // Deleting an absent credential is idempotent.
    }
  }

  status() {
    const payload = this.getPassword();
    if (!payload) return { present: false, backend: this.backendName() };
    try {
      const parsed = JSON.parse(payload);
      return {
        present: true,
        backend: this.backendName(),
        // Null on a secret-only payload, where these live in .env instead.
        // Absent identifiers are the normal shape now, never a defect.
        account_id: parsed.MEMWAL_ACCOUNT_ID || null,
        network: parsed.MEMWAL_NETWORK || 'mainnet',
      };
    } catch {
      return {
        present: true,
        backend: this.backendName(),
        invalid: true,
      };
    }
  }

  backendName() {
    if (this.platform === 'darwin') return 'macos-keychain';
    if (this.platform === 'win32') return 'windows-dpapi';
    if (this.platform === 'linux' && fs.existsSync(this.fallbackPath)) {
      return 'owner-only-file';
    }
    if (this.platform === 'linux' && this.#hasSecretTool()) {
      return 'linux-secret-service';
    }
    return 'owner-only-file';
  }

  #hasSecretTool() {
    if (this.platform !== 'linux') return false;
    const result = this.run('secret-tool', ['--version'], textOptions());
    return result.status === 0;
  }

  #fallbackStore(secret) {
    this.#ensureDirectory();
    // No-follow write: refuse to write the secret through a pre-planted symlink.
    writeFileNoFollowSync(this.fallbackPath, secret, 0o600, {
      ...this.secureFileOptions,
      root: this.home,
    });
  }

  #fallbackGet() {
    // SEC-03: validate the full ancestor chain (no-create) exactly as #fallbackStore
    // does on write, then no-follow read. Rejects a symlinked ancestor as well as a
    // symlinked final file. Absent chain -> no secret.
    if (assertContainedChainSync(this.home, path.dirname(this.fallbackPath)) === null) return null;
    // The shared reader repairs and verifies the Windows DACL before it returns a
    // single credential byte. POSIX keeps the retained-fd O_NOFOLLOW read.
    return readFileNoFollowSync(this.fallbackPath, {
      ...this.secureFileOptions,
      root: this.home,
    });
  }

  #ensureDirectory() {
    ensureContainedDirSync(this.home, path.dirname(this.fallbackPath));
  }

  #cleanupZeroByte(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        fs.rmSync(filePath, { force: true });
        return true;
      }
    } catch {
      // Missing file is fine; permission errors fall through to the caller.
    }
    return false;
  }

  #runPowerShell(script, options = {}) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return this.#runChecked(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      options,
    );
  }

  #runChecked(command, args, options = {}) {
    const result = this.run(command, args, {
      ...textOptions(),
      ...options,
    });
    if (result.error || result.status !== 0) {
      const message =
        result.error?.message ||
        result.stderr?.trim() ||
        `${command} exited with status ${result.status}`;
      throw new Error(message);
    }
    return result;
  }
}

export function loadCredentialsIntoEnv({
  env = process.env,
  store = new CredentialStore('default'),
} = {}) {
  const payload = store.getPassword();
  if (!payload) return { loaded: false };

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    console.warn(
      `[credentials] Ignoring an unreadable ${store.backendName()} entry: ${error.message}`,
    );
    return {
      loaded: false,
      backend: store.backendName(),
      invalid: true,
    };
  }
  for (const key of CREDENTIAL_KEYS) {
    if (typeof parsed[key] === 'string' && parsed[key]) {
      env[key] = parsed[key];
    }
  }
  return {
    loaded: true,
    backend: store.backendName(),
    account_id: parsed.MEMWAL_ACCOUNT_ID || null,
    network: parsed.MEMWAL_NETWORK || 'mainnet',
  };
}

function textOptions() {
  return {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

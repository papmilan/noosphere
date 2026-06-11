import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVICE_NAME = 'noosphere';
const CREDENTIAL_KEYS = [
  'MEMWAL_ACCOUNT_ID',
  'MEMWAL_PRIVATE_KEY',
  'MEMWAL_NETWORK',
];

export class CredentialStore {
  constructor(
    account = 'default',
    {
      platform = process.platform,
      home = os.homedir(),
      run = spawnSync,
    } = {},
  ) {
    this.account = account;
    this.platform = platform;
    this.run = run;
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
        { input: `${secret}\n` },
      );
      return { backend: 'macos-keychain', encryptedAtRest: true };
    }

    if (this.platform === 'win32') {
      this.#ensureDirectory();
      const script = [
        '$secret = [Console]::In.ReadToEnd()',
        '$bytes = [Text.Encoding]::UTF8.GetBytes($secret)',
        '$encrypted = [Security.Cryptography.ProtectedData]::Protect(',
        '  $bytes, $null,',
        '  [Security.Cryptography.DataProtectionScope]::CurrentUser',
        ')',
        '$value = [Convert]::ToBase64String($encrypted)',
        'Set-Content -LiteralPath $env:NOOSPHERE_CREDENTIAL_PATH -Value $value',
      ].join('\n');
      this.#runPowerShell(script, {
        input: secret,
        env: {
          ...process.env,
          NOOSPHERE_CREDENTIAL_PATH: `${this.fallbackPath}.dpapi`,
        },
      });
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
        const script = [
          '$value = Get-Content -Raw -LiteralPath $env:NOOSPHERE_CREDENTIAL_PATH',
          '$encrypted = [Convert]::FromBase64String($value.Trim())',
          '$bytes = [Security.Cryptography.ProtectedData]::Unprotect(',
          '  $encrypted, $null,',
          '  [Security.Cryptography.DataProtectionScope]::CurrentUser',
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
    fs.writeFileSync(this.fallbackPath, secret, {
      mode: 0o600,
      encoding: 'utf8',
    });
    fs.chmodSync(this.fallbackPath, 0o600);
  }

  #fallbackGet() {
    if (!fs.existsSync(this.fallbackPath)) return null;
    return fs.readFileSync(this.fallbackPath, 'utf8');
  }

  #ensureDirectory() {
    fs.mkdirSync(path.dirname(this.fallbackPath), {
      recursive: true,
      mode: 0o700,
    });
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

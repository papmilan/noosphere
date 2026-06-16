import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatServiceInstallError } from '../lifecycle/service-errors.js';

const baseContext = {
  platform: 'win32',
  logDirectory: '/fake/.noosphere/logs',
  relayerLabel: 'xyz.noosphere.relayer',
  managerLabel: 'xyz.noosphere.manager',
  installedMcp: '/fake/.noosphere/app/noosphere-mcp',
  installedRelayer: '/fake/.noosphere/app/noosphere-relayer',
};

describe('formatServiceInstallError', () => {
  it('flags Windows EPERM with the actionable AV/UAC sentence', () => {
    const error = new Error('spawn schtasks.exe EPERM');
    error.code = 'EPERM';
    error.commandLine =
      'schtasks.exe /Create /TN \\Noosphere\\Relayer /SC ONLOGON /RL LIMITED /F';
    const message = formatServiceInstallError(error, baseContext);
    assert.match(message, /Windows blocked scheduled task creation\./);
    assert.match(message, /Run PowerShell or Command Prompt as Administrator/);
    assert.match(message, /allow\s+schtasks\.exe in your security software/);
    assert.doesNotMatch(
      message,
      /Failed to register Noosphere background services/,
    );
  });

  it('always shows the foreground fallback commands on Windows', () => {
    const error = new Error('some other failure');
    error.code = 'EOTHER';
    const message = formatServiceInstallError(error, baseContext);
    assert.match(message, /noosphere run-relayer/);
    assert.match(message, /noosphere run-manager/);
    assert.match(
      message,
      /Failed to register Noosphere background services: some other failure/,
    );
  });

  it('echoes the failed schtasks command line when present', () => {
    const error = new Error('spawn schtasks.exe EPERM');
    error.code = 'EPERM';
    error.commandLine =
      'schtasks.exe /Create /TN Noosphere\\Relayer /SC ONLOGON /RL LIMITED /F';
    const message = formatServiceInstallError(error, baseContext);
    assert.match(message, /Command that failed:/);
    assert.match(message, /schtasks\.exe \/Create \/TN Noosphere\\Relayer/);
  });

  it('keeps macOS guidance separate from Windows guidance', () => {
    const error = new Error('launchctl bootstrap exited 3');
    const message = formatServiceInstallError(error, {
      ...baseContext,
      platform: 'darwin',
    });
    assert.match(message, /macOS recovery/);
    assert.doesNotMatch(message, /noosphere run-relayer/);
  });

  it('keeps Linux guidance separate from Windows guidance', () => {
    const error = new Error('systemctl --user not running');
    const message = formatServiceInstallError(error, {
      ...baseContext,
      platform: 'linux',
    });
    assert.match(message, /Linux recovery/);
    assert.match(message, /noosphere run-relayer/);
    assert.doesNotMatch(message, /schtasks/);
  });
});

import path from 'node:path';

export function formatServiceInstallError(error, context) {
  const {
    platform,
    logDirectory,
    relayerLabel,
    managerLabel,
    installedMcp,
    installedRelayer,
  } = context;
  const code = error?.code || '';
  const original = error?.message || String(error);
  const commandLine = error?.commandLine || '';

  const head =
    platform === 'win32' && code === 'EPERM'
      ? 'Windows blocked scheduled task creation.'
      : `Failed to register Noosphere background services: ${original}`;

  const lines = [head, '', `Logs:  ${logDirectory}`];

  if (commandLine) {
    lines.push('', 'Command that failed:', `  ${commandLine}`);
  }

  if (platform === 'darwin') {
    lines.push(
      '',
      'macOS recovery:',
      '  launchctl bootout gui/$UID/xyz.noosphere.relayer || true',
      '  launchctl bootout gui/$UID/xyz.noosphere.manager || true',
      `  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.noosphere.relayer.plist`,
      `  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.noosphere.manager.plist`,
      '',
      'If this happens after a system update, sign out and back in,',
      'then re-run `npm --prefix noosphere-mcp run install:user`.',
    );
  } else if (platform === 'linux') {
    lines.push(
      '',
      'Linux recovery:',
      '  systemctl --user daemon-reload',
      `  systemctl --user enable --now ${relayerLabel} ${managerLabel}`,
      '',
      'If `systemctl --user` is not available, the host lacks a user',
      'systemd instance. Run the relayer manually with `noosphere run-relayer`,',
      `or invoke node directly: ${path.join(installedRelayer, 'index.js')}`,
    );
  } else {
    if (code === 'EPERM') {
      lines.push(
        '',
        'Run PowerShell or Command Prompt as Administrator and re-run',
        '`npm --prefix noosphere-mcp run install:user`, or allow',
        'schtasks.exe in your security software (Bitdefender, Norton,',
        'Defender Attack Surface Reduction).',
      );
    }
    lines.push(
      '',
      'Foreground fallback (no scheduled task required):',
      '  noosphere run-relayer',
      '  noosphere run-manager',
      '',
      'Or invoke node directly in two terminals:',
      `  node ${path.join(installedRelayer, 'index.js')}`,
      `  node ${path.join(installedMcp, 'lifecycle', 'manager.js')}`,
      '',
      'Once schtasks.exe is allowed, register the tasks manually:',
      '  schtasks /Create /TN "\\Noosphere\\Relayer" /SC ONLOGON /RL LIMITED /F \\',
      `    /TR "\\"node.exe\\" \\"${path.join(installedRelayer, 'index.js')}\\""`,
      '  schtasks /Create /TN "\\Noosphere\\Manager" /SC ONLOGON /RL LIMITED /F \\',
      `    /TR "\\"node.exe\\" \\"${path.join(installedMcp, 'lifecycle', 'manager.js')}\\""`,
    );
  }

  return lines.join('\n');
}

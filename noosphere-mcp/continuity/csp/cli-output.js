export function formatCspTransitionResult(result, { json = false } = {}) {
  if (!result.ok) {
    if (json) {
      return {
        stdout: `${JSON.stringify({
          ok: false,
          error: 'csp-transition-conflict',
          conflicts: result.conflicts,
        }, null, 2)}\n`,
        stderr: '',
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `CSP transition conflict: ${result.conflicts.map(formatConflict).join('; ')}\n`,
      exitCode: 1,
    };
  }

  const revision = Number.isInteger(result.runtime?.revision)
    ? ` (runtime revision ${result.runtime.revision})`
    : '';
  const warning = result.runtime_error
    ? `Warning: CSP committed, but runtime observation failed (${result.runtime_error.code}): ${result.runtime_error.message}\n`
    : '';
  return {
    stdout: `${result.changed ? 'CSP updated' : 'CSP unchanged'}${revision}: ${result.state.status}\n`,
    stderr: warning,
    exitCode: 0,
  };
}

function formatConflict(conflict) {
  return `${conflict.path} base=${JSON.stringify(conflict.base)} `
    + `current=${JSON.stringify(conflict.current)} proposed=${JSON.stringify(conflict.proposed)}`;
}

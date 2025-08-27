import { execa } from 'execa';
import stripAnsi from 'strip-ansi';

function trim(str, n = 20000) {
  return str.length > n ? str.slice(0, n) : str;
}

export async function runCmd(command, { workspace, timeout_ms } = {}) {
  try {
    const { stdout, stderr, exitCode } = await execa(command, {
      shell: true,
      cwd: workspace,
      timeout: timeout_ms
    });
    return {
      exitCode,
      stdout: trim(stripAnsi(stdout)),
      stderr: trim(stripAnsi(stderr))
    };
  } catch (err) {
    return {
      exitCode: err.exitCode ?? 1,
      stdout: trim(stripAnsi(err.stdout || '')),
      stderr: trim(stripAnsi(err.stderr || ''))
    };
  }
}

export async function runTests(cmd, timeout_ms = 600000, opts = {}) {
  return runCmd(cmd, { workspace: opts.workspace, timeout_ms });
}

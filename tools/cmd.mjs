import { execa } from 'execa';
import stripAnsi from 'strip-ansi';

export async function runCmd(command, opts = {}) {
  try {
    const { stdout, stderr, exitCode } = await execa(command, { shell: true, ...opts });
    return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode };
  } catch (err) {
    return { stdout: stripAnsi(err.stdout || ''), stderr: stripAnsi(err.stderr || ''), exitCode: err.exitCode ?? 1 };
  }
}

export async function runTests(command, timeoutMs = 600000) {
  return runCmd(command, { timeout: timeoutMs });
}

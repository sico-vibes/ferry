import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function start(command, args, options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  // Attach immediately, including for ENOENT, so callers can await completion safely.
  const started = performance.now();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.completion = new Promise((resolve) => {
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr, durationMs: performance.now() - started }),
    );
  });
  return child;
}

export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = start('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    await killer.completion;
  } else {
    // Detached children own a process group, including any agent-spawned commands.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await child.completion;
}

export async function run(command, args, { timeoutMs = 30_000, input, onStart, ...options } = {}) {
  const child = start(command, args, { detached: process.platform !== 'win32', ...options });
  onStart?.(child);
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stop(child);
  }, timeoutMs);
  try {
    return { ...(await child.completion), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for readiness');
}

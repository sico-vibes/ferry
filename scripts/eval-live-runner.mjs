import { runPrompt } from '../apps/cli/src/main.tsx';
import { join } from 'node:path';
import { redactText } from './eval-live-lib.mjs';

export async function driveEvalSession({
  client,
  prompt,
  cwd,
  profileName,
  modelRef,
  maxSteps,
  verbose = false,
  timeoutMs = 10 * 60 * 1000,
  inactivityTimeoutMs = 60_000,
  logDirectory,
  secrets = [],
  onProgress,
  onSessionFinished,
  signal,
}) {
  let session;
  let lastSessionEventAt = Date.now();
  let lastSessionEvent;
  const eventTail = [];
  let sessionFinished = false;
  const finishSession = () => {
    if (session && !sessionFinished) {
      sessionFinished = true;
      onSessionFinished?.(session);
    }
  };
  let settleWatchdog;
  let watchdogTimer;
  let taskTimer;
  const watchdog = new Promise((_, reject) => {
    settleWatchdog = reject;
  });
  const interrupted = new Promise((_, reject) => {
    if (signal?.aborted) reject(new Error('Evaluation interrupted by shutdown signal.'));
    else
      signal?.addEventListener(
        'abort',
        () => reject(new Error('Evaluation interrupted by shutdown signal.')),
        { once: true },
      );
  });
  const armInactivityTimer = () => {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      void fail(
        `No session progress event arrived within ${Math.round(inactivityTimeoutMs / 1000)} seconds.`,
      );
    }, inactivityTimeoutMs);
  };
  const fail = async (reason) => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (taskTimer) clearTimeout(taskTimer);
    if (session?.id) void client.sessions.cancel(session.id).catch(() => undefined);
    const logTail = await readCoreLogTail(logDirectory, secrets);
    const eventText = eventTail.length ? eventTail.join('\n') : '(none)';
    const elapsedMs = Date.now() - lastSessionEventAt;
    settleWatchdog(
      new Error(
        `${reason} Last session event ${lastSessionEvent ? `${elapsedMs}ms ago: ${lastSessionEvent}` : 'was never observed'}.\n` +
          `Recent session events:\n${eventText}\nCore log tail:\n${logTail || '(empty)'}`,
      ),
    );
  };

  armInactivityTimer();
  taskTimer = setTimeout(() => {
    void fail(`Task timed out after ${timeoutMs}ms.`);
  }, timeoutMs);
  const runPromise = runPrompt(client, prompt, false, profileName, cwd, {
    permission: 'full_auto',
    maxSteps,
    modelRef,
    verbose,
    quiet: true,
    onSessionCreated(created) {
      session = created;
      onProgress?.({ kind: 'session', session: created });
    },
    onEvent(event) {
      if (typeof event.type !== 'string' || !event.type.startsWith('session.')) return;
      const eventSessionId =
        typeof event.sessionId === 'string'
          ? event.sessionId
          : typeof event.session === 'object' && event.session !== null && 'id' in event.session
            ? String(event.session.id)
            : undefined;
      if (session && eventSessionId && eventSessionId !== session.id) return;
      lastSessionEventAt = Date.now();
      lastSessionEvent = summarizeSessionEvent(event);
      eventTail.push(lastSessionEvent);
      if (eventTail.length > 12) eventTail.shift();
      armInactivityTimer();
      if (verbose) {
        const progress = formatProgress(event);
        if (progress) onProgress?.({ kind: 'progress', text: progress });
      }
    },
  });
  // A watchdog can win the race while runPrompt is still unwinding a cancelled request.
  void runPromise.then(finishSession, finishSession);

  try {
    const exitCode = await Promise.race([runPromise, watchdog, interrupted]);
    if (!session) throw new Error('CLI run completed without creating a session.');
    const detail = await client.sessions.get(session.id);
    return { exitCode, session, detail, eventTail };
  } finally {
    clearTimeout(watchdogTimer);
    clearTimeout(taskTimer);
  }
}

async function readCoreLogTail(directory, secrets) {
  if (!directory) return '';
  const files = await import('node:fs/promises');
  const entries = await files.readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /ferry.*\.log/i.test(entry.name))
      .map(async (entry) => ({
        path: join(directory, entry.name),
        modified: (await files.stat(join(directory, entry.name))).mtimeMs,
      })),
  );
  const newest = candidates.sort((a, b) => b.modified - a.modified).slice(0, 2);
  const text = await Promise.all(
    newest.map(async ({ path }) => {
      const content = await files.readFile(path, 'utf8').catch(() => '');
      return content.slice(-5000);
    }),
  );
  return redactText(text.join('\n'), secrets).slice(-9000);
}

function summarizeSessionEvent(event) {
  const details = [];
  if (typeof event.type === 'string') details.push(event.type);
  if (typeof event.modelRef === 'string') details.push(`model=${event.modelRef}`);
  if (typeof event.sessionId === 'string') details.push(`session=${event.sessionId}`);
  if (typeof event.part === 'object' && event.part !== null && 'type' in event.part) {
    const part = event.part;
    if (part.type === 'tool_call') details.push(`tool=${part.tool}:${part.status}`);
    else details.push(`part=${part.type}`);
  }
  if (typeof event.session === 'object' && event.session !== null && 'status' in event.session)
    details.push(`status=${event.session.status}`);
  return redactText(details.join(' '), []);
}

function formatProgress(event) {
  if (
    event.type === 'session.message' &&
    typeof event.message === 'object' &&
    event.message !== null
  ) {
    const message = event.message;
    return message.role === 'assistant' && message.modelRef
      ? `model ${message.modelRef}`
      : undefined;
  }
  if (event.type === 'session.part' && typeof event.part === 'object' && event.part !== null) {
    const part = event.part;
    if (part.type === 'tool_call') return `tool ${part.title}: ${part.status}`;
    if (part.type === 'handoff_marker')
      return `handoff ${part.from} -> ${part.to} (${part.reason})`;
  }
  if (
    event.type === 'session.status' &&
    typeof event.session === 'object' &&
    event.session !== null
  )
    return `status ${event.session.status}`;
  return undefined;
}

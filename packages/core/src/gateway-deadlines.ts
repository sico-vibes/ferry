export class GatewayTimeoutError extends Error {
  readonly code = 'request_timeout';
  readonly statusCode = 504;
}

/** Races hung adapters as well as signalling cooperative providers. Timers never outlive a request. */
export async function withGatewayDeadlines<T>(
  options: { signal: AbortSignal; firstResponseMs: number; idleMs: number; overallMs: number },
  dispatch: (signal: AbortSignal, progress: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let first: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let overall: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = (error: unknown) => {
    controller.abort(error);
    rejectDeadline(error);
  };
  const cancelled = () => {
    abort(options.signal.reason ?? new Error('Request cancelled'));
  };
  const progress = () => {
    if (controller.signal.aborted) return;
    clearTimeout(first);
    clearTimeout(idle);
    idle = setTimeout(() => {
      abort(
        new GatewayTimeoutError('Upstream stream stopped responding. Try a different provider.'),
      );
    }, options.idleMs);
  };
  options.signal.addEventListener('abort', cancelled, { once: true });
  try {
    if (options.signal.aborted) {
      cancelled();
      return await deadline;
    }
    first = setTimeout(() => {
      abort(
        new GatewayTimeoutError('Upstream did not respond before the first-response deadline.'),
      );
    }, options.firstResponseMs);
    overall = setTimeout(
      () => {
        abort(new GatewayTimeoutError('Gateway request deadline reached.'));
      },
      Math.max(1, options.overallMs),
    );
    return await Promise.race([dispatch(controller.signal, progress), deadline]);
  } finally {
    clearTimeout(first);
    clearTimeout(idle);
    clearTimeout(overall);
    options.signal.removeEventListener('abort', cancelled);
    controller.abort();
  }
}

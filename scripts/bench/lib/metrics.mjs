export function metrics(stdout) {
  const events = [];
  let malformedLines = 0;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (
        !event ||
        Array.isArray(event) ||
        typeof event !== 'object' ||
        typeof event.type !== 'string'
      )
        throw new Error('Invalid event');
      events.push(event);
    } catch {
      malformedLines++;
    }
  }
  const parts = new Map();
  const agentEvents = new Map();
  const attempts = new Map();
  const models = new Set();
  const waits = new Map();
  let finalOutcome = 'incomplete';
  let completed = false;
  let completedUsage;
  const addAttempts = (rows = []) =>
    rows.forEach((row) => attempts.set(row.id ?? JSON.stringify(row), row));
  for (const event of events) {
    if (event.type === 'session.part' && event.part)
      parts.set(event.part.id ?? JSON.stringify(event.part), event.part);
    if (event.type === 'session.message' && event.message) {
      addAttempts(event.message.modelAttempts);
      if (event.message.role === 'assistant' && event.message.modelRef)
        models.add(event.message.modelRef);
    }
    if (event.type === 'session.status') {
      const session = event.session ?? event;
      finalOutcome = session.status ?? finalOutcome;
      if (session.modelRef) models.add(session.modelRef);
      for (const item of session.agentEvents ?? [])
        agentEvents.set(item.id ?? JSON.stringify(item), item);
      if (session.waitUntil ?? event.waitUntil) {
        const waitUntil = session.waitUntil ?? event.waitUntil;
        waits.set(waitUntil, {
          waitUntil,
          reason: session.reason ?? event.reason ?? session.status,
        });
      }
    }
    if (event.type === 'run.completed') {
      completed = true;
      completedUsage = event.usage ?? completedUsage;
      addAttempts(event.attempts);
      if (event.servedModel) models.add(event.servedModel);
    }
    if (event.type === 'usage') agentEvents.set(event.id ?? JSON.stringify(event), event);
  }
  for (const part of parts.values()) if (part.producedBy) models.add(part.producedBy);
  const switches = [...parts.values()]
    .filter((part) => part.type === 'handoff_marker')
    .map(({ from, to, reason, explanation }) => ({ from, to, reason, explanation }));
  for (const item of switches) {
    models.add(item.from);
    models.add(item.to);
  }
  const failedAttemptsByKind = {};
  for (const attempt of attempts.values()) {
    const kind = attempt.errorKind ?? attempt.fallbackReason;
    if (kind) failedAttemptsByKind[kind] = (failedAttemptsByKind[kind] ?? 0) + 1;
  }
  const usage = [...agentEvents.values()].filter((event) => event.type === 'usage');
  const tokens = usage.length || completedUsage ? { input: 0, output: 0, reasoning: 0 } : null;
  for (const item of usage) {
    tokens.input += item.inputTokens ?? 0;
    tokens.output += item.outputTokens ?? 0;
    tokens.reasoning += item.reasoningTokens ?? 0;
  }
  if (!usage.length && completedUsage) {
    tokens.input = completedUsage.inputTokens ?? completedUsage.input ?? 0;
    tokens.output = completedUsage.outputTokens ?? completedUsage.output ?? 0;
    tokens.reasoning = completedUsage.reasoningTokens ?? completedUsage.reasoning ?? 0;
  }
  const toolCalls = [...parts.values()].filter((part) => part.type === 'tool_call');
  return {
    steps: toolCalls.length,
    modelsUsed: [...models],
    switches,
    waits: [...waits.values()],
    failedAttemptsByKind,
    attempts: [...attempts.values()],
    tokens,
    finalOutcome,
    completed,
    malformedLines,
    toolCalls,
  };
}

export function freeModels(provider) {
  const match = (pattern, value) =>
    new RegExp(
      `^${pattern
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replaceAll('*', '.*')
        .replaceAll('\\?', '.')}$`,
      'i',
    ).test(value);
  return (provider.availableModels ?? [])
    .filter((model) => {
      if (
        !(model.capability?.toolCall ?? model.toolCalling) ||
        model.providerId !== provider.id ||
        provider.excludedModelRefs?.includes(model.ref) ||
        provider.freeTierUnsupported ||
        provider.id === 'opencode'
      )
        return false;
      const zero = model.priceInPerM === 0 && model.priceOutPerM === 0;
      if (provider.id === 'openrouter') return /:free(?:$|:)/i.test(model.ref) || zero;
      if (provider.billingEnabled || ['paid', 'credits', 'trial'].includes(provider.tag))
        return false;
      const id = model.ref.slice(provider.id.length + 1);
      if (
        provider.freePlan?.models.some((pattern) => match(pattern, id)) &&
        !provider.freePlan.excludedModels?.some((pattern) => match(pattern, id))
      )
        return true;
      return zero;
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.reasoning)) - Number(Boolean(a.reasoning)) || a.ref.localeCompare(b.ref),
    )
    .slice(0, 3);
}

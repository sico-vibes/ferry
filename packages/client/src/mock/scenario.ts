import type { FerryEvents } from '../events.js';
import type { SessionId, Message, MessagePart } from '@ferry/shared';
import type { Clock } from './clock.js';
import type { MockStore } from './types.js';
export interface ScenarioRunner {
  run(ctx: {
    sessionId: SessionId;
    userText: string;
    emit: <E extends keyof FerryEvents>(e: E, p: FerryEvents[E]) => void;
    store: MockStore;
    clock: Clock;
    signal: AbortSignal;
  }): Promise<void>;
}
const delay = (clock: Clock, ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const cancel = clock.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      cancel();
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
export const echoRunner: ScenarioRunner = {
  async run({ sessionId, userText, emit, clock, signal, store }) {
    await delay(clock, 600, signal);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const text = `Mock mode: I would work on “${userText}” here.`;
    const msgId = store.nextId('message') as Message['id'];
    const partId = store.nextId('part') as MessagePart['id'];
    const part: MessagePart = { type: 'text', id: partId, text };
    for (const chunk of [
      text.slice(0, Math.ceil(text.length / 3)),
      text.slice(Math.ceil(text.length / 3), Math.ceil((text.length * 2) / 3)),
      text.slice(Math.ceil((text.length * 2) / 3)),
    ]) {
      await delay(clock, 150, signal);
      emit('session.delta', { sessionId, messageId: msgId, partId, textDelta: chunk });
    }
    const message: Message = {
      id: msgId,
      sessionId,
      role: 'assistant',
      createdAt: clock.now().toISOString(),
      modelRef: session.modelRef,
      parts: [part],
    };
    store.messages.get(sessionId)?.push(message);
    emit('session.message', { sessionId, message });
  },
};

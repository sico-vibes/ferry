import { SessionStore } from '@ferry/agent';
import type { FerryServices } from './services.js';
import { MessageSchema } from '@ferry/shared';
import { z } from 'zod';

export const COMPACTION_PROMPT =
  'Summarize this conversation for continued coding work. Preserve the user requirements, constraints, completed actions, discoveries, file names, and unresolved next steps. Return only a concise summary. Do not call tools or perform any work.';

const BoundarySchema = z.object({ messageId: z.string(), summary: z.string().min(1) });

/** Only the model view is compacted. The durable transcript remains available to sessions.get. */
export function createContextStore(
  repositories: ConstructorParameters<typeof SessionStore>[0],
  services: FerryServices,
): SessionStore {
  return new (class extends SessionStore {
    override load(sessionId: string) {
      const detail = super.load(sessionId);
      const boundary = BoundarySchema.safeParse(
        services.settings.get(`context-summary:${sessionId}`),
      );
      if (!detail || !boundary.success) return detail;
      const index = detail.messages.findIndex((message) => message.id === boundary.data.messageId);
      const source = detail.messages[index];
      if (!source) return detail;
      const summary = MessageSchema.parse({
        ...source,
        role: 'user',
        modelRef: null,
        parts: [
          {
            type: 'text',
            id: source.parts[0]?.id,
            text: `Earlier conversation summary:\n${boundary.data.summary}`,
          },
        ],
      });
      return {
        ...detail,
        messages: [summary, ...detail.messages.slice(index + 1)],
        taskRecord: {
          ...detail.taskRecord,
          decisions: [
            ...detail.taskRecord.decisions.filter(
              (decision) => decision.why !== 'Manual context compaction',
            ),
            { text: boundary.data.summary, why: 'Manual context compaction', at: source.createdAt },
          ],
        },
      };
    }
  })(repositories);
}

export function saveContextSummary(
  store: SessionStore,
  services: FerryServices,
  sessionId: string,
): void {
  const detail = store.load(sessionId);
  const answer = detail?.messages.at(-1);
  if (
    answer?.role !== 'assistant' ||
    answer.parts.some((part) => part.type === 'error' || part.type === 'tool_call')
  )
    return;
  const summary = answer.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (summary)
    services.settings.put(`context-summary:${sessionId}`, { messageId: answer.id, summary });
}

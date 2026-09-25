import {
  MessageSchema,
  PartIdSchema,
  SessionSchema,
  TaskRecordSchema,
  newId,
  type Message,
  type Session,
  type TaskRecord,
  type WorkspaceId,
} from '@ferry/shared';
import type { MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';

export interface SessionRepositories {
  sessions: SessionRepository;
  messages: MessageRepository;
  tasks: TaskRepository;
}

export interface CreateSessionInput {
  workspaceId: WorkspaceId;
  profileId: Session['profileId'];
  modelRef?: Session['modelRef'];
  prompt: string;
  title?: string;
  now?: Date;
}

export function fallbackTitle(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 80) || 'New session';
}

export class SessionStore {
  constructor(private readonly repositories: SessionRepositories) {}

  create(input: CreateSessionInput): Session {
    const now = (input.now ?? new Date()).toISOString();
    const session = SessionSchema.parse({
      id: newId('session'),
      workspaceId: input.workspaceId,
      title: input.title ?? fallbackTitle(input.prompt),
      preview: input.prompt.slice(0, 160),
      profileId: input.profileId,
      modelRef: input.modelRef ?? null,
      starred: false,
      pinned: false,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    const task = TaskRecordSchema.parse({
      sessionId: session.id,
      goal: input.prompt,
      plan: [],
      decisions: [],
      touchedFiles: [],
      nextStep: null,
    });
    this.repositories.sessions.put(session);
    this.repositories.tasks.put(task);
    this.appendMessage(
      session.id,
      'user',
      [{ type: 'text', id: PartIdSchema.parse(newId('part')), text: input.prompt }],
      null,
      input.now,
    );
    return session;
  }

  load(
    sessionId: string,
  ): { session: Session; messages: Message[]; taskRecord: TaskRecord } | undefined {
    const session = this.repositories.sessions.get(sessionId);
    if (!session) return undefined;
    const messages = this.repositories.messages
      .list()
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const taskRecord = this.repositories.tasks.get(sessionId);
    if (!taskRecord) throw new Error(`Session ${sessionId} has no task record`);
    return { session, messages, taskRecord };
  }

  list(workspaceId: WorkspaceId): Session[] {
    return this.repositories.sessions
      .list()
      .filter((session) => session.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  appendMessage(
    sessionId: string,
    role: Message['role'],
    parts: Message['parts'],
    modelRef: Message['modelRef'],
    now = new Date(),
  ): Message {
    const previousTime = this.repositories.messages
      .list()
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => Date.parse(entry.createdAt))
      .reduce((latest, value) => Math.max(latest, value), 0);
    const at = Math.max(now.getTime(), previousTime + (previousTime ? 1 : 0));
    const message = MessageSchema.parse({
      id: newId('message'),
      sessionId,
      role,
      createdAt: new Date(at).toISOString(),
      modelRef,
      parts,
    });
    this.repositories.messages.put(message);
    const session = this.repositories.sessions.get(sessionId);
    if (session) {
      this.repositories.sessions.put({
        ...session,
        preview:
          parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
            .slice(0, 160) || session.preview,
        updatedAt: new Date(at).toISOString(),
      });
    }
    return message;
  }

  appendPart(
    sessionId: string,
    messageId: string,
    part: Message['parts'][number],
  ): Message | undefined {
    const message = this.repositories.messages.get(messageId);
    if (message?.sessionId !== sessionId) return undefined;
    const updated = MessageSchema.parse({ ...message, parts: [...message.parts, part] });
    this.repositories.messages.put(updated);
    return updated;
  }

  replacePart(sessionId: string, part: Message['parts'][number]): Message | undefined {
    const message = this.repositories.messages
      .list()
      .find(
        (entry) =>
          entry.sessionId === sessionId &&
          entry.parts.some((candidate) => candidate.id === part.id),
      );
    if (!message) return undefined;
    const updated = MessageSchema.parse({
      ...message,
      parts: message.parts.map((candidate) => (candidate.id === part.id ? part : candidate)),
    });
    this.repositories.messages.put(updated);
    return updated;
  }

  replaceMessage(message: Message): void {
    this.repositories.messages.put(MessageSchema.parse(message));
  }

  saveTask(task: TaskRecord): void {
    this.repositories.tasks.put(TaskRecordSchema.parse(task));
  }

  updateSession(sessionId: string, update: Partial<Session>): Session {
    const current = this.repositories.sessions.get(sessionId);
    if (!current) throw new Error(`Unknown session ${sessionId}`);
    const next = SessionSchema.parse({
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    });
    this.repositories.sessions.put(next);
    return next;
  }
}

import { sampleSession } from '@ferry/shared/testing';
import type { Session, Workspace } from '@ferry/shared';

export function createSessions(now: Date, workspaces: Workspace[]): Session[] {
  const titles = [
    'New Chat',
    'Auth refactor',
    'Fix flaky tests',
    'Add dark mode',
    'Explain the router',
    'Migrate to Drizzle',
    'Speed up CI',
    'Write e2e for checkout',
    'Rate limiter bug',
    'Docs for the CLI',
    'Upgrade to React 19',
    'Refactor payment service',
  ];
  const previews = [
    'Explore a new coding task',
    'Refactor token validation middleware',
    'Investigate intermittent CI failures',
    'Add a theme toggle and persist it',
    'Explain how requests flow through the router',
    'Plan a safe schema migration',
    'Reduce build time in the pipeline',
    'Cover checkout with browser tests',
    'Trace the burst limiter regression',
    'Document installation and commands',
    'Upgrade components and resolve type errors',
    'Simplify payment orchestration',
  ];
  const sessions: Session[] = titles.map((title, i) => {
    const workspace = workspaces[i % 3];
    if (!workspace) throw new Error('Workspace fixtures are empty');
    const offsets = [
      60000, 120000, 300000, 3600000, 10800000, 86400000, 172800000, 345600000, 518400000,
      777600000, 1036800000, 1728000000,
    ];
    return {
      ...sampleSession,
      id: `session_${String(i + 1)}` as Session['id'],
      workspaceId: workspace.id,
      title,
      preview: previews[i] ?? title,
      profileId: 'profile_best' as Session['profileId'],
      modelRef: null,
      starred: i === 1 || i === 6,
      pinned: [1, 2, 3].includes(i),
      status: 'idle',
      createdAt: new Date(now.getTime() - (i + 1) * 3600000).toISOString(),
      updatedAt: new Date(now.getTime() - (offsets[i] ?? 0)).toISOString(),
    };
  });

  return sessions;
}

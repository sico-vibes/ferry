import { useQuery } from '@tanstack/react-query';
import type { SessionId } from '@ferry/shared';
import { useFerryClient } from './client';

export const keys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['session', id] as const,
  profiles: ['profiles'] as const,
  settings: ['settings'] as const,
  capacity: ['capacity'] as const,
  mcp: ['mcp'] as const,
  workspaces: ['workspaces'] as const,
};

export function useSessions(query?: string) {
  const client = useFerryClient();
  return useQuery({
    queryKey: [...keys.sessions, query ?? ''],
    queryFn: () => client.sessions.list(query === undefined ? {} : { query }),
  });
}
export function useSessionDetail(id: SessionId) {
  const client = useFerryClient();
  return useQuery({
    queryKey: keys.session(id),
    queryFn: () => client.sessions.get(id),
    enabled: Boolean(id),
  });
}
export function useProfiles() {
  const client = useFerryClient();
  return useQuery({ queryKey: keys.profiles, queryFn: () => client.profiles.list() });
}
export function useSettings() {
  const client = useFerryClient();
  return useQuery({ queryKey: keys.settings, queryFn: () => client.settings.get() });
}
export function useCapacity() {
  const client = useFerryClient();
  return useQuery({ queryKey: keys.capacity, queryFn: () => client.quota.capacity() });
}
export function useMcpServers() {
  const client = useFerryClient();
  return useQuery({ queryKey: keys.mcp, queryFn: () => client.mcp.list() });
}
export function useWorkspaces() {
  const client = useFerryClient();
  return useQuery({ queryKey: keys.workspaces, queryFn: () => client.workspaces.list() });
}

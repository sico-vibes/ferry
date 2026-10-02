import { useSystemInfo } from '../data/queries';

export function useDisplayName(): string | null {
  const { data: systemInfo } = useSystemInfo();

  if (systemInfo?.mock) return 'Jordan';

  const hostName = window.ferryHost?.displayName;
  return hostName ? hostName.trim() || null : null;
}

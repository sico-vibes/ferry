import { useProfiles, useSettings, useSystemInfo } from '../data/queries';

export function useDisplayName(): string | null {
  const { data: profiles = [] } = useProfiles();
  const { data: settings } = useSettings();
  const { data: systemInfo } = useSystemInfo();

  if (systemInfo?.mock) return 'Jordan';

  const profileName = profiles
    .find((profile) => profile.id === settings?.activeProfileId)
    ?.name.trim();
  if (profileName) return profileName;

  const hostName = window.ferryHost?.displayName;
  return hostName ? hostName.trim() || null : null;
}

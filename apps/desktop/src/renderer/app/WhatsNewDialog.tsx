import { X } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
// The repository changelog is bundled as text; it is not a package export.
// eslint-disable-next-line import-x/no-relative-packages
import changelog from '../../../../../CHANGELOG.md?raw';

export interface ReleaseNotes {
  version: string;
  date: string | null;
  groups: { title: string; items: string[] }[];
}

/** Parses Keep-a-Changelog markdown into releases, newest first. */
export function parseChangelog(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  let release: ReleaseNotes | undefined;
  let group: ReleaseNotes['groups'][number] | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(raw);
    if (heading) {
      release = { version: heading[1] ?? '', date: heading[2] ?? null, groups: [] };
      releases.push(release);
      group = undefined;
      continue;
    }
    if (!release) continue;
    const section = /^### (.+)/.exec(raw);
    if (section) {
      group = { title: section[1]?.trim() ?? '', items: [] };
      release.groups.push(group);
      continue;
    }
    if (!group) continue;
    const bullet = /^- (.+)/.exec(raw);
    if (bullet) group.items.push(bullet[1]?.trim() ?? '');
    else if (/^\s{2,}\S/.test(raw) && group.items.length) {
      const last = group.items.length - 1;
      group.items[last] = `${group.items[last] ?? ''} ${raw.trim()}`;
    }
  }
  return releases.filter((entry) => entry.groups.some((item) => item.items.length));
}

const SEEN_KEY = 'ferry.whatsNewSeen';

/** True once per new app version (never on a first install). Records the version as seen. */
export function shouldShowWhatsNew(appVersion: string | null | undefined): boolean {
  if (!appVersion) return false;
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, appVersion);
    return seen !== null && seen !== appVersion;
  } catch {
    return false;
  }
}

/** Renders `code` spans in changelog lines without pulling in a Markdown renderer. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/)
        .map((piece, index) =>
          piece.startsWith('`') && piece.endsWith('`') ? (
            <code key={index}>{piece.slice(1, -1)}</code>
          ) : (
            <span key={index}>{piece}</span>
          ),
        )}
    </>
  );
}

export function WhatsNewDialog({
  open,
  onOpenChange,
  appVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appVersion: string | null | undefined;
}) {
  const releases = parseChangelog(changelog).slice(0, 4);
  return (
    <UiV2.Dialog open={open} onOpenChange={onOpenChange}>
      <UiV2.DialogContent className="v2-whats-new">
        <UiV2.DialogClose aria-label="Close What's new" className="v2-about-close">
          <X aria-hidden="true" />
        </UiV2.DialogClose>
        <UiV2.DialogHeader>
          <UiV2.DialogTitle>What’s new</UiV2.DialogTitle>
          <UiV2.DialogDescription className="sr-only">
            Changes in recent Ferry versions
          </UiV2.DialogDescription>
        </UiV2.DialogHeader>
        <div className="v2-whats-new-body">
          {releases.map((release) => (
            <section key={release.version}>
              <header>
                <h3>
                  {release.date
                    ? new Date(`${release.date}T12:00:00`).toLocaleDateString([], {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })
                    : 'This version'}
                </h3>
                <span className="v2-whats-new-version">
                  {release.version === 'Unreleased' ? (appVersion ?? 'Latest') : release.version}
                </span>
              </header>
              {release.groups
                .filter((group) => group.items.length)
                .map((group) => (
                  <div key={group.title} className="v2-whats-new-group">
                    <h4>{group.title}</h4>
                    <ul>
                      {group.items.map((item) => (
                        <li key={item}>
                          <Inline text={item} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </section>
          ))}
        </div>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}

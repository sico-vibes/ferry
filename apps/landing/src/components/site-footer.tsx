import { FerryMark } from '@/components/ferry-mark';
import { Separator } from '@/components/ui/separator';
import { links, nav } from '@/lib/site';
import { textLinkClass } from '@/lib/utils';

const resources = [
  { href: links.github, label: 'GitHub' },
  { href: links.download, label: 'Releases' },
  { href: links.docs, label: 'Docs' },
  { href: links.cli, label: 'CLI' },
  { href: links.routing, label: 'Routing' },
  { href: links.providers, label: 'Providers' },
] as const;

export function SiteFooter() {
  return (
    <footer className="pb-10">
      <div className="mx-auto w-full max-w-6xl px-6">
        <Separator />
        <div className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <FerryMark className="size-6" />
              <span className="font-semibold">Ferry</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">
              A local gateway that ferries coding requests across free and paid providers. Bring
              your own keys.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold">On this page</h2>
            <ul className="mt-3 space-y-2">
              {nav.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className={textLinkClass}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-sm font-semibold">Resources</h2>
            <ul className="mt-3 space-y-2">
              {resources.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className={textLinkClass}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-2 py-6 text-xs leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Ferry is local-first. Provider traffic goes to the provider you route it to.</p>
          <p>
            <a href={links.license} className={textLinkClass}>
              MIT License
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}

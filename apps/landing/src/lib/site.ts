export const links = {
  download: 'https://github.com/sico-vibes/ferry/releases',
  github: 'https://github.com/sico-vibes/ferry',
  docs: 'https://github.com/sico-vibes/ferry/tree/main/docs',
  cli: 'https://github.com/sico-vibes/ferry/blob/main/docs/CLI.md',
  routing: 'https://github.com/sico-vibes/ferry/blob/main/docs/ROUTING.md',
  providers: 'https://github.com/sico-vibes/ferry/blob/main/docs/PROVIDERS.md',
  license: 'https://github.com/sico-vibes/ferry/blob/main/LICENSE',
} as const;

export const nav = [
  { href: '#crossing', label: 'The crossing' },
  { href: '#features', label: 'Features' },
  { href: '#route', label: 'How it works' },
  { href: '#dock', label: 'The dock' },
  { href: '#faq', label: 'FAQ' },
] as const;

export const hero = {
  badge: 'Windows desktop and CLI',
  title: 'Your ferry across free AI.',
  support: 'All free providers. One gateway. Smart routing.',
  body: 'Ferry is a Windows desktop and CLI coding agent. It carries each coding request from your machine across free and paid providers, and keeps the session on course with key health, rotation, and usage controls. Bring your own keys.',
  honest: 'No pooled accounts and no fixed free quota. Providers control the limits.',
  primary: 'Download for Windows',
  secondary: 'View on GitHub',
  smartScreen:
    'Windows may show a SmartScreen warning because beta installers are unsigned. Run the file only when it came from the official Ferry releases page.',
} as const;

export const crossing = {
  title: 'The crossing',
  lead: 'Many providers in. One gateway out.',
  body: 'Ferry aggregates free and paid providers, routes each request, and fails over when a key runs out of room. The output is one local Gateway: an OpenAI-compatible key you can plug into OpenCode, Kilo Code, and any other compatible app.',
  note: 'Bring your own keys. Ferry does not pool accounts or promise a fixed free quota.',
  gateway: 'Gateway',
  gatewayHint: 'OpenAI-compatible',
} as const;

export const features = [
  {
    title: 'Free providers hub',
    body: 'Dock Gemini, Groq, OpenRouter, Mistral, NVIDIA, and the rest of the catalog in one place. Add a key per provider and Ferry can see which berths are open.',
  },
  {
    title: 'Smart routing',
    body: 'Pick a profile and Ferry carries the request to a healthy model. When a berth fills or a key fails, the next candidate takes the crossing.',
  },
  {
    title: 'Key health and rotation',
    body: 'Every key has health, rotation, and automatic disable and re-enable. A tired key does not sink the session.',
  },
  {
    title: 'Desktop + CLI',
    body: 'The same route from the Ferry window or from ferry run. When the desktop core is up, the CLI can share it.',
  },
  {
    title: 'Local-first',
    body: 'Sessions and workspace data stay on your computer. Provider secrets live in the operating system keyring, not in the repo.',
  },
  {
    title: 'Honest BYOK',
    body: 'Ferry is bring-your-own-key. It does not pool accounts, share subscriptions, or promise a fixed number of free coding sessions.',
  },
] as const;

export const steps = [
  {
    title: 'Add keys',
    body: 'Open Providers and keys, choose a provider, and add your own API key. Ferry stores it in the OS keyring.',
  },
  {
    title: 'Pick a route',
    body: 'Choose a routing profile. Ferry scores healthy models and falls over when a free berth is full.',
  },
  {
    title: 'Code',
    body: 'Ask from the desktop composer or the CLI. Review the changes before they land.',
    command: 'ferry run "Explain this project"',
  },
] as const;

export const dock = {
  title: 'The dock',
  lead: 'Routing, capacity, and the session live on your machine.',
  homeAlt: 'Ferry desktop home with the composer, pinned profiles, and remaining free capacity.',
  homeCaption: 'Home. Start a crossing from the composer.',
  routingAlt: 'Ferry routing settings with sticky sessions, smart reliability, and quota controls.',
  routingCaption: 'Routing. Health, rotation, and the route stay on your machine.',
} as const;

export const faq = [
  {
    question: 'Does Ferry include free AI usage?',
    answer:
      'No. Free capacity belongs to the provider account you connect. Limits can be shared, model-specific, regional, or reduced without notice. Ferry does not promise a fixed number of free coding sessions.',
  },
  {
    question: 'Are provider accounts pooled?',
    answer:
      "No. Ferry does not pool accounts, rotate other people's keys, or present one subscription as a shared API. You bring your own keys, and requests go to the provider you route them to.",
  },
  {
    question: 'Where are keys stored?',
    answer:
      "In the operating system keyring. They are not written into project files. You are responsible for each provider's terms and any charges on that account.",
  },
  {
    question: 'Can a route include paid providers?',
    answer:
      'Yes. Paid keys can sit on the same route, with confirmation and spend caps in the app. Auto-free stays on free and covered models.',
  },
  {
    question: 'What runs on my computer?',
    answer:
      'The desktop app, the CLI, and the local gateway. Ferry Gateway speaks OpenAI, Anthropic, and Gemini client protocols on your machine. It is not a hosted pool of accounts.',
  },
  {
    question: 'Which systems can I install?',
    answer:
      'The desktop installer is Windows. Download Ferry-Setup or the portable build from GitHub Releases. The installer can add the bundled ferry CLI to your PATH.',
  },
] as const;

export const finalCta = {
  title: 'Ready for the crossing?',
  body: 'Download Ferry for Windows, add your own keys, and send the first request across.',
  primary: 'Download for Windows',
  secondary: 'Read the docs',
} as const;

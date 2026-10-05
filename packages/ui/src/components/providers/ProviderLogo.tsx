import { cn } from '../../lib/cn';

// Logos are vendored from @lobehub/icons-static-svg (MIT); see NOTICE. Bundled at build time,
// never fetched at runtime. Mono marks use currentColor so they follow the theme.
const files = import.meta.glob<string>('../../assets/providers/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const logos = new Map(
  Object.entries(files).map(([path, svg]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.svg'.length),
    svg,
  ]),
);

const providerLogoFiles: Record<string, string> = {
  anthropic: 'anthropic',
  'claude-cli': 'claude-color',
  openai: 'openai',
  'codex-cli': 'codex-color',
  gemini: 'gemini-color',
  mistral: 'mistral-color',
  nvidia: 'nvidia-color',
  openrouter: 'openrouter',
  groq: 'groq',
  cerebras: 'cerebras-color',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  'opencode-cli': 'opencode',
  sambanova: 'sambanova-color',
  'cloudflare-workers-ai': 'cloudflare-color',
  kilo: 'kilocode',
  'vercel-ai-gateway': 'vercel',
  huggingface: 'huggingface-color',
  'zai-glm': 'zai',
  fireworks: 'fireworks-color',
  nebius: 'nebius',
  hyperbolic: 'hyperbolic-color',
  deepinfra: 'deepinfra-color',
  novita: 'novita-color',
  together: 'together-color',
  stepfun: 'stepfun-color',
  deepseek: 'deepseek-color',
};

// Model creator, matched against the model id/name. Order matters: first match wins.
const creatorPatterns: [RegExp, string][] = [
  [/claude|anthropic/, 'claude-color'],
  [/gpt|o[134]-|codex|openai/, 'openai'],
  [/gemma/, 'gemma-color'],
  [/gemini|google/, 'gemini-color'],
  [/llama|meta/, 'meta-color'],
  [/qwen|qwq|alibaba/, 'qwen-color'],
  [/deepseek/, 'deepseek-color'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/, 'mistral-color'],
  [/nemotron|nvidia/, 'nvidia-color'],
  [/glm|zhipu|z-ai|zai/, 'zhipu-color'],
  [/kimi|moonshot/, 'kimi-color'],
  [/minimax/, 'minimax-color'],
  [/grok|x-ai|xai/, 'xai'],
  [/command|cohere/, 'cohere-color'],
  [/step-?\d|stepfun/, 'stepfun-color'],
  [/phi-|microsoft/, 'microsoft-color'],
  [/sonar|perplexity/, 'perplexity-color'],
  [/jamba|ai21/, 'ai21'],
  [/ernie|baidu/, 'baidu-color'],
  [/hunyuan|tencent/, 'tencent-color'],
  [/doubao|seed-|bytedance/, 'bytedance-color'],
  [/granite|ibm/, 'ibm'],
  [/lfm|liquid/, 'liquid'],
  [/hermes|nous/, 'nousresearch'],
  [/mimo|xiaomi/, 'xiaomimimo'],
];

export function providerLogoKey(providerId: string): string | null {
  return providerLogoFiles[providerId] ?? null;
}

/** The logo of the lab that made a model, inferred from its id or name. */
export function modelCreatorLogoKey(model: string): string | null {
  const value = model.toLowerCase();
  return creatorPatterns.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

export function ProviderLogo({
  providerId,
  model,
  name,
  size = 16,
  className,
}: {
  /** Provider id; used when `model` is absent or has no recognised creator. */
  providerId?: string;
  /** Model ref or name; shows the model creator's logo when recognised. */
  model?: string;
  /** Accessible name and monogram source. */
  name: string;
  size?: number;
  className?: string;
}) {
  const key =
    (model ? modelCreatorLogoKey(model) : null) ??
    (providerId ? providerLogoKey(providerId) : null);
  const svg = key ? logos.get(key) : undefined;
  if (!svg)
    return (
      <span
        aria-label={name}
        className={cn('ferry-provider-logo ferry-provider-logo-monogram', className)}
        role="img"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
      >
        {name.trim().slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <span
      aria-label={name}
      className={cn('ferry-provider-logo', className)}
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      style={{ width: size, height: size, fontSize: size }}
    />
  );
}

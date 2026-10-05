const externalDomainAllowlist = new Set([
  'docs.ferry.dev',
  'github.com',
  'docs.github.com',
  'openai.com',
  'platform.openai.com',
  'anthropic.com',
  'console.anthropic.com',
  'ai.google.dev',
  'console.groq.com',
  'openrouter.ai',
  'docs.mistral.ai',
  'huggingface.co',
  'docs.deepseek.com',
  'chutes.ai',
  'anyapi.ai',
  'cloudflare.com',
  'cerebras.ai',
  'zenmux.ai',
  'kiro.dev',
  'deepinfra.com',
  'fireworks.ai',
  'hyperbolic.ai',
  'kilo.ai',
  'google.com',
  'llm7.io',
  'deepseek.com',
  'mistral.ai',
  'nebius.com',
  'novita.ai',
  'nvidia.com',
  'opencode.ai',
  'ovhcloud.com',
  'stepfun.ai',
  'scaleway.com',
  'z.ai',
  'sambanova.ai',
  'vercel.com',
  'together.ai',
  'tokenrouter.io',
]);

export function isAllowlistedExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return [...externalDomainAllowlist].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

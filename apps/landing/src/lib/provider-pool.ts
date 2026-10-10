import {
  siAlibabacloud,
  siAnthropic,
  siCloudflare,
  siDatabricks,
  siDeepseek,
  siGithubcopilot,
  siGooglecloud,
  siGooglegemini,
  siHuggingface,
  siKimi,
  siMeta,
  siMinimax,
  siMistralai,
  siMoonshotai,
  siNvidia,
  siOllama,
  siOpenrouter,
  siPerplexity,
  siQwen,
  siVercel,
} from 'simple-icons';

/**
 * OpenAI blossom from simple-icons 15.22.0 (CC0). Later releases dropped the mark.
 * The Groq symbol is the public Groq mark, drawn as a single white glyph.
 * The xAI/Grok mark is from Boxicons (MIT).
 */
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

const GROQ_PATH =
  'm128 49l1.895 1.52C136.336 56.288 140.602 64.49 142 73c.097 1.823.148 3.648.161 5.474l.03 3.247l.012 3.482l.017 3.613q.014 3.783.02 7.565c.01 3.84.041 7.68.072 11.521q.01 3.683.016 7.364l.038 3.457c-.033 11.717-3.373 21.83-11.475 30.547c-4.552 4.23-9.148 7.372-14.891 9.73l-2.387 1.055c-9.275 3.355-20.3 2.397-29.379-1.13c-5.016-2.38-9.156-5.17-13.234-8.925c3.678-4.526 7.41-8.394 12-12l3.063 2.375c5.572 3.958 11.135 5.211 17.937 4.625c6.96-1.384 12.455-4.502 17-10c4.174-6.784 4.59-12.222 4.531-20.094l.012-3.473q.004-3.62-.022-7.241c-.02-3.68 0-7.36.026-11.04a3321 3321 0 0 0-.016-7.058l.025-3.312c-.098-7.996-1.732-13.21-6.681-19.47c-6.786-5.458-13.105-8.211-21.914-7.792c-7.327 1.188-13.278 4.7-17.777 10.601C75.472 72.012 73.86 78.07 75 85c2.191 7.547 5.019 13.948 12 18c5.848 3.061 10.892 3.523 17.438 3.688l2.794.103c2.256.082 4.512.147 6.768.209v16c-16.682.673-29.615.654-42.852-10.848c-8.28-8.296-13.338-19.55-13.71-31.277c.394-9.87 3.93-17.894 9.562-25.875l1.688-2.563C84.698 35.563 110.05 34.436 128 49';

const GROK_PATH =
  'M3.8 21h3.8l1.9-2.71l-1.9-2.71zm0-12.2L12.34 21h3.8L7.6 8.8zM17.4 21h2.49l.31-16.64l-3.11 4.44zm-6.96-9.49l1.9 2.71L20.2 3h-3.8z';

export interface ProviderMark {
  id: string;
  label: string;
  path: string;
  viewBox?: string;
}

export const SLOT_COUNT = 6;
export const PROVIDER_SHUFFLE_SEED = 0x5eed;

export const providerMarks: readonly ProviderMark[] = [
  { id: 'gemini', label: 'Gemini', path: siGooglegemini.path },
  { id: 'groq', label: 'Groq', path: GROQ_PATH, viewBox: '0 0 201 201' },
  { id: 'openrouter', label: 'OpenRouter', path: siOpenrouter.path },
  { id: 'mistral', label: 'Mistral', path: siMistralai.path },
  { id: 'openai', label: 'OpenAI', path: OPENAI_PATH },
  { id: 'anthropic', label: 'Anthropic', path: siAnthropic.path },
  { id: 'grok', label: 'Grok', path: GROK_PATH },
  { id: 'deepseek', label: 'DeepSeek', path: siDeepseek.path },
  { id: 'nvidia', label: 'NVIDIA', path: siNvidia.path },
  { id: 'perplexity', label: 'Perplexity', path: siPerplexity.path },
  { id: 'huggingface', label: 'Hugging Face', path: siHuggingface.path },
  { id: 'cloudflare', label: 'Cloudflare', path: siCloudflare.path },
  { id: 'meta', label: 'Meta', path: siMeta.path },
  { id: 'qwen', label: 'Qwen', path: siQwen.path },
  { id: 'ollama', label: 'Ollama', path: siOllama.path },
  { id: 'copilot', label: 'Copilot', path: siGithubcopilot.path },
  { id: 'kimi', label: 'Kimi', path: siKimi.path },
  { id: 'moonshot', label: 'Moonshot', path: siMoonshotai.path },
  { id: 'minimax', label: 'MiniMax', path: siMinimax.path },
  { id: 'vercel', label: 'Vercel', path: siVercel.path },
  { id: 'databricks', label: 'Databricks', path: siDatabricks.path },
  { id: 'google-cloud', label: 'Google Cloud', path: siGooglecloud.path },
  { id: 'alibaba', label: 'Alibaba Cloud', path: siAlibabacloud.path },
];

export function shuffleProviders<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = copy[index];
    const next = copy[swapIndex];
    if (current === undefined || next === undefined) continue;
    copy[index] = next;
    copy[swapIndex] = current;
  }
  return copy;
}

/** Split a shuffled pool so each visible slot cycles its own providers. */
export function providerSlotQueues(
  marks: readonly ProviderMark[] = providerMarks,
  slotCount: number = SLOT_COUNT,
  seed: number = PROVIDER_SHUFFLE_SEED,
): ProviderMark[][] {
  const queues: ProviderMark[][] = Array.from({ length: slotCount }, () => []);
  for (const [index, mark] of shuffleProviders(marks, seed).entries()) {
    queues[index % slotCount]?.push(mark);
  }
  return queues;
}

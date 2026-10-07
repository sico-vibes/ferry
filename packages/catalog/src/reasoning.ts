import { EffortSchema, type Effort } from '@ferry/shared';

const standard: Effort[] = ['low', 'medium', 'high'];
const reasoningParameters = ['reasoning', 'reasoning_effort', 'include_reasoning'];
export function advertisesReasoning(parameters: readonly unknown[]): boolean {
  return parameters.some((parameter) => reasoningParameters.includes(String(parameter)));
}

/** Explicit metadata wins over conservative, documented provider-family defaults. */
export function reasoningEffortsForModel(input: {
  provider: string;
  id: string;
  reasoning?: boolean | undefined;
  metadata?: Record<string, unknown>;
}): Effort[] {
  const metadata = input.metadata ?? {};
  const explicit = metadata.reasoningEfforts ?? metadata.reasoning_efforts;
  if (Array.isArray(explicit))
    return [
      ...new Set(
        explicit.flatMap((value) => {
          const parsed = EffortSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    ];
  const parameters = metadata.supported_parameters;
  if (Array.isArray(parameters) && !advertisesReasoning(parameters)) return [];
  const advertised = Array.isArray(parameters) && advertisesReasoning(parameters);
  const id = input.id
    .replace(/^.*\//, '')
    .replace(/:free$/, '')
    .toLowerCase();
  if (
    input.provider === 'openai' ||
    (input.provider === 'openrouter' && input.id.startsWith('openai/'))
  ) {
    if (/^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(id) && !/chat|non-reasoning/.test(id))
      return /^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
        ? ['minimal', ...standard]
        : [...standard];
  }
  if (
    (input.provider === 'anthropic' ||
      (input.provider === 'opencode-go' && id.startsWith('claude'))) &&
    input.reasoning
  )
    return [...standard];
  if (
    (input.provider === 'gemini' || input.provider === 'google') &&
    /^gemini-(?:2\.5|[3-9])/.test(id)
  )
    return [...standard];
  if (advertised)
    return input.provider === 'openrouter' ? ['minimal', ...standard, 'xhigh'] : [...standard];
  return [];
}

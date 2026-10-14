import type {
  CliConnection,
  CliModelCapabilities,
  CliOption,
  CliUsageSnapshot,
} from '@ferry/shared';

/** Function-call payload preserved verbatim from the caller conversation. */
export interface CliConversationToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * One message of the caller-owned conversation. Roles and tool identifiers are preserved verbatim;
 * real tool outputs stay attached to their real call ids. Only `text` is supported for the beta.
 */
export interface CliConversationMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** For `role: 'tool'`: the id of the assistant tool call this output answers. */
  tool_call_id?: string;
  /** For `role: 'assistant'`: the tool calls the model requested. */
  tool_calls?: readonly CliConversationToolCall[];
}

/** A caller-owned tool the model may request. Ferry executes it, never the transport. */
export interface CliCallerTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** A requested caller tool, returned to Core for execution on the caller side. */
export interface CliTurnToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Per-turn token usage. A dimension the CLI did not report is `null`; a reported zero stays `0`.
 * Cache and reasoning are kept separate rather than folded into input/output.
 */
export interface CliTurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

/** Result of exactly one generation turn on a private CLI invocation. */
export interface CliTurnResult {
  text: string;
  toolCalls: CliTurnToolCall[];
  usage: CliTurnUsage;
  /** The model the CLI actually used for this turn (no silent substitution). */
  responseModel: string;
}

export interface CliTransportInput {
  connection: CliConnection;
  model: CliModelCapabilities;
  options: CliOption;
  messages: readonly CliConversationMessage[];
  tools: readonly CliCallerTool[];
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  onText?: (text: string) => void;
  onProgress?: () => void;
  onUsageSnapshot?: (snapshot: CliUsageSnapshot) => void;
  /** Explicit executable seam for offline fixtures. Never set in production. */
  executable?: string;
  /** Explicit leading args seam for offline fixtures. Never set in production. */
  executableArgs?: string[];
  /**
   * Optional cached fast/priority service-tier id discovered by Core for this model. When present it
   * is used directly instead of re-running broad `model/list` discovery on every dispatch. Standard
   * speed always forces the native default tier and never uses this.
   */
  fastServiceTierId?: string;
  timeoutMs?: number;
}

export function emptyTurnUsage(): CliTurnUsage {
  return { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null };
}

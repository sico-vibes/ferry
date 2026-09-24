import type { JSONSchema } from '@modelcontextprotocol/sdk';

export interface PromptContext {
  [key: string]: unknown;
}

export interface PromptSection {
  id: string;
  order: number;
  render(ctx: PromptContext): string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolSource {
  id: string;
  listTools(): ToolDef[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

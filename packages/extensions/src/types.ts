export type PromptContext = Record<string, unknown>;

export interface PromptSection {
  id: string;
  order: number;
  render(ctx: PromptContext): string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolSource {
  id: string;
  listTools(): ToolDef[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

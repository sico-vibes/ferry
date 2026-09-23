import { sampleLane, sampleMcpServer } from '@ferry/shared/testing';
import type { Lane, McpServer } from '@ferry/shared';

export function createIntegrations() {
  const lanes: Lane[] = [
    {
      ...sampleLane,
      name: 'impl',
      implementer: 'codex',
      model: 'gpt-6-luna',
      effort: 'high',
      source: 'project',
      trusted: true,
    },
    {
      ...sampleLane,
      name: 'qa',
      implementer: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      source: 'project',
      trusted: true,
    },
    {
      ...sampleLane,
      name: 'scout',
      implementer: 'ferry',
      model: null,
      source: 'ferry',
      trusted: true,
    },
  ];
  const mcps: McpServer[] = [
    {
      ...sampleMcpServer,
      id: 'mcp_github' as typeof sampleMcpServer.id,
      name: 'GitHub',
      brand: 'github',
      transport: 'http',
      toolCount: 34,
    },
    {
      ...sampleMcpServer,
      id: 'mcp_supabase' as typeof sampleMcpServer.id,
      name: 'Supabase',
      brand: 'supabase',
      transport: 'http',
      toolCount: 21,
    },
    {
      ...sampleMcpServer,
      id: 'mcp_playwright' as typeof sampleMcpServer.id,
      name: 'Playwright',
      brand: null,
      transport: 'stdio',
      status: 'disconnected',
      verified: false,
      toolCount: 0,
    },
  ];

  return { lanes, mcps };
}

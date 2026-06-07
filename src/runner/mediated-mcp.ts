// Builds an in-process SDK MCP server whose tools DON'T do the work — each one
// forwards a mediated_call to the host broker and returns the host's result.
// Secrets never enter the container; the agent only ever sees the tool interface.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MediatedToolDef, MediatedResult } from '../shared/protocol';

export type MediatedRPC = (tool: string, args: Record<string, unknown>) => Promise<MediatedResult>;

function buildShape(params: MediatedToolDef['params']): Record<string, any> {
  const shape: Record<string, any> = {};
  for (const [k, p] of Object.entries(params ?? {})) {
    let zt: any = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
    if (p.description) zt = zt.describe(p.description);
    if (p.optional) zt = zt.optional();
    shape[k] = zt;
  }
  return shape;
}

export function buildMediatedServer(defs: MediatedToolDef[], rpc: MediatedRPC) {
  const tools = defs.map((d) =>
    tool(d.name, d.description, buildShape(d.params), async (args: any) => {
      const res = await rpc(d.name, args ?? {});
      if (res.ok) {
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: `error: ${res.error ?? 'mediated call failed'}` }], isError: true };
    }),
  );
  return {
    server: createSdkMcpServer({ name: 'sentinel', version: '0.0.1', tools }),
    toolNames: defs.map((d) => `mcp__sentinel__${d.name}`),
  };
}

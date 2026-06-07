// In-box soft tool gate (defence-in-depth ONLY — the container is the real
// boundary). Backs the SDK canUseTool callback. A breakout can disable this;
// that's fine, because the OS-level container/jail holds regardless.
import type { ToolPolicy } from '../shared/protocol';

export function evaluateGate(policy: ToolPolicy, tool: string): { allow: boolean; reason?: string } {
  // The SDK's own internal tools are always permitted.
  if (tool.startsWith('mcp__') || tool === 'StructuredOutput') return { allow: true };

  if (policy.allowOnly && policy.allowOnly.length) {
    return policy.allowOnly.includes(tool)
      ? { allow: true }
      : { allow: false, reason: `Only [${policy.allowOnly.join(', ')}] are permitted; "${tool}" is not.` };
  }
  if (policy.deny && policy.deny.includes(tool)) {
    return { allow: false, reason: `Tool "${tool}" is denied by policy.` };
  }
  return { allow: true };
}

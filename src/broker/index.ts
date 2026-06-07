// CapabilityBroker entry — dispatches a mediated_call to either an INTERNAL host
// tool (e.g. memory_search) or an HTTP service (secret injected host-side), and
// guarantees it never hangs the turn (hard timeout -> ok:false).
import { executeService, serviceManifest } from './services';
import type { MediatedResult, MediatedToolDef } from '../shared/protocol';

export { unsealVault, vaultSize } from './vault';
export { loadServices, serviceManifest } from './services';

type InternalHandler = (args: Record<string, unknown>) => Promise<MediatedResult>;
const internalTools = new Map<string, { def: MediatedToolDef; handler: InternalHandler }>();

export function registerInternalTool(def: MediatedToolDef, handler: InternalHandler): void {
  internalTools.set(def.name, { def, handler });
}

/** Combined manifest: internal host tools + HTTP services. */
export function allMediatedManifest(): MediatedToolDef[] {
  return [...[...internalTools.values()].map((v) => v.def), ...serviceManifest()];
}

export async function handleMediatedCall(tool: string, args: Record<string, unknown>, hardTimeoutMs = 18_000): Promise<MediatedResult> {
  const internal = internalTools.get(tool);
  const work: Promise<MediatedResult> = internal ? internal.handler(args) : executeService(tool, args);
  return Promise.race<MediatedResult>([
    work,
    new Promise<MediatedResult>((res) => setTimeout(() => res({ ok: false, error: 'broker timeout' }), hardTimeoutMs)),
  ]);
}

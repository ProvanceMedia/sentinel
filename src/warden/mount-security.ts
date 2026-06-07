// Mount-security: realpath-resolve a host path and reject it if it hits the
// deny-list. Used to guard any future additionalMounts (the fixed per-session
// mounts already pass). Deny-list wins; the policy lives in code (and host-owned
// config), never anything the agent can edit.
import fs from 'node:fs';

const DENY: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)id_[a-z]+$/,
  /(^|\/)credentials(\.json)?$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.claude\/\.credentials\.json$/,
  /^\/etc\/sentinel(\/|$)/,
  /docker\.sock$/,
  /^\/var\/run(\/|$)/,
];

export function isMountAllowed(hostPath: string): { allowed: boolean; reason?: string } {
  let real = hostPath;
  try {
    real = fs.realpathSync(hostPath);
  } catch {
    /* path may not exist yet; match the literal */
  }
  for (const re of DENY) {
    if (re.test(real)) return { allowed: false, reason: `mount-security denied "${real}" (${re})` };
  }
  return { allowed: true };
}

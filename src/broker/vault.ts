// Secret vault — the ONLY place plaintext service secrets live, host-side, in
// memory. Never mounted into a container; never returned to the agent.
// Sources: a host-only JSON file (SENTINEL_VAULT_FILE) + SENTINEL_VAULT_<KEY>
// env vars. (Production: sops/age unseal with a key from the systemd cred store.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const secrets = new Map<string, string>();
let unsealed = false;

export function unsealVault(): void {
  if (unsealed) return;
  unsealed = true;
  // Secret files: an explicit one, plus your private personal/config/secrets.json (a flat {KEY: value} map).
  const files = [process.env.SENTINEL_VAULT_FILE, path.join(ROOT, 'personal/config/secrets.json')];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') secrets.set(k, v);
    } catch {
      /* ignore malformed vault file */
    }
  }
  // …and SENTINEL_VAULT_<KEY> env vars (e.g. from .env).
  const prefix = 'SENTINEL_VAULT_';
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v) secrets.set(k.slice(prefix.length), v);
  }
}

export function getSecret(key: string): string | undefined {
  return secrets.get(key);
}

export function vaultSize(): number {
  return secrets.size;
}

/** Re-read the vault from disk/env (used after the dashboard adds a secret — no restart). */
export function reloadVault(): void {
  unsealed = false;
  secrets.clear();
  unsealVault();
}

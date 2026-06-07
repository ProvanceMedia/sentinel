// Mediated host-ops — the host-side actuators the boxed agent can REQUEST (never
// execute itself). This is the top RCE surface, so validators are strict and
// fuzz-tested as a build gate. v1 ships only file_write, confined to a dedicated
// root DISJOINT from code/secrets. (systemctl/deploy stay 'confirm'/unbuilt.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerInternalTool } from './index';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_DIR = process.env.SENTINEL_RUNTIME_DIR ?? path.join(ROOT, '.runtime');

export function fileOpRoot(): string {
  const r = process.env.SENTINEL_FILEOP_ROOT ?? path.join(RUNTIME_DIR, 'agent-files');
  fs.mkdirSync(r, { recursive: true });
  return fs.realpathSync(r);
}

export type PathCheck = { ok: true; resolved: string } | { ok: false; reason: string };

// Validate a requested relative path resolves to a location strictly inside the
// file-op root. Symlinks are resolved on the (existing) parent; the basename is
// charset-restricted; absolute paths, traversal, and null bytes are rejected.
export function validateFileOpPath(requested: unknown): PathCheck {
  if (typeof requested !== 'string' || requested.length === 0) return { ok: false, reason: 'empty path' };
  if (requested.length > 255) return { ok: false, reason: 'path too long' };
  if (requested.includes('\0')) return { ok: false, reason: 'null byte' };
  if (path.isAbsolute(requested)) return { ok: false, reason: 'absolute path not allowed' };
  // Reject Windows-style drive/UNC and backslashes outright.
  if (/\\/.test(requested) || /^[A-Za-z]:/.test(requested)) return { ok: false, reason: 'illegal path form' };

  const root = fileOpRoot();
  const joined = path.resolve(root, requested);

  // Resolve symlinks on the parent (target may not exist yet); reject if missing.
  const parent = path.dirname(joined);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    return { ok: false, reason: 'parent directory does not exist' };
  }
  const finalPath = path.join(realParent, path.basename(joined));

  // Must be STRICTLY inside the root (root itself is not a writable file target).
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!finalPath.startsWith(rootWithSep)) return { ok: false, reason: 'escapes file-op root' };

  const base = path.basename(finalPath);
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return { ok: false, reason: 'bad filename characters' };
  if (base === '.' || base === '..') return { ok: false, reason: 'dot path' };
  if (base.startsWith('-')) return { ok: false, reason: 'leading dash (argument-injection risk)' };

  // The final component must NOT be a symlink — otherwise writeFileSync would
  // follow it out of the root (red-team finding). lstat does not follow, so this
  // catches both existing-target and dangling symlinks. (Write also uses O_NOFOLLOW
  // for a kernel-level guarantee against a TOCTOU swap.)
  try {
    if (fs.lstatSync(finalPath).isSymbolicLink()) return { ok: false, reason: 'target is a symlink' };
  } catch {
    /* target doesn't exist yet — fine */
  }

  return { ok: true, resolved: finalPath };
}

export function registerHostOps(): void {
  registerInternalTool(
    {
      name: 'file_write',
      description: 'Write a text file into your private workspace (a sandboxed folder). Paths are relative to that folder; you cannot write elsewhere.',
      params: {
        path: { type: 'string', description: 'relative file path inside your workspace' },
        content: { type: 'string', description: 'file contents' },
      },
    },
    async (args) => {
      const check = validateFileOpPath(args.path);
      if (!check.ok) return { ok: false, error: `rejected: ${check.reason}` };
      const content = String(args.content ?? '');
      if (content.length > 1_000_000) return { ok: false, error: 'content too large' };
      try {
        // O_NOFOLLOW: if the final component is a symlink (even one swapped in after
        // validation), the open fails (ELOOP) rather than following it out of root.
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
        const fd = fs.openSync(check.resolved, flags, 0o600); // never +x
        try {
          fs.writeSync(fd, content);
        } finally {
          fs.closeSync(fd);
        }
        return { ok: true, data: `wrote ${path.relative(fileOpRoot(), check.resolved)} (${content.length} bytes)` };
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  );
}

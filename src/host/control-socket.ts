// Host-side control channel: a Unix-domain socket the runner connects to.
// Full-duplex, length-prefixed NDJSON. One runner connection per turn.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameDecoder, type RunnerFrame, type HostFrame } from '../shared/protocol';

export class ControlChannel extends EventEmitter {
  private server: net.Server;
  private conn: net.Socket | null = null;
  private decoder = new FrameDecoder();

  constructor(public readonly socketPath: string) {
    super();
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    this.server = net.createServer((c) => {
      if (this.conn) {
        c.destroy();
        return;
      }
      this.conn = c;
      c.on('data', (chunk) => {
        for (const f of this.decoder.push(chunk)) this.emit('frame', f as RunnerFrame);
      });
      c.on('close', () => this.emit('closed'));
      c.on('error', (e) => this.emit('sockerror', e));
      this.emit('connected');
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(this.socketPath, () => {
        // Allow the non-root container user (uid 10001) to connect (dev shortcut;
        // production uses userns-remap + matched ownership).
        try {
          fs.chmodSync(this.socketPath, 0o777);
        } catch {
          /* ignore */
        }
        resolve();
      }),
    );
  }

  send(f: HostFrame): void {
    this.conn?.write(encodeFrame(f));
  }

  close(): void {
    try {
      this.conn?.end();
    } catch {
      /* ignore */
    }
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch {
      /* ignore */
    }
  }
}

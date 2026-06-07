// Mock "external service" for the broker test. Returns classified data ONLY when
// the correct X-Secret header is present — proving the host broker injected it
// (the agent in the container never knows the secret).
import http from 'node:http';

const SECRET = process.env.MOCK_SECRET ?? 'sentinel-secret-123';
const PORT = Number(process.env.MOCK_PORT ?? 9099);

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/data')) {
    if (req.headers['x-secret'] !== SECRET) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or bad X-Secret' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: 'ORION-CLASSIFIED-7' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.error(`[mock] listening on 127.0.0.1:${PORT} (secret required)`));

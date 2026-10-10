/**
 * Stdio <-> HTTP bridge for MCP clients that spawn a subprocess (Claude
 * Desktop and the like). It is NOT part of the Electron main process: the
 * client launches it with `node`, it reads newline-delimited JSON-RPC on
 * stdin, forwards each message to Drey's localhost endpoint
 * (`http://127.0.0.1:$DREY_MCP_PORT/mcp`) and writes the response back on
 * stdout.
 *
 * Config the client uses -- Drey shows the exact block, with the real
 * absolute path, in Settings -> MCP. Packaged, that path is under
 * `resources/app.asar.unpacked/` (the script is `asarUnpack`'d so an
 * external `node` can execute it -- see `stdioBridgePath()` in main.ts):
 *   {
 *     "command": "node",
 *     "args": ["<abs>/dist-electron/electron/mcp/stdio-bridge.js"],
 *     "env": { "DREY_MCP_PORT": "4319" }
 *   }
 *
 * Requires the Drey window to be running with the HTTP endpoint enabled.
 */
import * as http from 'node:http';
import * as readline from 'node:readline';

const port = Number(process.env['DREY_MCP_PORT'] ?? '4319');

function forward(message: string): Promise<string> {
  return new Promise((resolve) => {
    const body = Buffer.from(message, 'utf-8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The endpoint's Streamable HTTP transport requires both.
          Accept: 'application/json, text/event-stream',
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      },
    );
    req.on('error', (err) => {
      // Surface a JSON-RPC error rather than killing the client's session.
      let id: unknown = null;
      try {
        id = (JSON.parse(message) as { id?: unknown }).id ?? null;
      } catch {
        id = null;
      }
      resolve(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: `Drey MCP endpoint unreachable on 127.0.0.1:${port} (${err.message}). Is Drey running with the HTTP endpoint enabled?`,
          },
        }),
      );
    });
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') {
    return;
  }
  void forward(trimmed).then((response) => {
    if (response.trim() !== '') {
      process.stdout.write(response.replace(/\n/g, ' ') + '\n');
    }
  });
});

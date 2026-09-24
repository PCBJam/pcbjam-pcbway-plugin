// A stand-in for PCBWay's KiCad upload endpoint (POST /Common/KiCadUpFile/),
// for tests and manual runs. PCBWay has no public sandbox. It checks what the
// real plugin sends (a ZIP in `upload[file]` plus board size and layers) and
// answers like PCBWay's own KiCad plugin expects: {"redirect": "<quote page>"}.
// The quote page shows what arrived, so a manual run can be checked by eye.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @param {{ port?: number, host?: string, publicOrigin?: string, contentType?: string }} options
 *   publicOrigin: the https origin the quote links use (a tunnel or a test name).
 *   contentType: the answer's content type; PCBWay's real one is unverified.
 */
export async function startPcbwayMock({ port = 3058, host = "127.0.0.1", publicOrigin, contentType = "application/json" } = {}) {
  const uploads = new Map();
  const server = createServer(async (req, res) => {
    const origin = publicOrigin ?? `http://${host}:${server.address().port}`;
    const url = new URL(req.url, "http://mock");
    try {
      if (req.method === "POST" && url.pathname === "/Common/KiCadUpFile/") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) throw Object.assign(new Error("Upload too large"), { status: 413 });
          chunks.push(chunk);
        }
        const form = await new Request("http://mock/upload", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) }).formData();
        const file = form.get("upload[file]");
        if (!file || typeof file === "string") throw Object.assign(new Error("Missing upload[file]"), { status: 400 });
        const bytes = new Uint8Array(await file.arrayBuffer());
        let files;
        try {
          files = Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, size: data.length }));
        } catch {
          throw Object.assign(new Error("upload[file] is not a ZIP"), { status: 400 });
        }
        const board = {};
        for (const key of ["boardWidth", "boardHeight", "boardLayer"]) {
          const value = form.get(key);
          if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) throw Object.assign(new Error(`Missing or invalid ${key}`), { status: 400 });
          board[key] = value;
        }
        const id = randomUUID();
        uploads.set(id, { id, filename: file.name, size: bytes.length, files, board, at: new Date().toISOString() });
        res.writeHead(200, { "content-type": contentType });
        res.end(JSON.stringify({ redirect: `${origin}/mock-quote/${id}` }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/mock-quote/")) {
        const upload = uploads.get(url.pathname.slice("/mock-quote/".length));
        if (!upload) { res.writeHead(404, { "content-type": "text/plain" }).end("No such upload"); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Mock PCBWay quote</title><body style="font:15px system-ui;max-width:760px;margin:40px auto">
<h1>Mock PCBWay quote</h1><p data-testid="mock-quote">Received <strong>${escape(upload.filename)}</strong> (${upload.size} bytes):
board ${escape(upload.board.boardWidth)} × ${escape(upload.board.boardHeight)} mm, ${escape(upload.board.boardLayer)} layers, ${upload.files.length} files.</p>
<ul>${upload.files.map((f) => `<li>${escape(f.name)} <small>${f.size} bytes</small></li>`).join("")}</ul>
<p><small>This is a stand-in for PCBWay's quote page; nothing was ordered.</small></p></body>`);
        return;
      }
      if (req.method === "GET" && url.pathname === "/mock/uploads") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([...uploads.values()]));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    } catch (error) {
      res.writeHead(error.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    origin: `http://${host}:${server.address().port}`,
    uploads,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

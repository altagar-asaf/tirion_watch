#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [portArg, outDirArg] = process.argv.slice(2);
if (!portArg || !outDirArg) {
  console.error("Usage: node otlp_capture_receiver.mjs <port> <out-dir>");
  process.exit(2);
}

const port = Number(portArg);
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

let counter = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const ts = Date.now();
    const id = `${String(ts).padStart(13, "0")}-${String(counter).padStart(4, "0")}`;
    counter += 1;

    const suffix = req.url?.includes("/traces") ? "traces" : req.url?.includes("/metrics") ? "metrics" : "logs";
    writeFileSync(join(outDir, `${id}.${suffix}.body`), body);
    writeFileSync(join(outDir, `${id}.${suffix}.meta.json`), JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      length: body.length,
    }, null, 2));

    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}\n");
  });
});

server.listen(port, "127.0.0.1", () => {
  console.error(`otlp_capture_receiver listening on http://127.0.0.1:${port}`);
});

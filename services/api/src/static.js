/**
 * Serve the built web client.
 *
 * Vite names every asset after a hash of its content, so those files can be
 * cached forever; index.html is the one file that changes in place, so it is
 * always revalidated. A new deploy therefore reaches browsers immediately
 * while unchanged assets are never downloaded twice.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * @param {Object} response - Node response
 * @param {string} root - Directory holding the build
 * @param {string} pathname - Request path
 * @returns {Promise<void>}
 */
export async function serveStatic(response, root, pathname) {
  const base = path.resolve(root);
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let file = path.resolve(base, relative);

  // Never serve outside the web root, whatever the path claims.
  if (file !== base && !file.startsWith(base + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Unknown paths get the app shell, so client-side routes still load.
    file = path.join(base, "index.html");
    info = await stat(file).catch(() => null);
    if (!info) {
      response.writeHead(404).end("Not found");
      return;
    }
  }

  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  response.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(response);
}

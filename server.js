const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 8000;
const ROSBRIDGE_HOST = "127.0.0.1";
const ROSBRIDGE_PORT = 9090;
const ROOT = __dirname;
const TELEOP_TOKEN = process.env.TELEOP_TOKEN;

if (!TELEOP_TOKEN || TELEOP_TOKEN.length < 32) {
  throw new Error("TELEOP_TOKEN must be set to a random value of at least 32 characters");
}

function hasValidToken(request) {
  const cookies = Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map(part => part.trim().split("="))
      .filter(([key, value]) => key && value)
  );
  const supplied = cookies.teleop_token || "";
  const expectedBuffer = Buffer.from(TELEOP_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(data);
  });
});

server.on("upgrade", (request, client, head) => {
  if (new URL(request.url, "http://localhost").pathname !== "/rosbridge") {
    client.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  if (!hasValidToken(request)) {
    client.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstream = net.connect(ROSBRIDGE_PORT, ROSBRIDGE_HOST, () => {
    const headers = request.rawHeaders
      .reduce((lines, value, index, values) => {
        if (index % 2 === 0 && value.toLowerCase() !== "cookie") {
          lines.push(`${value}: ${values[index + 1]}`);
        }
        return lines;
      }, [])
      .join("\r\n");
    upstream.write(`GET / HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });

  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`WebXR server listening on http://${HOST}:${PORT}`);
  console.log("WebSocket proxy requires the TELEOP_TOKEN browser cookie");
  console.log(`WebSocket proxy /rosbridge -> ws://${ROSBRIDGE_HOST}:${ROSBRIDGE_PORT}`);
});

import net from "node:net";
import type { ProxyConfig } from "../types.js";
import { connectUpstream, readUntil } from "./upstream.js";

export interface RelayHandle {
  /** `http://127.0.0.1:<port>` to hand to Chrome via --proxy-server. */
  url: string;
  port: number;
  connections: number;
  close: () => Promise<void>;
}

interface RequestLine {
  method: string;
  target: string;
  version: string;
}

function parseRequestLine(head: string): RequestLine | null {
  const first = head.split("\r\n")[0] ?? "";
  const match = first.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/);
  if (!match) return null;
  return { method: match[1]!, target: match[2]!, version: match[3]! };
}

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } | null {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : fallbackPort;
    return Number.isInteger(port) && port > 0 ? { host, port } : null;
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon === -1) return { host: value, port: fallbackPort };
  const host = value.slice(0, lastColon);
  const port = Number(value.slice(lastColon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/** Strip hop-by-hop headers that must not travel through a tunnel. */
function rewritePlainHeaders(head: string, originForm: string): string {
  const lines = head.split("\r\n").filter(Boolean);
  const first = lines.shift();
  if (!first) return head;
  const kept = lines.filter((line) => {
    const name = line.split(":", 1)[0]?.toLowerCase() ?? "";
    return name !== "proxy-connection" && name !== "proxy-authorization";
  });
  const originalVersion = first.split(" ").pop() || "HTTP/1.1";
  return [`${first.split(" ")[0]} ${originForm} ${originalVersion}`, ...kept, "", ""].join(
    "\r\n",
  );
}

/**
 * Starts a local forward proxy that authenticates to an upstream and exposes a
 * plain, credential-free `http://127.0.0.1:<port>` endpoint. Chrome cannot
 * reliably send proxy credentials from the command line, so this is the piece
 * that makes authenticated HTTP/SOCKS5 proxies work.
 */
export async function startRelay(
  upstream: ProxyConfig,
  listenHost = "127.0.0.1",
): Promise<RelayHandle> {
  const sockets = new Set<net.Socket>();
  const handle: RelayHandle = {
    url: "",
    port: 0,
    connections: 0,
    close: async () => {},
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.setNoDelay(true);
    client.setTimeout(120_000, () => client.destroy());
    handle.connections += 1;

    let upstreamSocket: net.Socket | null = null;
    let responded = false;
    const fail = (message: string) => {
      if (!responded && !client.destroyed) {
        responded = true;
        client.write(
          [
            "HTTP/1.1 502 Bad Gateway",
            "Content-Type: text/plain",
            "Connection: close",
            "",
            message,
          ].join("\r\n"),
        );
      }
      client.destroy();
      upstreamSocket?.destroy();
    };

    client.once("error", () => {
      upstreamSocket?.destroy();
    });
    client.once("close", () => {
      sockets.delete(client);
      upstreamSocket?.destroy();
    });

    void (async () => {
      let head: Buffer;
      try {
        head = await readUntil(client, "\r\n\r\n", 64 * 1024);
      } catch {
        client.destroy();
        return;
      }

      const headText = head.toString("latin1");
      const line = parseRequestLine(headText);
      if (!line) {
        fail("Malformed request");
        return;
      }

      let host: string;
      let port: number;
      let originForm = line.target;

      if (line.method === "CONNECT") {
        const parsed = splitHostPort(line.target, 443);
        if (!parsed) {
          fail("Malformed CONNECT target");
          return;
        }
        host = parsed.host;
        port = parsed.port;
      } else {
        let absolute: URL;
        try {
          absolute = new URL(line.target);
        } catch {
          fail("Expected an absolute-form request URL");
          return;
        }
        if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
          fail(`Unsupported protocol ${absolute.protocol}`);
          return;
        }
        host = absolute.hostname;
        port = Number(absolute.port || (absolute.protocol === "https:" ? 443 : 80));
        originForm = `${absolute.pathname}${absolute.search}` || "/";
      }

      try {
        upstreamSocket = await connectUpstream(upstream, host, port);
      } catch (err) {
        fail(`Upstream connection failed: ${(err as Error).message}`);
        return;
      }

      sockets.add(upstreamSocket);
      upstreamSocket.once("close", () => {
        if (upstreamSocket) sockets.delete(upstreamSocket);
        client.destroy();
      });
      upstreamSocket.once("error", () => {
        client.destroy();
      });

      if (line.method === "CONNECT") {
        responded = true;
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: virtual-browser\r\n\r\n");
      } else {
        upstreamSocket.write(rewritePlainHeaders(headText, originForm));
      }

      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
      if (client.isPaused()) client.resume();
    })().catch((err) => {
      fail((err as Error).message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("relay: could not allocate a local port");
  }

  handle.port = address.port;
  handle.url = `http://${listenHost}:${address.port}`;
  handle.close = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return handle;
}

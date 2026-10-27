import net from "node:net";
import tls from "node:tls";
import type { ProxyConfig } from "../types.js";
import { socks5Handshake } from "./socks5.js";

const DEFAULT_TIMEOUT = 15_000;

/**
 * Read until `delimiter` (inclusive). Whatever was received after the
 * delimiter is pushed back onto the socket, so the caller can use the socket
 * as a raw tunnel without losing bytes.
 */
export async function readUntil(
  socket: net.Socket,
  delimiter = "\r\n\r\n",
  maxBytes = 64 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const chunk = socket.read() as Buffer | null;
    if (chunk && chunk.length > 0) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) throw new Error("proxy: response header too large");
      const buffer = Buffer.concat(chunks);
      const index = buffer.indexOf(delimiter);
      if (index !== -1) {
        const end = index + delimiter.length;
        const rest = buffer.subarray(end);
        if (rest.length > 0) socket.unshift(rest);
        return buffer.subarray(0, end);
      }
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("proxy: connection closed"));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        socket.off("readable", onReadable);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      socket.once("readable", onReadable);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }
}

function connectTcp(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout connecting to ${host}:${port}`));
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setTimeout(0);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectTls(host: string, port: number, timeout: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout connecting to ${host}:${port}`));
    }, timeout);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.setTimeout(0);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function formatHostPort(host: string, port: number): string {
  const value = net.isIP(host) === 6 ? `[${host}]` : host;
  return `${value}:${port}`;
}

function basicAuth(username?: string, password?: string): string | undefined {
  if (!username && !password) return undefined;
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function connectViaHttpProxy(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeout: number,
): Promise<net.Socket> {
  const socket =
    proxy.type === "https"
      ? await connectTls(proxy.host, proxy.port, timeout)
      : await connectTcp(proxy.host, proxy.port, timeout);

  try {
    const auth = basicAuth(proxy.username, proxy.password);
    const lines = [
      `CONNECT ${formatHostPort(targetHost, targetPort)} HTTP/1.1`,
      `Host: ${formatHostPort(targetHost, targetPort)}`,
      "Proxy-Connection: keep-alive",
    ];
    if (auth) lines.push(`Proxy-Authorization: ${auth}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);

    const response = await withTimeout(
      readUntil(socket, "\r\n\r\n", 16 * 1024),
      timeout,
      () => socket.destroy(),
      `proxy: CONNECT timed out after ${timeout}ms`,
    );
    const firstLine = response.toString("latin1").split("\r\n")[0] ?? "";
    const match = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    if (!match) throw new Error("proxy: malformed CONNECT response");
    const status = Number(match[1]);
    if (status !== 200) {
      throw new Error(`proxy: CONNECT rejected with HTTP ${status}`);
    }
    // If the proxy sent a body with the 200 response, drop it; CONNECT
    // responses must not have a body.
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * Open a raw TCP tunnel to `targetHost:targetPort` through the given upstream
 * (SOCKS5, HTTP CONNECT, HTTPS CONNECT) or directly when no proxy is set.
 */
export async function connectUpstream(
  proxy: ProxyConfig | undefined,
  targetHost: string,
  targetPort: number,
  timeout = DEFAULT_TIMEOUT,
): Promise<net.Socket> {
  if (!proxy) return connectTcp(targetHost, targetPort, timeout);

  if (proxy.type === "socks5") {
    const socket = await connectTcp(proxy.host, proxy.port, timeout);
    try {
      socket.setTimeout(timeout);
      socket.once("timeout", () =>
        socket.destroy(new Error(`socks5: handshake timed out after ${timeout}ms`)),
      );
      await socks5Handshake(socket, targetHost, targetPort, {
        username: proxy.username,
        password: proxy.password,
      });
      socket.setTimeout(0);
      return socket;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  return connectViaHttpProxy(proxy, targetHost, targetPort, timeout);
}

/** Minimal HTTP(S) GET through the configured upstream. */
export async function getViaProxy(
  proxy: ProxyConfig | undefined,
  url: string,
  options: { timeout?: number; maxBytes?: number } = {},
): Promise<{ status: number; body: string; latencyMs: number }> {
  const started = Date.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:";
  const port = Number(parsed.port || (secure ? 443 : 80));
  const host = parsed.hostname;

  const raw = await connectUpstream(proxy, host, port, timeout);
  const socket = secure
    ? tls.connect({
        socket: raw,
        servername: host,
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized: true,
      })
    : raw;

  try {
    if (secure) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once("secureConnect", () => resolve());
          socket.once("error", (err) => reject(err));
        }),
        timeout,
        () => socket.destroy(),
        `TLS handshake timed out after ${timeout}ms`,
      );
    }

    const path = `${parsed.pathname}${parsed.search}`;
    socket.write(
      [
        `GET ${path || "/"} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "User-Agent: virtual-browser/0.2 (+local)",
        "Accept: application/json,text/plain,*/*",
        "Accept-Encoding: identity",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    const chunks: Buffer[] = [];
    let total = 0;
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timeout after ${timeout}ms`));
      }, timeout);

      socket.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("end", () => {
        ended = true;
        clearTimeout(timer);
        resolve();
      });
      socket.once("close", () => {
        if (!ended) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const raw = Buffer.concat(chunks).toString("utf8");
    const split = raw.indexOf("\r\n\r\n");
    const header = split === -1 ? raw : raw.slice(0, split);
    let body = split === -1 ? "" : raw.slice(split + 4);
    const status = Number(header.match(/^HTTP\/\d\.\d\s+(\d{3})/)?.[1] ?? 0);

    if (/transfer-encoding:\s*chunked/i.test(header)) {
      body = decodeChunked(body);
    }
    return { status, body, latencyMs: Date.now() - started };
  } finally {
    socket.destroy();
  }
}

function decodeChunked(input: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < input.length) {
    const lineEnd = input.indexOf("\r\n", index);
    if (lineEnd === -1) break;
    const size = parseInt(input.slice(index, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    out.push(input.slice(start, start + size));
    index = start + size + 2;
  }
  return out.join("");
}

import net from "node:net";
import type { ProxyConfig } from "../types.js";

/** Read exactly `n` bytes from a paused/readable socket. */
export async function readExact(socket: net.Socket, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = n;
  while (remaining > 0) {
    const chunk = socket.read(remaining) as Buffer | null;
    if (chunk && chunk.length > 0) {
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("socket closed during handshake"));
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
  return Buffer.concat(chunks);
}

function encodeTarget(host: string, port: number): Buffer {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);

  const family = net.isIP(host);
  if (family === 4) {
    return Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(host.split(".").map((n) => Number(n) & 0xff)),
      portBuf,
    ]);
  }
  if (family === 6) {
    // Expand the IPv6 address into 8 groups.
    const groups: number[] = [];
    const [head, tail = ""] = host.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail ? tail.split(":").filter(Boolean) : [];
    for (const part of headParts) groups.push(parseInt(part, 16));
    const missing = 8 - headParts.length - tailParts.length;
    for (let i = 0; i < missing; i++) groups.push(0);
    for (const part of tailParts) groups.push(parseInt(part, 16));
    const buf = Buffer.alloc(16);
    groups.forEach((g, i) => buf.writeUInt16BE(g || 0, i * 2));
    return Buffer.concat([Buffer.from([0x04]), buf, portBuf]);
  }

  const hostBuf = Buffer.from(host, "utf8");
  if (hostBuf.length > 255) throw new Error("socks5: hostname too long");
  return Buffer.concat([
    Buffer.from([0x03, hostBuf.length]),
    hostBuf,
    portBuf,
  ]);
}

function replyMessage(code: number): string {
  switch (code) {
    case 1:
      return "general SOCKS server failure";
    case 2:
      return "connection not allowed by ruleset";
    case 3:
      return "network unreachable";
    case 4:
      return "host unreachable";
    case 5:
      return "connection refused";
    case 6:
      return "TTL expired";
    case 7:
      return "command not supported";
    case 8:
      return "address type not supported";
    default:
      return `unknown SOCKS5 error ${code}`;
  }
}

/**
 * Authenticate against a SOCKS5 proxy and open a tunnel to `host:port`.
 * The socket keeps any unread bytes buffered, so callers can start piping
 * immediately after this resolves.
 */
export async function socks5Handshake(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  credentials?: { username?: string; password?: string },
): Promise<void> {
  const hasAuth = Boolean(credentials?.username || credentials?.password);
  const methods = hasAuth ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));

  const greeting = await readExact(socket, 2);
  if (greeting[0] !== 0x05) throw new Error("socks5: bad protocol version");
  const method = greeting[1];
  if (method === 0xff) throw new Error("socks5: no acceptable auth method");

  if (method === 0x02) {
    const username = Buffer.from(credentials?.username ?? "", "utf8");
    const password = Buffer.from(credentials?.password ?? "", "utf8");
    if (username.length > 255 || password.length > 255) {
      throw new Error("socks5: credentials too long");
    }
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const authReply = await readExact(socket, 2);
    if (authReply[1] !== 0x00) throw new Error("socks5: authentication failed");
  } else if (method !== 0x00) {
    throw new Error(`socks5: unsupported auth method 0x${method.toString(16)}`);
  }

  socket.write(
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeTarget(targetHost, targetPort)]),
  );

  const head = await readExact(socket, 4);
  if (head[0] !== 0x05) throw new Error("socks5: malformed reply");
  if (head[1] !== 0x00) throw new Error(`socks5: ${replyMessage(head[1] ?? 0)}`);

  const atyp = head[3];
  if (atyp === 0x01) await readExact(socket, 4 + 2);
  else if (atyp === 0x04) await readExact(socket, 16 + 2);
  else if (atyp === 0x03) {
    const len = await readExact(socket, 1);
    await readExact(socket, (len[0] ?? 0) + 2);
  } else {
    throw new Error(`socks5: unknown address type ${atyp}`);
  }
}

export function isSocksProxy(proxy: ProxyConfig): boolean {
  return proxy.type === "socks5";
}

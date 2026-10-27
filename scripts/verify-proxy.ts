/**
 * End-to-end check for the proxy stack without touching Chrome:
 *
 *   npx tsx scripts/verify-proxy.ts
 *
 * Starts a throwaway authenticated HTTP CONNECT proxy and a throwaway
 * authenticated SOCKS5 proxy, then verifies that
 *   1. connectUpstream() can authenticate through both,
 *   2. the local relay exposes a credential-free endpoint for Chrome,
 *   3. plain (absolute-form) HTTP requests survive the relay,
 *   4. a wrong password is rejected.
 */
import net from "node:net";
import { checkProxy } from "../src/lib/geo.js";
import { startRelay } from "../src/lib/relay.js";
import { readExact } from "../src/lib/socks5.js";
import { connectUpstream, getViaProxy } from "../src/lib/upstream.js";
import type { ProxyConfig } from "../src/types.js";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  // Test tunnels can stay half-open after the assertions finish; don't let a
  // pending connection keep the verification script alive.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Authenticated HTTP CONNECT proxy                                    */
/* ------------------------------------------------------------------ */

function httpProxy(username: string, password: string): net.Server {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);

      const head = buffer.subarray(0, end).toString("latin1");
      const rest = buffer.subarray(end + 4);
      const [firstLine, ...lines] = head.split("\r\n");
      const [method, target] = (firstLine ?? "").split(" ");

      if (method !== "CONNECT" || !target) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }

      const auth = lines.find((line) => /^proxy-authorization:/i.test(line))?.split(/:\s*/)[1];
      if (auth !== expected) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n',
        );
        return;
      }

      const [host, portRaw] = target.split(":");
      const port = Number(portRaw);
      const upstream = net.connect({ host, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  });
}

/* ------------------------------------------------------------------ */
/* Authenticated SOCKS5 proxy                                          */
/* ------------------------------------------------------------------ */

function socksProxy(username: string, password: string): net.Server {
  return net.createServer((client) => {
    void (async () => {
      try {
        const greeting = await readExact(client, 2);
        if (greeting[0] !== 0x05) throw new Error("bad version");
        const methods = await readExact(client, greeting[1] ?? 0);
        if (!methods.includes(0x02)) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        client.write(Buffer.from([0x05, 0x02]));

        const authVersion = await readExact(client, 1);
        if (authVersion[0] !== 0x01) throw new Error("bad auth version");
        const userLength = (await readExact(client, 1))[0]!;
        const user = (await readExact(client, userLength)).toString("utf8");
        const passLength = (await readExact(client, 1))[0]!;
        const pass = (await readExact(client, passLength)).toString("utf8");

        if (user !== username || pass !== password) {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));

        const requestHead = await readExact(client, 4);
        const atyp = requestHead[3];
        let host = "";
        if (atyp === 0x01) {
          host = [...(await readExact(client, 4))].join(".");
        } else if (atyp === 0x03) {
          const length = (await readExact(client, 1))[0]!;
          host = (await readExact(client, length)).toString("utf8");
        } else if (atyp === 0x04) {
          const bytes = await readExact(client, 16);
          const groups: string[] = [];
          for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
          host = groups.join(":");
        } else {
          throw new Error("bad atyp");
        }
        const port = (await readExact(client, 2)).readUInt16BE(0);

        const upstream = await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.connect({ host, port }, () => resolve(socket));
          socket.once("error", reject);
        });
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      } catch {
        client.destroy();
      }
    })();
  });
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

async function expectRejected(proxy: ProxyConfig, label: string): Promise<void> {
  try {
    const socket = await connectUpstream(proxy, "ipwho.is", 443, 8000);
    socket.destroy();
    throw new Error(`${label}: expected the proxy to reject wrong credentials`);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("expected the proxy to reject")) throw err;
    console.log(`  ok  ${label}: rejected (${message})`);
  }
}

async function main(): Promise<void> {
  const httpServer = httpProxy("relay-user", "relay-pass");
  const socksServer = socksProxy("socks-user", "socks-pass");
  const httpPort = await listen(httpServer);
  const socksPort = await listen(socksServer);

  const httpConfig: ProxyConfig = {
    type: "http",
    host: "127.0.0.1",
    port: httpPort,
    username: "relay-user",
    password: "relay-pass",
  };
  const socksConfig: ProxyConfig = {
    type: "socks5",
    host: "127.0.0.1",
    port: socksPort,
    username: "socks-user",
    password: "socks-pass",
  };

  try {
    console.log(`test proxies listening: http=${httpPort} socks=${socksPort}`);
    for (const [label, proxy] of [
      ["HTTP CONNECT proxy", httpConfig],
      ["SOCKS5 proxy", socksConfig],
    ] as const) {
      console.log(`  ..  ${label}: running geolocation probe`);
      const result = await checkProxy(proxy);
      if (!result.ok) throw new Error(`${label}: ${result.error}`);
      console.log(`  ok  ${label}: exit IP ${result.geo?.ip} (${result.geo?.countryCode})`);
    }

    const relay = await startRelay(httpConfig);
    try {
      const viaRelay = await getViaProxy(
        { type: "http", host: "127.0.0.1", port: relay.port },
        "https://ipwho.is/?fields=ip,country_code",
        { timeout: 10_000 },
      );
      const parsed = JSON.parse(viaRelay.body) as { ip?: string };
      if (viaRelay.status !== 200 || !parsed.ip) throw new Error("relay CONNECT failed");
      console.log(`  ok  local relay (CONNECT): exit IP ${parsed.ip}`);

      const plain = await new Promise<string>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: relay.port }, () => {
          socket.write(
            "GET http://ipwho.is/?fields=ip,country_code HTTP/1.1\r\nHost: ipwho.is\r\nConnection: close\r\n\r\n",
          );
        });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("plain HTTP timeout"));
        }, 10_000);
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        socket.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      if (!plain.startsWith("HTTP/1.1 200") || !plain.includes('"ip"')) {
        throw new Error(`relay plain HTTP failed: ${plain.slice(0, 120)}`);
      }
      console.log("  ok  local relay (plain HTTP absolute-form)");

      await expectRejected(
        { ...httpConfig, password: "wrong" },
        "HTTP proxy wrong password",
      );
      await expectRejected(
        { ...socksConfig, password: "wrong" },
        "SOCKS5 wrong password",
      );
    } finally {
      await relay.close();
    }

    console.log("\nOK: proxy stack verified.");
  } finally {
    await close(httpServer);
    await close(socksServer);
  }
}

main()
  .then(() => {
    // Keep-alive sockets from the probe pool are not worth waiting for.
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAILED:", err);
    process.exit(1);
  });

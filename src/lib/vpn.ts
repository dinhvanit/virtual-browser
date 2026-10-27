import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { VPN_BOOT_TIMEOUT_MS, WIREPROXY_PATH } from "../config.js";

interface VpnProcess {
  child: ChildProcess;
  port: number;
  log: string[];
  startedAt: string;
}

const running = new Map<string, VpnProcess>();

function parseBindAddress(configText: string): number {
  // Prefer the [Socks5] section, since that is what Chrome can consume.
  const socksSection = configText.match(/\[Socks5\]([\s\S]*?)(?=\n\[|$)/i);
  const scope = socksSection ? socksSection[1]! : configText;
  const match = scope.match(/^\s*BindAddress\s*=\s*([^\s#]+)/im);
  if (!match) return 0;
  const value = match[1]!;
  const portMatch = value.match(/:(\d{2,5})$/);
  return portMatch ? Number(portMatch[1]) : 0;
}

function canConnect(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  child: ChildProcess,
  /** Spawn failures never set `exitCode`, so poll them separately. */
  spawnError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failure = spawnError();
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error("wireproxy exited before opening its port");
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wireproxy did not open 127.0.0.1:${port} within ${timeoutMs}ms`);
}

export interface VpnStatus {
  active: boolean;
  port?: number;
  configPath?: string;
  startedAt?: string;
  log?: string[];
}

export function vpnStatus(profileId: string): VpnStatus {
  const entry = running.get(profileId);
  if (!entry) return { active: false };
  return {
    active: true,
    port: entry.port,
    startedAt: entry.startedAt,
    log: entry.log.slice(-20),
  };
}

/**
 * Start `wireproxy` for a profile and wait until its local SOCKS5 port accepts
 * connections. The returned port is what the rest of the pipeline treats as a
 * SOCKS5 proxy.
 */
export async function startVpn(profileId: string, configPath: string): Promise<number> {
  const existing = running.get(profileId);
  if (existing) return existing.port;

  if (!WIREPROXY_PATH) {
    throw new Error(
      "wireproxy binary not found. Install it or set VB_WIREPROXY=/path/to/wireproxy.",
    );
  }

  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) throw new Error(`WireGuard config not found: ${resolved}`);
  const text = await fsp.readFile(resolved, "utf8");
  const port = parseBindAddress(text);
  if (!port) {
    throw new Error(
      "Could not find a [Socks5] BindAddress in the WireGuard config (e.g. BindAddress = 127.0.0.1:25344).",
    );
  }

  const child = spawn(WIREPROXY_PATH, ["-c", resolved], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // `spawn` reports exec failures (ENOENT, EACCES) as an async event; without a
  // listener Node would crash the whole server. Keep listening after startup
  // too, so a late error never becomes unhandled.
  let spawnFailure: Error | null = null;
  child.on("error", (err) => {
    spawnFailure = err;
  });
  const log: string[] = [];
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) log.push(line.trim());
    }
    if (log.length > 100) log.splice(0, log.length - 100);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  try {
    await waitForPort(port, VPN_BOOT_TIMEOUT_MS, child, () => spawnFailure);
  } catch (err) {
    child.kill("SIGKILL");
    const reason = spawnFailure
      ? `failed to start wireproxy: ${(spawnFailure as Error).message}`
      : (err as Error).message;
    const tail = log.slice(-5).join(" | ");
    throw new Error(`${reason}${tail ? ` (${tail})` : ""}`);
  }

  running.set(profileId, {
    child,
    port,
    log,
    startedAt: new Date().toISOString(),
  });

  child.once("exit", () => {
    const entry = running.get(profileId);
    if (entry?.child === child) running.delete(profileId);
  });

  return port;
}

export async function stopVpn(profileId: string): Promise<void> {
  const entry = running.get(profileId);
  if (!entry) return;
  running.delete(profileId);
  const { child } = entry;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function stopAllVpn(): Promise<void> {
  await Promise.all([...running.keys()].map((id) => stopVpn(id)));
}

import crypto from "node:crypto";

/** FNV-1a 32-bit; stable across runs and platforms. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Picker {
  next: () => number;
  int: (minInclusive: number, maxInclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
}

export function createPicker(seed: string): Picker {
  const next = mulberry32(hashSeed(seed));
  const int = (min: number, max: number) =>
    Math.floor(next() * (max - min + 1)) + min;
  return {
    next,
    int,
    pick: <T>(items: readonly T[]) => items[int(0, items.length - 1)]!,
    chance: (p: number) => next() < p,
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Constant-time-ish comparison for the optional API token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

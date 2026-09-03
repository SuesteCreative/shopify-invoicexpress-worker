/**
 * Minimal Node declarations for the few tests that have to read the repo off
 * disk (the Lodgify direct-call guard, for one).
 *
 * WHY NOT `@types/node`. This project's tsconfig deliberately loads only
 * `@cloudflare/workers-types`, so Worker code cannot reach for a Node API that
 * will not exist at runtime — `Buffer`, `fs`, `process.env` — and have it
 * typecheck anyway. Installing the full Node types to satisfy one test would
 * give that mistake back to every file in `src/`.
 *
 * So: exactly what those tests use, and nothing more. Vitest runs them in Node,
 * where these are real.
 */

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare const process: { cwd(): string };

// Hackathon-grade JSON file persistence (gitignored).
// No DB on purpose: two small JSON maps, read-modify-write per request.
// TODO post-hackathon: replace with a real store (Redis or Postgres).
//
// Serverless filesystems (Vercel/Railway) are read-only except for the OS temp
// dir, so writing under the app dir throws EROFS. Use os.tmpdir() on serverless
// (ephemeral + per-instance, fine for this demo's short-lived state), the app
// dir locally, or an explicit DATA_DIR override.

import { promises as fs } from "fs";
import os from "os";
import path from "path";

const IS_SERVERLESS =
  process.env.VERCEL !== undefined ||
  process.env.RAILWAY_ENVIRONMENT !== undefined ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

const DATA_DIR =
  process.env.DATA_DIR ??
  (IS_SERVERLESS
    ? path.join(os.tmpdir(), "gohealthme-data")
    : path.join(process.cwd(), ".data"));

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${file} from ${DATA_DIR}: ${String(err)}`);
  }
}

export async function writeJson<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

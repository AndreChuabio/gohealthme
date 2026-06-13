// Hackathon-grade JSON file persistence under app/.data/ (gitignored).
// No DB on purpose: two small JSON maps, read-modify-write per request.
// TODO post-hackathon: replace with a real store (Redis or Postgres).

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");

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
    throw new Error(`Failed to read ${file} from .data/: ${String(err)}`);
  }
}

export async function writeJson<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

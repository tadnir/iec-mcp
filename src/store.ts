import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tokens } from "./okta.js";

/** What a sign-in leaves on disk: the tokens, and when the chosen length ends. */
export interface SavedSession {
  version: 1;
  tokens: Tokens;
  signedInAt: string;
  /** Epoch ms; the session is dropped here regardless of IEC. */
  endsAt?: number;
}

export interface SessionStore {
  load(): Promise<SavedSession | undefined>;
  save(session: SavedSession): Promise<void>;
  clear(): Promise<void>;
}

export function configDir(): string {
  if (process.env.IEC_CONFIG_DIR) return process.env.IEC_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "iec-mcp");
  return join(homedir(), ".config", "iec-mcp");
}

/** A session file only this user can read, written atomically. */
export function fileStore(path = join(configDir(), "session.json")): SessionStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as SavedSession;
        if (parsed?.version !== 1 || !parsed.tokens?.refresh_token || !parsed.tokens.id_token) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    },
    async save(session) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
    async clear() {
      await unlink(path).catch(() => undefined);
    },
  };
}

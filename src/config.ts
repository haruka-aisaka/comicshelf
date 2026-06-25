import type { Config } from "./types.ts";

const DEFAULT_CONFIG_PATH = "./config.json";

/**
 * 設定ファイルを読み込む。
 * 環境変数 COMICSHELF_CONFIG が指定されていればそれを優先。
 */
export async function loadConfig(path?: string): Promise<Config> {
  const target = path ?? Deno.env.get("COMICSHELF_CONFIG") ?? DEFAULT_CONFIG_PATH;
  const text = await Deno.readTextFile(target);
  const parsed = JSON.parse(text) as Config;
  validateConfig(parsed);
  return parsed;
}

function validateConfig(c: Config): void {
  if (!Array.isArray(c.library?.roots) || c.library.roots.length === 0) {
    throw new Error("config.library.roots is required and must be non-empty");
  }
  if (!Array.isArray(c.library.extensions) || c.library.extensions.length === 0) {
    throw new Error("config.library.extensions is required and must be non-empty");
  }
  if (!c.database?.path) {
    throw new Error("config.database.path is required");
  }
  if (!c.server?.host || typeof c.server.port !== "number") {
    throw new Error("config.server.host / port are required");
  }
}

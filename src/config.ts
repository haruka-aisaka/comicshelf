import { basename } from "@std/path";
import type { Config, LibraryRoot, RawRoot } from "./types.ts";

const DEFAULT_CONFIG_PATH = "./config.json";

/** 設定ファイル (config.json) の生スキーマ。 roots は string または LibraryRoot 風オブジェクト。 */
interface RawConfig {
  library: {
    roots: RawRoot[];
    extensions: string[];
  };
  server: { host: string; port: number };
  database: { path: string };
  indexer: { watchInterval: number };
}

/**
 * 設定ファイルを読み込む。
 * 環境変数 COMICSHELF_CONFIG が指定されていればそれを優先。
 */
export async function loadConfig(path?: string): Promise<Config> {
  const target = path ?? Deno.env.get("COMICSHELF_CONFIG") ?? DEFAULT_CONFIG_PATH;
  const text = await Deno.readTextFile(target);
  const raw = JSON.parse(text) as RawConfig;
  return normalizeConfig(raw);
}

/**
 * 生 config を正規化する (テスト用に export)。
 * - `library.roots` の各要素を LibraryRoot に変換 (旧 string 形式は path から id/name を自動生成)
 * - id の重複・不正文字を検出
 */
export function normalizeConfig(raw: RawConfig): Config {
  validateRawConfig(raw);
  const roots = normalizeRoots(raw.library.roots);
  return {
    library: { roots, extensions: raw.library.extensions },
    server: raw.server,
    database: raw.database,
    indexer: raw.indexer,
  };
}

function validateRawConfig(c: RawConfig): void {
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

/** id として許容する文字種: 英数 / `_` / `-` (1 文字以上) */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function normalizeRoots(raws: RawRoot[]): LibraryRoot[] {
  const result: LibraryRoot[] = [];
  const seenIds = new Set<string>();
  for (const r of raws) {
    const root = normalizeOneRoot(r);
    if (!ID_PATTERN.test(root.id)) {
      throw new Error(
        `config.library.roots: id "${root.id}" must match ${ID_PATTERN} (alphanumeric, '-', '_')`,
      );
    }
    if (seenIds.has(root.id)) {
      throw new Error(`config.library.roots: duplicate id "${root.id}"`);
    }
    seenIds.add(root.id);
    result.push(root);
  }
  return result;
}

function normalizeOneRoot(r: RawRoot): LibraryRoot {
  if (typeof r === "string") {
    const id = sanitizeIdFromPath(r);
    return { id, name: id, path: r };
  }
  if (!r.path) {
    throw new Error("config.library.roots: each entry needs a path");
  }
  const id = r.id ?? sanitizeIdFromPath(r.path);
  const name = r.name ?? id;
  return { id, name, path: r.path };
}

/**
 * パスから id を自動生成する。 旧 string 形式の roots や、 id 未指定の
 * オブジェクト形式 root から呼ばれる。 basename を取り出し、 許容文字以外を
 * `_` に置換。 結果が空なら "root" にフォールバック。
 */
function sanitizeIdFromPath(p: string): string {
  const base = basename(p).trim();
  const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "root";
}

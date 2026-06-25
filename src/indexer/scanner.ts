import { walk } from "@std/fs";
import { dirname, extname, relative } from "@std/path";

export interface ScannedFile {
  /** スキャン対象のルートパス (絶対) */
  root: string;
  /** ルートからの相対パス (POSIX区切り) */
  relativePath: string;
  /** ファイル名のみ (拡張子つき) */
  filename: string;
  /** ルートからの親ディレクトリ相対パス。直下なら "" */
  directory: string;
  sizeBytes: number;
  /** 更新日時 (Unix秒) */
  modifiedAt: number;
}

export interface ScanOptions {
  /** 受理する拡張子 (ドット含む。小文字比較) */
  extensions: string[];
}

/**
 * 指定ルートを再帰スキャンし、対象拡張子のファイルを列挙する。
 * シンボリックリンクは追わない (ループ防止)。
 */
export async function* scanLibrary(
  root: string,
  opts: ScanOptions,
): AsyncGenerator<ScannedFile> {
  const exts = new Set(opts.extensions.map((e) => e.toLowerCase()));
  for await (const entry of walk(root, { includeDirs: false, followSymlinks: false })) {
    const ext = extname(entry.path).toLowerCase();
    if (!exts.has(ext)) continue;

    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(entry.path);
    } catch {
      continue; // スキャン中に消えた等のレース
    }
    if (!stat.isFile) continue;

    const rel = toPosix(relative(root, entry.path));
    const parent = toPosix(relative(root, dirname(entry.path)));
    yield {
      root,
      relativePath: rel,
      filename: entry.name,
      directory: parent === "." ? "" : parent,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : 0,
    };
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/** 拡張子を除いたタイトル */
export function titleFromFilename(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

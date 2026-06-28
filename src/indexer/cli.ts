#!/usr/bin/env -S deno run -A
/**
 * インデックス手動実行CLI。
 *   deno task index
 *
 * config.json (またはCOMICSHELF_CONFIG指定先) を読み、library.roots を全走査。
 */
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/schema.ts";
import { reindex } from "./index.ts";

if (import.meta.main) {
  const config = await loadConfig();
  const db = openDatabase(config.database.path, config.library.roots[0]?.id);
  try {
    const started = Date.now();
    const stats = await reindex(db, {
      roots: config.library.roots,
      extensions: config.library.extensions,
    });
    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ ...stats, elapsedMs }, null, 2));
  } finally {
    db.close();
  }
}

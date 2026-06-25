/**
 * 画像bytesをリサイズしてWebPバイト列を返す。
 *
 * ImageMagick CLI (`magick`) を Deno.Command 経由で呼び出す。
 *   - 入力はstdin、 出力はstdout
 *   - `${max}x${max}>` 修飾子で「指定サイズ以上の場合のみ縮小」
 *   - 量子化品質82 (一般的な写真品質)
 *
 * 失敗時 (magick未インストール、 デコード不能等) は例外を投げる。
 * 呼び出し側で原本fallbackを実装すること。
 */

export interface ThumbnailOptions {
  /** 最大寸法 (長辺基準, px)。 既定600px */
  maxDimension?: number;
  /** WebP品質 (0-100)。 既定82 */
  quality?: number;
}

export async function generateThumbnailWebp(
  input: Uint8Array,
  opts: ThumbnailOptions = {},
): Promise<Uint8Array> {
  const maxDim = opts.maxDimension ?? 600;
  const quality = opts.quality ?? 82;

  // nice -n 19 で magick を最低優先度にし、HTTPリクエスト処理を優先させる。
  // stderr は "null" にして OS パイプ buffer 飽和による deadlock を避ける
  // (magick が warning を大量出力する画像で発生する典型的問題への対処)。
  const cmd = new Deno.Command("nice", {
    args: [
      "-n",
      "19",
      "magick",
      "-",
      "-auto-orient",
      "-thumbnail",
      `${maxDim}x${maxDim}>`,
      "-quality",
      String(quality),
      "webp:-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const proc = cmd.spawn();

  // stdin への書き込みと stdout の読み出しを並列に走らせる。
  // 直列だと stdout pipe buffer (~64KB) が満杯になった時点で magick が
  // 書き込みブロック → こちらは stdin 書き込み中で stdout drainできない
  // → 古典的なパイプ deadlock になる。
  const writePromise = (async () => {
    const writer = proc.stdin.getWriter();
    try {
      await writer.write(input);
    } finally {
      await writer.close();
    }
  })();
  const outputPromise = proc.output();
  const [, result] = await Promise.all([writePromise, outputPromise]);
  if (!result.success) {
    throw new Error(`magick failed (code=${result.code})`);
  }
  return result.stdout;
}

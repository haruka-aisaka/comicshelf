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

  // nice -n 19 で magick を最低優先度にし、HTTPリクエスト処理を優先させる
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
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  try {
    await writer.write(input);
  } finally {
    await writer.close();
  }
  const result = await proc.output();
  if (!result.success) {
    const err = new TextDecoder().decode(result.stderr).slice(0, 300);
    throw new Error(`magick failed (code=${result.code}): ${err}`);
  }
  return result.stdout;
}

/**
 * zip-js 用のファイル Range Read Reader。
 *
 * BlobReader だとアーカイブ全体を Deno.readFile + Blob 化する必要があり、
 * 60MB級のCBZだとNFS経由で5〜6秒のフルロードが発生する。
 *
 * FileSliceReader は Deno.FsFile を開きっぱなしにして readUint8Array(offset, length)
 * を seek + read で実装する。zip-js は中央ディレクトリ (= ファイル末尾の数KB) と
 * 抽出対象エントリのオフセットだけを部分読みするため、 listPages は数百ms、
 * 個別ページ抽出も数十msに収まるようになる。
 */
import { Reader } from "@zip-js/zip-js";

export class FileSliceReader extends Reader<string> {
  override size = 0;
  private file: Deno.FsFile | null = null;
  private readonly path: string;
  /**
   * seek + read は状態を持つため、並列で readUint8Array が呼ばれると
   * file position が他のリクエストに上書きされ、読み出しが化ける。
   * (例: viewerの prefetch でページ画像を3並列fetchすると、ZIPエントリの
   *  オフセット読みが互いに干渉して破損データが返る → ブラウザで ? アイコン)
   * このmutexで実際の seek+read を直列化する。
   */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    super(path);
    this.path = path;
  }

  override async init(): Promise<void> {
    const stat = await Deno.stat(this.path);
    this.size = stat.size;
    this.file = await Deno.open(this.path, { read: true });
  }

  override readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    // mutexにpipelineする: 前の処理を待ってから自分を実行
    const result = this.mutex.then(() => this.readLocked(offset, length));
    // 次の呼び出し用に「成功/失敗いずれでも完了したら」のPromiseに繋ぐ
    this.mutex = result.catch(() => {});
    return result;
  }

  private async readLocked(offset: number, length: number): Promise<Uint8Array> {
    if (!this.file) {
      this.file = await Deno.open(this.path, { read: true });
      if (this.size === 0) this.size = (await Deno.stat(this.path)).size;
    }
    const remaining = this.size - offset;
    const actualLength = Math.max(0, Math.min(length, remaining));
    if (actualLength === 0) return new Uint8Array(0);

    await this.file.seek(offset, Deno.SeekMode.Start);
    const buf = new Uint8Array(actualLength);
    let totalRead = 0;
    while (totalRead < actualLength) {
      const n = await this.file.read(buf.subarray(totalRead));
      if (n === null) break;
      totalRead += n;
    }
    return buf.subarray(0, totalRead);
  }

  /** 明示的にファイルを閉じる (LRU evict時等に呼ぶ) */
  close(): void {
    if (this.file) {
      try {
        this.file.close();
      } catch { /* ignore */ }
      this.file = null;
    }
  }
}

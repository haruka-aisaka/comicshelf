# syntax=docker/dockerfile:1.7

# ------------------------------------------------------------
# ベースイメージ: Deno 公式 (Debian)
# 選定理由:
#   - jsr:@db/sqlite が起動時に libsqlite3_*.so をdlopenするため
#     glibcベースが扱いやすい (alpineはmusl)
#   - 公式denoland/denoはmulti-arch (amd64/arm64) 対応のためNAS/Piでも動作
# ------------------------------------------------------------
FROM denoland/deno:2.8.3 AS base

# ImageMagick: サムネイルをWebPへリサイズするのに使う (magick CLI)
# Debianパッケージはlibwebp delegateを含むので追加依存なし。
RUN apt-get update && \
    apt-get install -y --no-install-recommends imagemagick && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ------------------------------------------------------------
# 依存キャッシュ層: TS依存だけ先に解決してレイヤキャッシュを効かせる
# ------------------------------------------------------------
FROM base AS deps

COPY deno.json deno.lock* ./
COPY src/ ./src/
COPY web/ ./web/

RUN deno cache web/server.ts

# ------------------------------------------------------------
# ランタイム層
# ------------------------------------------------------------
FROM base AS runtime

COPY --from=deps /deno-dir /deno-dir
COPY --chown=deno:deno . .

# 永続化用ディレクトリ。/comics はバインドマウントされる想定で作成のみ。
# /deno-dir/plug: @denosaurs/plug (=@db/sqlite依存) が共有ライブラリを保存する先
#   (DENO_DIR=/deno-dir はベースイメージ規定)
#
# chmod 777 にしているのは、NAS運用で compose 側から user: "${PUID}:${PGID}"
# を指定してホストUIDと一致させる構成を許容するため。
# (公式denoイメージのdenoユーザーはUID 1993固定で、ホストのUIDと衝突しがち)
RUN mkdir -p /data /config /comics /deno-dir/plug && \
    chmod -R 777 /data /deno-dir/plug

USER deno

EXPOSE 8080

ENV COMICSHELF_CONFIG=/config/config.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD deno eval "const r = await fetch('http://localhost:8080/api/health'); if (!r.ok) Deno.exit(1);" || exit 1

# 必要権限:
#   --allow-net          サーバー bind および @db/sqlite の初回ライブラリ取得
#   --allow-read         /comics, /config, web/public, /deno-dir 読み取り
#   --allow-write        /data (SQLite), /deno-dir/plug (libsqlite3保存)
#   --allow-env          COMICSHELF_CONFIG, HOME, DENO_DIR 等
#   --allow-ffi          @db/sqlite のFFI呼び出し
#   --allow-sys          @db/sqlite が osType等を参照
#   --allow-run=magick   ImageMagick CLI 呼び出し (サムネWebP変換)
CMD ["deno", "run", \
     "--allow-net", \
     "--allow-read", \
     "--allow-write=/data,/deno-dir/plug", \
     "--allow-env", \
     "--allow-ffi", \
     "--allow-sys", \
     "--allow-run=magick", \
     "web/server.ts"]

/**
 * 検索バー文字列のパーサー。
 *
 *   入力例: `writer:岸本斉史 tag:忍者 ナルト`
 *   出力 (SearchToken[]):
 *     [
 *       { field: "writer", value: "岸本斉史" },
 *       { field: "tag",    value: "忍者"     },
 *       { field: null,     value: "ナルト"   },
 *     ]
 *
 * 仕様:
 *   - 半角スペースでトークン分割
 *   - 既知 prefix (KNOWN_FIELDS) なら field 指定として扱う
 *   - 未知 prefix (例: foo:bar) は field=null として横断検索にフォールバック
 *   - 値が `"..."` で引用されている場合は閉じ引用符まで (= 値内のスペース許可)
 *   - 引用符が閉じない場合は文字列末尾まで値とみなす
 *   - prefix の値が空 (`tag:`、 `writer:""`) は無視
 *   - 大文字小文字は保持 (マッチング側で NOCASE する)
 */

/** クエリ構文で field 指定として認識する prefix */
export const KNOWN_FIELDS = [
  "tag",
  "genre",
  "writer",
  "penciller",
  "series",
  "publisher",
  "imprint",
  "character",
] as const;

export type SearchField = typeof KNOWN_FIELDS[number];

export interface SearchToken {
  /** field 指定 (KNOWN_FIELDS のいずれか) or null = 横断検索 */
  field: SearchField | null;
  /** 検索値 (トリム後、 空文字は含まれない) */
  value: string;
}

const KNOWN_FIELDS_SET = new Set<string>(KNOWN_FIELDS);

/**
 * 検索クエリをパースしてトークン列を返す。
 * 空入力や空白のみの場合は空配列。
 */
export function parseSearchQuery(input: string | undefined | null): SearchToken[] {
  if (!input) return [];
  const tokens: SearchToken[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    // 先頭の空白をスキップ
    while (i < n && isSpace(input[i]!)) i++;
    if (i >= n) break;

    // ここから次の空白 (または引用符付き値の終わり) までを 1 トークンとして読む
    // まず prefix を試す: 連続する [a-zA-Z]+ + ':' を見る
    const prefix = tryReadPrefix(input, i);
    let field: SearchField | null = null;
    let valueStart = i;
    if (prefix && KNOWN_FIELDS_SET.has(prefix.name.toLowerCase())) {
      field = prefix.name.toLowerCase() as SearchField;
      valueStart = prefix.end; // ':' の次の文字から値開始
    }

    // 値を読む。 `"..."` か、 次の空白まで
    let value: string;
    let nextIndex: number;
    if (input[valueStart] === '"') {
      // 引用符で囲まれた値
      const closeIdx = input.indexOf('"', valueStart + 1);
      if (closeIdx === -1) {
        // 引用符が閉じない: 末尾までを値とする
        value = input.slice(valueStart + 1);
        nextIndex = n;
      } else {
        value = input.slice(valueStart + 1, closeIdx);
        nextIndex = closeIdx + 1;
      }
    } else {
      // 次の空白までを値とする
      let j = valueStart;
      while (j < n && !isSpace(input[j]!)) j++;
      value = input.slice(valueStart, j);
      nextIndex = j;
    }

    if (field !== null) {
      // 既知 prefix だが値が空ならトークン全体を無視 (`tag:` 等)
      if (value !== "") {
        tokens.push({ field, value });
      }
    } else {
      // 未知 prefix or prefix 無し: valueStart が i (= 行頭) のままなので、
      // value 自身に "foo:bar" が丸ごと入っている。 そのまま push。
      if (value !== "") {
        tokens.push({ field: null, value });
      }
    }

    i = nextIndex;
  }

  return tokens;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

/**
 * 入力位置 `start` から prefix (英字 + ':') を試行的に読む。
 *   成功: { name: "writer", end: <':' の次のインデックス> }
 *   失敗: null
 */
function tryReadPrefix(input: string, start: number): { name: string; end: number } | null {
  let j = start;
  while (j < input.length && isAsciiAlpha(input[j]!)) j++;
  if (j === start) return null;
  if (input[j] !== ":") return null;
  return { name: input.slice(start, j), end: j + 1 };
}

function isAsciiAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

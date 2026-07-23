// 書誌API 3段フォールバック: openBD → NDLサーチ → Google Books（仕様§5）
// NDLサーチは Access-Control-Allow-Origin: * を返すことをcurlで確認済み（2026-07-21 dev_log参照）

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null; // タイムアウト・ネットワーク・CORSエラーは「見つからず」扱いで次のAPIへ
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function lookupOpenBd(isbn) {
  const data = await fetchJson(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
  const summary = data?.[0]?.summary;
  if (!summary?.title) return null;
  // 価格はONIXから取得できれば入れる（仕様§4.1・§5.1）
  let price = null;
  const prices = data[0].onix?.ProductSupply?.SupplyDetail?.Price;
  const amount = Array.isArray(prices) ? prices[0]?.PriceAmount : null;
  if (amount && !Number.isNaN(Number(amount))) price = Number(amount);
  return {
    isbn,
    title: summary.title,
    author: normalizeAuthor(summary.author),
    publisher: summary.publisher || '',
    coverUrl: summary.cover || '',
    price,
    source: 'openBD',
  };
}

// NDLの書誌はISBD由来の並列タイトル「ワールドトリガー = World trigger」形式で返ることがある → 「 = 」以降を除去
export function stripParallelTitle(title) {
  return (title || '').split(/\s+[=＝]\s+/)[0].trim();
}

// 著者名の表記ゆれを全ソース共通で正規化する。姓と名の間は「空白なし」に統一する方針
// （2026-07-23 方針変更）。元データが区切りなしで連結される本があり「常に空白あり」には
// 揃えられないため、逆に日本語名の姓名間スペースを詰めて統一する。
// ラテン文字名（例: Eiichiro Oda）の語間スペースは意味を持つため残す。
const JP_CHAR = '\\u3005\\u3006\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF';
const JP_SPACE_JP = new RegExp(`([${JP_CHAR}]) +(?=[${JP_CHAR}])`, 'g');
export function normalizeAuthor(s) {
  return (s || '')
    .replace(/[,，]/g, '')       // NDLの「姓, 名」等のカンマ区切りを詰める
    .replace(/　/g, ' ')  // 全角スペースを一旦半角スペースに
    .replace(JP_SPACE_JP, '$1')  // 日本語名の姓名間スペースを除去（ラテン名の語間は残す）
    .replace(/\s+/g, ' ')        // 残った連続スペースを1個に
    .trim();
}

const DC_NS = 'http://purl.org/dc/elements/1.1/';

function dcText(item, tag) {
  const el = item.getElementsByTagNameNS(DC_NS, tag)[0];
  return el?.textContent?.trim() || '';
}

async function lookupNdl(isbn) {
  const res = await fetchWithTimeout(`https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${isbn}`);
  if (!res) return null;
  let doc;
  try {
    doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
  } catch {
    return null;
  }
  const item = doc.querySelector('item');
  if (!item) return null;
  const title = dcText(item, 'title') || item.querySelector('title')?.textContent?.trim() || '';
  if (!title) return null;
  return {
    isbn,
    title: stripParallelTitle(title),
    author: normalizeAuthor(dcText(item, 'creator')),
    publisher: dcText(item, 'publisher'),
    coverUrl: '', // NDLは表紙を返さない（サムネイルAPIは403）→ lookupIsbnでGoogle Booksから補完
    price: null,
    source: 'NDL',
  };
}

async function lookupGoogleBooks(isbn) {
  const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
  const info = data?.items?.[0]?.volumeInfo;
  if (!info?.title) return null;
  return {
    isbn,
    title: info.title,
    author: normalizeAuthor((info.authors || []).join('・')),
    publisher: info.publisher || '',
    coverUrl: (info.imageLinks?.thumbnail || '').replace(/^http:/, 'https:'),
    price: null,
    source: 'Google Books',
  };
}

// Amazonの書影URL（ISBN-10ベース・キー不要）。openBDに書影が無い本（集英社等）の補完用。
// Google Booksは匿名利用の日次クォータで429になるため使わない（2026-07-22実測）。
// 画像が無いISBNは1x1 GIFが返るため、表示側で naturalWidth<=1 をプレースホルダー扱いにする
export function amazonCoverUrl(isbn13) {
  if (!/^978\d{10}$/.test(isbn13 || '')) return '';
  const core = isbn13.slice(3, 12);
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  const isbn10 = core + (check === 10 ? 'X' : String(check));
  return `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.09.LZZZZZZZ.jpg`;
}

// 見つかれば {isbn, title, author, publisher, coverUrl, price, source}、全滅なら null
// null の場合、呼び出し側はISBN確定状態の手入力フォームを開く（仕様§5.2）
export async function lookupIsbn(isbn) {
  const hit =
    (await lookupOpenBd(isbn)) ??
    (await lookupNdl(isbn)) ??
    (await lookupGoogleBooks(isbn));
  if (hit && !hit.coverUrl) hit.coverUrl = amazonCoverUrl(isbn);
  return hit;
}

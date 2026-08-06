// 書誌API 3段フォールバック: openBD → NDLサーチ → Google Books（仕様§5）
// NDLサーチは Access-Control-Allow-Origin: * を返すことをcurlで確認済み（2026-07-21 dev_log参照）

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

// タイトルのヨミ（あいうえお順ソート用のキー）。ひらがな→カタカナに揃え、空白・区切り記号を落とす
export function kanaKey(s) {
  return (s || '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s　・,，.。「」『』]/g, '');
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
  // ONIXのcollationkeyがタイトルのヨミ（カタカナ）。無い本もある
  const titleDetail = data[0].onix?.DescriptiveDetail?.TitleDetail;
  const titleText = (Array.isArray(titleDetail) ? titleDetail[0] : titleDetail)?.TitleElement?.TitleText;
  return {
    isbn,
    titleKana: kanaKey(titleText?.collationkey),
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
const DCNDL_NS = 'http://ndl.go.jp/dcndl/terms/';

function nsText(item, ns, tag) {
  const el = item.getElementsByTagNameNS(ns, tag)[0];
  return el?.textContent?.trim() || '';
}

function dcText(item, tag) {
  return nsText(item, DC_NS, tag);
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
    titleKana: kanaKey(nsText(item, DCNDL_NS, 'titleTranscription')),
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
    titleKana: '', // Google Booksはヨミを返さない
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

// ISBN表記ゆれの正規化: ハイフン・空白を除去し、ISBN10は13桁（978始まり）に変換する。
// NDLのタイトル検索はISBNを「4-7974-7601-X」のような10桁ハイフン付きで返すことがある
export function isbnTo13(raw) {
  const s = (raw || '').replace(/[-\s]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) return s;
  if (/^\d{9}[0-9X]$/.test(s)) {
    const core = '978' + s.slice(0, 9);
    const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return core + String((10 - (sum % 10)) % 10);
  }
  return '';
}

/* ---- タイトル検索（バーコードの無い電子書籍などの登録用・2026-08-06） ----
   NDLサーチのopensearchは title= でも引ける（CORSは isbn= と同一エンドポイントで確認済み）。
   関連CD・楽譜・同人誌も混ざるため「978/979のISBNを持つもの」だけに絞る。
   itemの切り出しをDOMParserでなく正規表現でやるのは、nodeでそのまま実測テストするため
   （NDLのitem構造はフラットで安定していることを2026-08-06に実レスポンスで確認） */

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? decodeXml(m[1]).trim() : '';
}

// dc:creator は「芥見, 下々, 1992-」形式 → 末尾の生没年を落としてから正規化する。
// 団体著者の「芳文社 (1950年)」のような設立年カッコも落とす
function creatorsOf(item) {
  const names = [...item.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)]
    .map((m) =>
      normalizeAuthor(
        decodeXml(m[1])
          .replace(/,\s*\d{4}-?(\d{4})?\s*$/, '')
          .replace(/\s*[（(]\d{4}年?[）)]\s*$/, '')
      )
    )
    .filter(Boolean);
  return [...new Set(names)].join('・');
}

function ndlIsbnOf(item) {
  for (const m of item.matchAll(/<dc:identifier xsi:type="dcndl:ISBN(?:13)?">([^<]+)<\/dc:identifier>/g)) {
    const isbn = isbnTo13(m[1]);
    if (isbn) return isbn;
  }
  return '';
}

async function searchNdlByTitle(query) {
  // NDLのタイトル検索は初回6秒超かかることがある（2026-08-06実測）→ ISBN照会より長めに待つ
  const res = await fetchWithTimeout(
    `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(query)}&cnt=20`,
    10000
  );
  if (!res) return [];
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const hits = [];
  const seen = new Set();
  for (const item of items) {
    const isbn = ndlIsbnOf(item);
    const title = stripParallelTitle(tagText(item, 'dc:title'));
    if (!isbn || !title || seen.has(isbn)) continue; // ISBNの無いもの（同人誌・CD等）は候補にしない
    seen.add(isbn);
    const volume = tagText(item, 'dcndl:volume');
    hits.push({
      isbn,
      title: volume ? `${title} ${volume}` : title,
      titleKana: kanaKey(tagText(item, 'dcndl:titleTranscription')) + volume,
      author: creatorsOf(item),
      publisher: tagText(item, 'dc:publisher'),
      issued: tagText(item, 'dcterms:issued').match(/\d{4}/)?.[0] || '', // 「[2021]」形式にも対応
      coverUrl: amazonCoverUrl(isbn),
      price: null,
      source: 'NDL',
    });
  }
  return hits.slice(0, 10);
}

// Google Booksはタイトル検索の補欠（匿名利用の日次クォータで429になることがある実測済み）。
// 電子専売などNDLに無い本を拾う。ISBNが無い本も候補に出す（登録側がISBNなしに対応）
async function searchGoogleByTitle(query) {
  const data = await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(query)}&maxResults=10&country=JP`
  );
  const hits = [];
  for (const it of data?.items || []) {
    const info = it.volumeInfo;
    if (!info?.title) continue;
    const isbn = isbnTo13(
      (info.industryIdentifiers || []).find((x) => x.type?.startsWith('ISBN'))?.identifier || ''
    );
    hits.push({
      isbn: isbn || null,
      title: info.title,
      titleKana: '',
      author: normalizeAuthor((info.authors || []).join('・')),
      publisher: info.publisher || '',
      issued: (info.publishedDate || '').slice(0, 4),
      coverUrl:
        (info.imageLinks?.thumbnail || '').replace(/^http:/, 'https:') ||
        (isbn ? amazonCoverUrl(isbn) : ''),
      price: null,
      source: 'Google Books',
    });
  }
  return hits;
}

// タイトルで候補を探す。NDL優先・0件ならGoogle Booksに落とす
export async function searchByTitle(query) {
  const ndl = await searchNdlByTitle(query);
  return ndl.length ? ndl : searchGoogleByTitle(query);
}

// ヨミだけを引き直す（あいうえお順ソート用に、登録済みの本へ後からヨミを補う）。
// 取れなければ '' — 呼び出し側は再取得しないよう「取得済み」を記録する
export async function lookupTitleKana(isbn) {
  return (await lookupOpenBd(isbn))?.titleKana || (await lookupNdl(isbn))?.titleKana || '';
}

// 見つかれば {isbn, title, titleKana, author, publisher, coverUrl, price, source}、全滅なら null
// null の場合、呼び出し側はISBN確定状態の手入力フォームを開く（仕様§5.2）
export async function lookupIsbn(isbn) {
  const hit =
    (await lookupOpenBd(isbn)) ??
    (await lookupNdl(isbn)) ??
    (await lookupGoogleBooks(isbn));
  if (hit && !hit.coverUrl) hit.coverUrl = amazonCoverUrl(isbn);
  return hit;
}

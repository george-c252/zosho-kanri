// 書誌API（M1はopenBDのみ。NDL・Google Booksフォールバックは M2 で追加 — 仕様§5）

const TIMEOUT_MS = 5000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // タイムアウト・ネットワークエラーは「見つからず」扱い
  } finally {
    clearTimeout(timer);
  }
}

// 見つかれば {isbn, title, author, publisher, coverUrl}、見つからなければ null
export async function lookupIsbn(isbn) {
  const data = await fetchJson(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
  const summary = data?.[0]?.summary;
  if (!summary) return null;
  return {
    isbn,
    title: summary.title || '',
    author: summary.author || '',
    publisher: summary.publisher || '',
    coverUrl: summary.cover || '',
  };
}

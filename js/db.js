// IndexedDBラッパー（仕様§4）。DBバージョン管理はこのファイルに集約する。

const DB_NAME = 'zosho_kanri';
const DB_VERSION = 1;

// onupgradeneeded のマイグレーション処理（仕様§9: 最初から関数分離しておく）
function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    const books = db.createObjectStore('books', { keyPath: 'id' });
    books.createIndex('isbn', 'isbn');
    books.createIndex('title', 'title');
    books.createIndex('series', 'series');
    books.createIndex('status', 'status');
    books.createIndex('addedAt', 'addedAt');
    db.createObjectStore('wishlist', { keyPath: 'isbn' });
  }
}

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function toPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getStore(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

// 仕様§4.1のkeyPath規則: `${isbn}_${format}`。ISBN欠損時は `manual_${uuid}`
export function makeBookId(isbn, format) {
  return isbn ? `${isbn}_${format}` : `manual_${crypto.randomUUID()}`;
}

// 部分データから§4.1の全フィールドを持つレコードを作る
export function createBook(partial) {
  const isbn = partial.isbn || null;
  const format = partial.format || 'paper';
  return {
    id: makeBookId(isbn, format),
    isbn,
    title: partial.title || '',
    titleKana: partial.titleKana || '',
    author: partial.author || '',
    publisher: partial.publisher || '',
    coverUrl: partial.coverUrl || '',
    spineImage: partial.spineImage ?? null, // 実物背表紙写真（Blob・3段フォールバックの①）
    spineColor: partial.spineColor ?? null, // 表紙から抽出した背景色 {bg, fg}（3段フォールバックの②）
    shelfOrder: partial.shelfOrder ?? null, // 本棚の手動並び順（ドラッグ&ドロップで割当）
    format,
    status: 'unread',
    series: partial.series || '',
    volume: partial.volume ?? null,
    price: partial.price ?? null,
    purchaseDate: partial.purchaseDate || '',
    purchasePlace: partial.purchasePlace || '',
    tags: partial.tags || [],
    memo: partial.memo || '',
    addedAt: Date.now(),
  };
}

export async function addBook(book) {
  const store = await getStore('books', 'readwrite');
  return toPromise(store.add(book)); // id衝突時は reject（同一ISBN×同一formatの二重登録防止）
}

export async function getBook(id) {
  const store = await getStore('books');
  return toPromise(store.get(id));
}

export async function getAllBooks() {
  const store = await getStore('books');
  return toPromise(store.getAll());
}

export async function updateBook(book) {
  const store = await getStore('books', 'readwrite');
  return toPromise(store.put(book));
}

export async function deleteBook(id) {
  const store = await getStore('books', 'readwrite');
  return toPromise(store.delete(id));
}

// バックアップの書き出し／読み込みで欲しいリストも丸ごと扱うための入出力
export async function getAllWishlist() {
  const store = await getStore('wishlist');
  return toPromise(store.getAll());
}

export async function putWishlist(entry) {
  const store = await getStore('wishlist', 'readwrite');
  return toPromise(store.put(entry));
}

// タイトルでの重複判定（タイトル検索登録・ISBNの無い本用・2026-08-06）。
// 空白と大文字小文字のゆれだけ吸収して同一タイトルを探す
function normTitle(s) {
  return (s || '').replace(/[\s　]+/g, '').toLowerCase();
}

export async function checkDuplicateByTitle(title) {
  if (!title) return { owned: false };
  const hits = (await getAllBooks()).filter((b) => normTitle(b.title) === normTitle(title));
  return hits.length ? { owned: true, formats: hits.map((b) => b.format) } : { owned: false };
}

// 重複判定（仕様§4.3）
export async function checkDuplicate(isbn) {
  const db = await openDb();
  const tx = db.transaction(['books', 'wishlist'], 'readonly');
  const books = await toPromise(tx.objectStore('books').index('isbn').getAll(isbn));
  const wish = await toPromise(tx.objectStore('wishlist').get(isbn));
  const result = books.length
    ? { owned: true, formats: books.map((b) => b.format) }
    : { owned: false };
  if (wish) result.wishlisted = true;
  return result;
}

import { createScanner, isValidBookIsbn } from './scanner.js';
import { lookupIsbn } from './bookapi.js';
import { createBook, addBook, checkDuplicate } from './db.js';
import { initShelf, refreshShelf } from './views/shelf.js';

const video = document.getElementById('viewfinder');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const coverEl = document.getElementById('cover');
const dupBanner = document.getElementById('dup-banner');
const manualForm = document.getElementById('manual-form');
const manualInput = document.getElementById('manual-isbn');
const manualBookEl = document.getElementById('manual-book');
const manualTitleEl = document.getElementById('manual-title');
const manualAuthorEl = document.getElementById('manual-author');

const FORMAT_LABEL = { paper: '紙', ebook: '電子' };

// 同一ISBNの連続検出は3秒間デバウンス（仕様§6.2）
const DEBOUNCE_MS = 3000;
let lastIsbn = '';
let lastAt = 0;

// 現在result欄に表示中の書誌。書誌API全滅時は {isbn} のみで手入力にフォールバック
let currentBook = null;

function setStatus(text) {
  statusEl.textContent = text;
}

// 重複判定の結果をバナー表示する（M2完了条件: 既所持ISBNのスキャンで警告が出る）
function showDupBanner(dup) {
  if (dup.owned) {
    const formats = dup.formats.map((f) => FORMAT_LABEL[f] || f).join('・');
    dupBanner.textContent = `⚠️ 持ってます（${formats}）`;
    dupBanner.className = 'banner-owned';
    if (navigator.vibrate) navigator.vibrate(200);
  } else {
    dupBanner.textContent = '✅ 持ってません';
    dupBanner.className = 'banner-new';
  }
  if (dup.wishlisted) dupBanner.textContent += ' ⭐ 欲しいリストに入ってます';
  dupBanner.hidden = false;
}

// 書誌APIから取得した文字列は textContent で挿入する（XSS対策・仕様§9）
function showBook(book) {
  document.getElementById('book-title').textContent = book.title || '（書誌情報なし — 手入力で登録）';
  document.getElementById('book-author').textContent = book.author || '';
  document.getElementById('book-publisher').textContent = book.publisher || '';
  document.getElementById('book-isbn').textContent = `ISBN: ${book.isbn}`;
  if (book.coverUrl) {
    coverEl.src = book.coverUrl;
    coverEl.hidden = false;
  } else {
    coverEl.hidden = true;
  }
  // 書誌API全滅時はタイトル手入力欄を開く（仕様§5.2: 登録は必ず完了できる）
  manualBookEl.hidden = Boolean(book.title);
  manualTitleEl.value = '';
  manualAuthorEl.value = '';
  resultEl.hidden = false;
}

async function handleIsbn(isbn) {
  const now = Date.now();
  if (isbn === lastIsbn && now - lastAt < DEBOUNCE_MS) return;
  lastIsbn = isbn;
  lastAt = now;

  setStatus(`検出: ${isbn} — 照会中…`);
  const dup = await checkDuplicate(isbn);
  showDupBanner(dup);

  const book = await lookupIsbn(isbn);
  currentBook = book || { isbn, title: '', author: '', publisher: '', coverUrl: '', price: null };
  showBook(currentBook);
  setStatus(book ? `取得成功（${book.source}）` : '書誌API全滅 — 手入力で登録できます');
}

async function register(format) {
  if (!currentBook) return;
  const book = { ...currentBook };
  if (!book.title) {
    book.title = manualTitleEl.value.trim();
    book.author = manualAuthorEl.value.trim();
    if (!book.title) {
      setStatus('タイトルを入力してください');
      manualTitleEl.focus();
      return;
    }
  }
  const dup = await checkDuplicate(book.isbn);
  if (dup.owned && dup.formats.includes(format)) {
    setStatus(`すでに${FORMAT_LABEL[format]}で登録済みです`);
    return;
  }
  await addBook(createBook({ ...book, format }));
  await refreshShelf();
  setStatus(`📚 登録しました: ${book.title}（${FORMAT_LABEL[format]}）`);
  resultEl.hidden = true;
  currentBook = null;
}

document.getElementById('reg-paper').addEventListener('click', () => register('paper'));
document.getElementById('reg-ebook').addEventListener('click', () => register('ebook'));
coverEl.addEventListener('error', () => { coverEl.hidden = true; }); // 表紙URL切れは非表示に

manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const isbn = manualInput.value.trim();
  if (!isValidBookIsbn(isbn)) {
    setStatus('ISBNが不正です（978/979始まり13桁・チェックディジット検証あり）');
    return;
  }
  lastIsbn = ''; // 手入力は常に照会し直す
  handleIsbn(isbn);
});

// カメラはスキャンタブを開いた時だけ起動し、離れたら停止する
// （常時オンを嫌う実機フィードバック 2026-07-22。stop→再startのiOS互換は実機で要確認）
const scanner = createScanner();
let cameraOn = false;
let cameraStarting = false;

async function startCamera() {
  if (cameraOn || cameraStarting) return;
  if (!window.isSecureContext) {
    setStatus('⚠️ HTTPSではないためカメラは使えません（仕様§10）。手入力での登録は可能です。');
    return;
  }
  cameraStarting = true;
  setStatus('カメラ起動中…');
  try {
    await scanner.start(video, handleIsbn);
    cameraOn = true;
    setStatus('カメラ起動済み — バーコードをかざしてください');
  } catch (err) {
    setStatus(`カメラを起動できません: ${err.name}。手入力での登録は可能です。`);
  } finally {
    cameraStarting = false;
  }
}

function stopCamera() {
  if (!cameraOn) return;
  scanner.stop();
  cameraOn = false;
}

// タブ切替（スキャン／蔵書）。デフォルトは蔵書タブ＝カメラオフ
const tabs = { scan: document.getElementById('tab-scan'), shelf: document.getElementById('tab-shelf') };
document.querySelectorAll('#tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    for (const [key, el] of Object.entries(tabs)) el.hidden = key !== name;
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
    if (name === 'scan') startCamera();
    else stopCamera();
    if (name === 'shelf') refreshShelf();
  });
});

// バックグラウンド移行時もカメラを止める（復帰時はスキャンタブ表示中なら再起動）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (!tabs.scan.hidden) startCamera();
});

initShelf();

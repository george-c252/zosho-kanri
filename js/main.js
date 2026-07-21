import { createScanner, isValidBookIsbn } from './scanner.js';
import { lookupIsbn } from './bookapi.js';

const video = document.getElementById('viewfinder');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const coverEl = document.getElementById('cover');
const manualForm = document.getElementById('manual-form');
const manualInput = document.getElementById('manual-isbn');

// 同一ISBNの連続検出は3秒間デバウンス（仕様§6.2）
const DEBOUNCE_MS = 3000;
let lastIsbn = '';
let lastAt = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

// 書誌APIから取得した文字列は textContent で挿入する（XSS対策・仕様§9）
function showBook(book) {
  document.getElementById('book-title').textContent = book.title || '（タイトル不明）';
  document.getElementById('book-author').textContent = book.author;
  document.getElementById('book-publisher').textContent = book.publisher;
  document.getElementById('book-isbn').textContent = `ISBN: ${book.isbn}`;
  if (book.coverUrl) {
    coverEl.src = book.coverUrl;
    coverEl.hidden = false;
  } else {
    coverEl.hidden = true;
  }
  resultEl.hidden = false;
}

async function handleIsbn(isbn) {
  const now = Date.now();
  if (isbn === lastIsbn && now - lastAt < DEBOUNCE_MS) return;
  lastIsbn = isbn;
  lastAt = now;

  setStatus(`検出: ${isbn} — openBD照会中…`);
  const book = await lookupIsbn(isbn);
  if (book) {
    setStatus('取得成功（スキャン継続中）');
    showBook(book);
  } else {
    setStatus(`openBD未登録: ${isbn}（M2で手入力フォームに接続予定）`);
    resultEl.hidden = true;
  }
}

manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const isbn = manualInput.value.trim();
  if (!isValidBookIsbn(isbn)) {
    setStatus('ISBNが不正です（978/979始まり13桁・チェックディジット検証あり）');
    return;
  }
  handleIsbn(isbn);
});

async function init() {
  if (!window.isSecureContext) {
    setStatus('⚠️ HTTPSではないためカメラは使えません（仕様§10）。手入力での検証は可能です。');
    return;
  }
  try {
    await createScanner().start(video, handleIsbn);
    setStatus('カメラ起動済み — バーコードをかざしてください');
  } catch (err) {
    setStatus(`カメラを起動できません: ${err.name}。手入力での検証は可能です。`);
  }
}

init();

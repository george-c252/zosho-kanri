import { createScanner, isValidBookIsbn } from './scanner.js';
import { lookupIsbn, searchByTitle } from './bookapi.js';
import { createBook, addBook, checkDuplicate, checkDuplicateByTitle } from './db.js';
import { initShelf, refreshShelf, setTitleWithRuby, showToast } from './views/shelf.js';
import { initBackup } from './backup.js';

const video = document.getElementById('viewfinder');
const scanViewEl = document.getElementById('scan-view');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const coverEl = document.getElementById('cover');
const dupBanner = document.getElementById('dup-banner');
const manualForm = document.getElementById('manual-form');
const manualInput = document.getElementById('manual-isbn');
const manualBookEl = document.getElementById('manual-book');
const manualTitleEl = document.getElementById('manual-title');
const manualAuthorEl = document.getElementById('manual-author');
const titleForm = document.getElementById('title-form');
const titleQueryEl = document.getElementById('title-query');
const titleResultsEl = document.getElementById('title-results');

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
  setTitleWithRuby(document.getElementById('book-title'), book.title || '（書誌情報なし — 手入力で登録）');
  document.getElementById('book-author').textContent = book.author || '';
  document.getElementById('book-publisher').textContent = book.publisher || '';
  document.getElementById('book-isbn').textContent = book.isbn
    ? `ISBN: ${book.isbn}`
    : 'ISBNなし（タイトルで登録）';
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
  enterResultMode();
}

/* ---- スキャン面 ⇄ 登録画面の切替（読み取れたら登録画面に切り替える・実機フィードバック 2026-07-25） ---- */

// 読み取れたらスキャン面を丸ごと隠して登録画面だけにする（下までスクロールしなくて済むように）。
// 表示していない間はカメラも止める
function enterResultMode() {
  resultEl.hidden = false;
  scanViewEl.hidden = true;
  stopCamera();
  window.scrollTo(0, 0);
}

// スキャン面に戻る（登録後・「スキャンに戻る」ボタン）。カメラを再起動して次の1冊へ
function exitResultMode() {
  resultEl.hidden = true;
  dupBanner.hidden = true;
  currentBook = null;
  scanViewEl.hidden = false;
  startCamera();
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
  // ISBNの無い本（タイトル検索・手入力）はタイトルで重複を見る
  const dup = book.isbn
    ? await checkDuplicate(book.isbn)
    : await checkDuplicateByTitle(book.title);
  if (dup.owned && dup.formats.includes(format)) {
    setStatus(`すでに${FORMAT_LABEL[format]}で登録済みです`);
    return;
  }
  await addBook(createBook({ ...book, format }));
  await refreshShelf();
  // 登録後はスキャン面に戻す（カメラ起動メッセージで消えないよう完了通知はトーストで出す）
  showToast(`📚 登録しました: ${book.title}（${FORMAT_LABEL[format]}）`);
  lastAt = Date.now(); // 戻った直後に同じ本を写していても再検出しない（デバウンスを引き直す）
  exitResultMode();
}

document.getElementById('reg-paper').addEventListener('click', () => register('paper'));
document.getElementById('reg-ebook').addEventListener('click', () => register('ebook'));
document.getElementById('back-to-scan').addEventListener('click', exitResultMode);
coverEl.addEventListener('error', () => { coverEl.hidden = true; }); // 表紙URL切れは非表示に
coverEl.addEventListener('load', () => {
  if (coverEl.naturalWidth <= 1) coverEl.hidden = true; // Amazon書影の「画像なし1x1 GIF」対策
});

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

/* ---- タイトル検索登録（バーコードの無い電子書籍など・2026-08-06） ---- */

// 候補を選んだら、スキャン検出と同じ登録画面（紙/電子ボタン）に流し込む
async function selectTitleHit(hit) {
  currentBook = {
    isbn: hit.isbn || null,
    title: hit.title,
    titleKana: hit.titleKana || '',
    author: hit.author || '',
    publisher: hit.publisher || '',
    coverUrl: hit.coverUrl || '',
    price: null,
  };
  const dup = hit.isbn ? await checkDuplicate(hit.isbn) : await checkDuplicateByTitle(hit.title);
  showDupBanner(dup);
  showBook(currentBook);
  setStatus(`取得成功（${hit.source}）`);
}

// 検索で見つからない本のための素の手入力（ISBNなしで登録される）
function startManualEntry(prefillTitle) {
  currentBook = { isbn: null, title: '', author: '', publisher: '', coverUrl: '', price: null };
  dupBanner.hidden = true;
  showBook(currentBook); // タイトルが空なので手入力欄が開く
  manualTitleEl.value = prefillTitle || '';
  setStatus('手入力で登録できます');
}

function renderTitleResults(hits, query) {
  titleResultsEl.replaceChildren();
  for (const hit of hits) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hit';
    const title = document.createElement('span');
    title.className = 'hit-title';
    setTitleWithRuby(title, hit.title);
    const sub = document.createElement('span');
    sub.className = 'hit-sub';
    sub.textContent = [hit.author, hit.publisher, hit.issued && `${hit.issued}年`]
      .filter(Boolean)
      .join(' ／ ');
    btn.append(title, sub);
    btn.addEventListener('click', () => selectTitleHit(hit));
    li.appendChild(btn);
    titleResultsEl.appendChild(li);
  }
  // 末尾に手入力への逃げ道を常に置く（仕様§5.2: 登録は必ず完了できる）
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hit hit-manual';
  btn.textContent = hits.length
    ? '見つからない？ — 手入力で登録する'
    : '手入力で登録する';
  btn.addEventListener('click', () => startManualEntry(query));
  li.appendChild(btn);
  titleResultsEl.appendChild(li);
  titleResultsEl.hidden = false;
}

titleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = titleQueryEl.value.trim();
  if (!query) return;
  setStatus(`「${query}」を検索中…`);
  const hits = await searchByTitle(query);
  renderTitleResults(hits, query);
  setStatus(
    hits.length
      ? `${hits.length}件見つかりました — 巻数まで合っているか確かめて選んでください`
      : '見つかりませんでした — 巻数や表記を変えて再検索するか、手入力で登録できます'
  );
});

// カメラはスキャンタブを開いた時だけ起動し、離れたら停止する
// （常時オンを嫌う実機フィードバック 2026-07-22。stop→再startのiOS互換は実機で要確認）
const scanner = createScanner();
const retryBtn = document.getElementById('camera-retry');
let cameraOn = false;
let cameraStarting = false;

// 起動できなかった理由ごとに「次にやること」を日本語で返す（仕様§9）。
// err.name をそのまま画面に出さない。NotAllowedError は「許可が下りていない」時にも
// 「映像の再生を止められた」時にも付く名前で、読んでも次の一手が分からない（lessons #001）
function cameraErrorMessage(err) {
  if (err.stage === 'unsupported') {
    return 'このブラウザではカメラを使えません。Safariでこのページを開き直すと使えます。手入力での登録は可能です。';
  }
  if (err.stage === 'playback') {
    return 'カメラの映像が始まりませんでした。低電力モード（バッテリーのマークが黄色）を切ると直ることがあります。手入力での登録は可能です。';
  }
  const causeName = err.cause && err.cause.name;
  if (causeName === 'NotFoundError' || causeName === 'OverconstrainedError') {
    return 'カメラが見つかりませんでした。手入力での登録は可能です。';
  }
  if (causeName === 'NotReadableError') {
    return 'ほかのアプリがカメラを使っています。カメラアプリなどを閉じてから、もう一度お試しください。';
  }
  if (err.stage === 'permission') {
    return 'カメラの使用が許可されていません。ホーム画面のアイコンではなくSafariでこのページを開き直すか、iPhoneの「設定 → Safari → カメラ」を「確認」にしてからお試しください。手入力での登録は可能です。';
  }
  return 'カメラを起動できませんでした。もう一度お試しください。手入力での登録は可能です。';
}

async function startCamera() {
  if (cameraOn || cameraStarting) return;
  if (!resultEl.hidden) return; // 登録画面を出している間はカメラを起こさない（タブ往復・復帰時も）
  if (!window.isSecureContext) {
    setStatus('⚠️ HTTPSではないためカメラは使えません（仕様§10）。手入力での登録は可能です。');
    return;
  }
  cameraStarting = true;
  retryBtn.hidden = true;
  setStatus('カメラ起動中…');
  try {
    await scanner.start(video, handleIsbn);
    cameraOn = true;
    setStatus('カメラ起動済み — バーコードをかざしてください');
  } catch (err) {
    setStatus(cameraErrorMessage(err));
    // 押し直しはユーザー操作からの起動になるため、iOSが許可を聞き直してくれることがある
    retryBtn.hidden = false;
  } finally {
    cameraStarting = false;
  }
}

retryBtn.addEventListener('click', startCamera);

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
initBackup();

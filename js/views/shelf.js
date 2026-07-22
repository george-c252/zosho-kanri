// 蔵書一覧（本棚/一覧の2ビュー）・検索・削除・詳細シート
// デザインの正: design/design_spec.json（本棚=realistic、一覧=list）

import { getAllBooks, deleteBook, updateBook } from '../db.js';
import { stripParallelTitle, fetchCoverUrl } from '../bookapi.js';

const FORMAT_LABEL = { paper: '紙', ebook: '電子' };
// データモデル（仕様§4.1）の 'finished' が正。design_spec.json の 'read' は表示層でこのラベルに吸収する
const STATUS_LABEL = { unread: '未読', reading: '読書中', finished: '読了' };

// 「僕(モブ)」のような漢字直後の（かな）を振り仮名として<ruby>で表示する。
// innerHTMLは使わずDOM組み立てで挿入（XSS対策・仕様§9）。データ上のタイトルは変えない
const RUBY_RE = /([一-鿿々〆]+)[（(]([ぁ-ゖァ-ヺー]+)[）)]/g;

export function setTitleWithRuby(el, title) {
  const text = title || '';
  el.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(RUBY_RE)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const ruby = document.createElement('ruby');
    ruby.append(m[1]);
    const rt = document.createElement('rt');
    rt.textContent = m[2];
    ruby.append(rt);
    el.append(ruby);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

// 背表紙パレット（プロトタイプ本棚.dc.htmlのSPINES 16色を移植）。
// 3段フォールバックの③: タイトルhashで割当。①撮影写真②表紙色抽出はM4以降 — 仕様§6.1
const SPINE_PALETTE = [
  { bg: '#2f3d5a', fg: '#f3ead6' },
  { bg: '#3a5140', fg: '#f0ead6' },
  { bg: '#6d2b34', fg: '#f3e2d0' },
  { bg: '#b9862f', fg: '#2b1e0c' },
  { bg: '#2f5d5b', fg: '#eef3ec' },
  { bg: '#3a3a42', fg: '#e6e2da' },
  { bg: '#e6dcc0', fg: '#4a3a24' },
  { bg: '#b5623f', fg: '#f6e6d8' },
  { bg: '#4a3350', fg: '#efe4ee' },
  { bg: '#7d8a5f', fg: '#2b2f18' },
  { bg: '#4a5560', fg: '#eef1f4' },
  { bg: '#8f4a2c', fg: '#f3e2d0' },
  { bg: '#324a3a', fg: '#e9f0e6' },
  { bg: '#93304a', fg: '#f6e2ea' },
  { bg: '#d8c48a', fg: '#463414' },
  { bg: '#3b4d6b', fg: '#eef1f6' },
];

const SPINES_PER_ROW = 7; // design_spec.json: 7冊ごとに棚板で段を分割

let listEl;
let countEl;
let searchEl;
let realisticEl;
let listWrapEl;
let headCountEl;
let books = [];
let viewMode = 'realistic';

// タイトル文字列から決定論的に背表紙の色・寸法を決める（同じ本は常に同じ見た目）
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function spineStyle(book) {
  const h = hashCode(book.id || book.title || '');
  const color = SPINE_PALETTE[h % SPINE_PALETTE.length];
  return {
    color,
    height: 152 + (h % 41),      // 152〜192px（design_spec.json）
    width: 27 + ((h >> 4) % 16), // 27〜42px
  };
}

function matches(book, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    book.title.toLowerCase().includes(q) ||
    book.author.toLowerCase().includes(q)
  );
}

/* ---- トースト（design_spec.json: hondanaToast 2.4s） ---- */

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  // アニメーションを先頭から再生し直すためクラスを付け直す
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
}

/* ---- 詳細ボトムシート ---- */

const veil = () => document.getElementById('detail-veil');
let detailBook = null;

// 読書ステータスに応じてピルとアクションボタンを出し分ける
// （design_spec.json: reading=振ってしおり飛ばし／それ以外=読みはじめる・読了にする）
function renderStatus(book) {
  const status = book.status || 'unread';
  const pill = document.getElementById('detail-status');
  pill.textContent = STATUS_LABEL[status] || status;
  pill.className = `status-pill status-${status}`;
  document.getElementById('act-start').hidden = status === 'reading';
  document.getElementById('act-finish').hidden = status === 'finished';
}

function renderPhotoButtons(book) {
  document.getElementById('spine-photo-btn').textContent =
    book.spineImage ? '📷 背表紙写真を変更' : '📷 背表紙写真を設定';
  document.getElementById('spine-photo-del').hidden = !book.spineImage;
}

async function setStatusAndSave(status, message) {
  if (!detailBook) return;
  detailBook.status = status;
  await updateBook(detailBook);
  renderStatus(detailBook);
  render(); // 本棚のしおりリボン表示を同期
  showToast(message);
}

// しおりが左上へ舞い上がって消える（hondanaBookmark 1s）→ その本を読了にする
// 本棚の背表紙からも詳細シートの表紙からも発火するため、対象bookを引数で受ける
let bookmarkFlying = false;

async function finishWithBookmark(book) {
  if (bookmarkFlying || !book || book.status !== 'reading') return;
  bookmarkFlying = true;
  const ribbon = document.createElement('div');
  ribbon.className = 'bookmark-fly';
  document.body.appendChild(ribbon);
  ribbon.addEventListener('animationend', () => {
    ribbon.remove();
    bookmarkFlying = false;
  });
  book.status = 'finished';
  await updateBook(book);
  if (detailBook?.id === book.id) renderStatus(detailBook);
  render();
  showToast('🔖 しおりを外して読了にしました');
}

/* ---- 隠しコマンド: 本を長押しで掴み、左右に擦るとしおりが飛ぶ（実機フィードバック 2026-07-22）
   本棚の背表紙・詳細シートの表紙の両方に仕込む ---- */

const GRAB_MS = 350;      // 長押しでつかむまでの時間
const RUB_SWING_PX = 16;  // 1振りとみなす最小往復幅
const RUB_COUNT = 3;      // この回数折り返したら発火

// 掴んだ後のpointerupで背表紙のclick（詳細を開く）が発火しないように抑止するフラグ
let suppressNextClick = false;

function attachGrabGesture(el, getBook) {
  let timer = null;
  let isGrabbed = false;
  let dir = 0;
  let extremeX = 0; // 現在の振り方向の折り返し基準点
  let startX = 0;
  let count = 0;

  const release = () => {
    clearTimeout(timer);
    timer = null;
    if (isGrabbed) {
      isGrabbed = false;
      el.classList.remove('grabbed');
    }
  };

  el.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しメニュー・テキスト選択の抑止
  el.addEventListener('pointerdown', (e) => {
    if (!getBook()) return;
    startX = extremeX = e.clientX;
    dir = 0;
    count = 0;
    el.setPointerCapture(e.pointerId);
    timer = setTimeout(() => {
      isGrabbed = true;
      el.classList.add('grabbed');
      if (navigator.vibrate) navigator.vibrate(30);
    }, GRAB_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (!isGrabbed) {
      // つかむ前に大きく動いたらキャンセル（タップ・スクロールとの誤爆防止）
      if (timer && Math.abs(e.clientX - startX) > 12) release();
      return;
    }
    const delta = e.clientX - extremeX;
    if (dir === 0) {
      if (Math.abs(delta) >= RUB_SWING_PX) {
        dir = Math.sign(delta);
        extremeX = e.clientX;
      }
      return;
    }
    if (Math.sign(delta) === dir) {
      extremeX = e.clientX; // 同方向は折り返し基準点を更新するだけ
    } else if (Math.abs(delta) >= RUB_SWING_PX) {
      dir = -dir;
      extremeX = e.clientX;
      count += 1;
      if (count >= RUB_COUNT) {
        release();
        suppressNextClick = true;
        finishWithBookmark(getBook()); // 読書中でなければ何も起きない（隠しコマンド）
      }
    }
  });
  el.addEventListener('pointerup', () => {
    if (isGrabbed) suppressNextClick = true; // 掴んだだけで離した時も詳細は開かない
    release();
  });
  el.addEventListener('pointercancel', release);
}

// 振り検知（design_spec.json: 加速度合計>32・1.2sデバウンス）。
// iOSは DeviceMotionEvent.requestPermission が必要なため対象外
const SHAKE_THRESHOLD = 32;
const SHAKE_DEBOUNCE_MS = 1200;
let lastShakeAt = 0;

function onDeviceMotion(e) {
  if (!veil().classList.contains('open')) return;
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const total = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
  const now = Date.now();
  if (total > SHAKE_THRESHOLD && now - lastShakeAt > SHAKE_DEBOUNCE_MS) {
    lastShakeAt = now;
    finishWithBookmark(detailBook);
  }
}

// プロトタイプのcoverStyle: 背表紙色グラデ＋書名上・著者下（背の帯とハイライトはCSSの::before/::after）
function buildCoverPh(book) {
  const ph = document.createElement('div');
  ph.className = 'detail-cover-ph';
  const { color } = spineStyle(book);
  ph.style.background = `linear-gradient(150deg, ${color.bg}, ${color.bg} 60%, rgba(0,0,0,.25))`;
  ph.style.color = color.fg;
  const phTitle = document.createElement('div');
  phTitle.className = 'ph-title';
  setTitleWithRuby(phTitle, book.title || '（タイトル不明）');
  const phAuthor = document.createElement('div');
  phAuthor.className = 'ph-author';
  phAuthor.textContent = book.author || '';
  ph.append(phTitle, phAuthor);
  return ph;
}

function openDetail(book) {
  detailBook = book;
  const slot = document.getElementById('detail-cover-slot');
  slot.replaceChildren();
  if (book.coverUrl) {
    const img = document.createElement('img');
    img.id = 'detail-cover';
    img.src = book.coverUrl;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => img.replaceWith(buildCoverPh(book))); // 表紙URL切れはプレースホルダーに戻す
    slot.appendChild(img);
  } else {
    slot.appendChild(buildCoverPh(book));
  }
  setTitleWithRuby(document.getElementById('detail-title'), book.title || '（タイトル不明）');
  document.getElementById('detail-author').textContent = book.author || '';
  document.getElementById('detail-publisher').textContent = book.publisher || '—';
  document.getElementById('detail-format').textContent = FORMAT_LABEL[book.format] || book.format;
  document.getElementById('detail-isbn').textContent = book.isbn || '—';
  document.getElementById('detail-added').textContent = new Date(book.addedAt).toLocaleDateString('ja-JP');
  renderStatus(book);
  renderPhotoButtons(book);
  veil().classList.add('open');
}

function closeDetail() {
  veil().classList.remove('open');
  detailBook = null;
}

async function deleteCurrent() {
  if (!detailBook) return;
  if (!confirm(`「${detailBook.title || detailBook.id}」を削除しますか？`)) return;
  await deleteBook(detailBook.id);
  closeDetail();
  await refreshShelf();
}

/* ---- 本棚（realistic）ビュー ---- */

// BlobのobjectURLキャッシュ（renderのたびにcreateObjectURLでリークしないように）
const spineUrlCache = new Map();

function spineImageUrl(book) {
  const cached = spineUrlCache.get(book.id);
  if (cached?.blob === book.spineImage) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(book.spineImage);
  spineUrlCache.set(book.id, { blob: book.spineImage, url });
  return url;
}

// 書誌データは textContent で挿入する（XSS対策・仕様§9）
function renderSpine(book) {
  const btn = document.createElement('button');
  btn.className = 'spine';
  btn.type = 'button';
  const { color, height, width } = spineStyle(book);
  btn.style.height = `${height}px`;
  btn.style.width = `${width}px`;
  if (book.spineImage) {
    // 実物写真スピン（3段フォールバックの①）。写真に書名が写っているため文字は重ねない
    btn.style.background = `url("${spineImageUrl(book)}") center / cover no-repeat`;
  } else {
    btn.style.background = `linear-gradient(90deg, rgba(255,255,255,.18), rgba(0,0,0,.14) 60%), ${color.bg}`;
    btn.style.color = color.fg;
    const title = document.createElement('span');
    title.className = 'spine-title';
    setTitleWithRuby(title, book.title || '（不明）');
    const author = document.createElement('span');
    author.className = 'spine-author';
    author.textContent = book.author || '';
    btn.append(title, author);
  }
  // 読書中は上端に朱色しおりリボン（揺れアニメ hondanaRibbon — design_spec.json）
  if (book.status === 'reading') {
    const ribbon = document.createElement('span');
    ribbon.className = 'spine-ribbon';
    btn.appendChild(ribbon);
  }
  attachGrabGesture(btn, () => book); // 隠しコマンド: 背表紙を長押しで掴んで左右に擦る
  btn.addEventListener('click', () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    openDetail(book);
  });
  return btn;
}

function renderRealistic() {
  realisticEl.replaceChildren();
  if (books.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'shelf-empty';
    empty.textContent = 'まだ本がありません。スキャンして最初の1冊を登録しましょう。';
    realisticEl.appendChild(empty);
    return;
  }
  for (let i = 0; i < books.length; i += SPINES_PER_ROW) {
    const row = document.createElement('div');
    row.className = 'shelf-row';
    row.append(...books.slice(i, i + SPINES_PER_ROW).map(renderSpine));
    const plank = document.createElement('div');
    plank.className = 'shelf-plank';
    realisticEl.append(row, plank);
  }
}

/* ---- 一覧（list）ビュー ---- */

function renderItem(book) {
  const li = document.createElement('li');
  li.className = 'book-item';

  if (book.coverUrl) {
    const img = document.createElement('img');
    img.src = book.coverUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'cover-placeholder';
      ph.textContent = '📖';
      img.replaceWith(ph);
    });
    li.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'cover-placeholder';
    ph.textContent = '📖';
    li.appendChild(ph);
  }

  const info = document.createElement('div');
  info.className = 'item-info';
  const title = document.createElement('p');
  title.className = 'item-title';
  setTitleWithRuby(title, book.title || '（タイトル不明）');
  const sub = document.createElement('p');
  sub.className = 'item-sub';
  sub.textContent = [book.author, FORMAT_LABEL[book.format] || book.format]
    .filter(Boolean)
    .join(' ／ ');
  info.append(title, sub);
  info.addEventListener('click', () => openDetail(book));
  li.appendChild(info);

  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.type = 'button';
  del.textContent = '削除';
  del.addEventListener('click', async () => {
    if (!confirm(`「${book.title || book.id}」を削除しますか？`)) return;
    await deleteBook(book.id);
    await refreshShelf();
  });
  li.appendChild(del);

  return li;
}

function renderList() {
  const query = searchEl.value.trim();
  const visible = books.filter((b) => matches(b, query));
  listEl.replaceChildren(...visible.map(renderItem));
  countEl.textContent = query
    ? `${visible.length}冊（全${books.length}冊）`
    : `全${books.length}冊`;
}

/* ---- 統合 ---- */

function render() {
  headCountEl.textContent = `蔵書 ${books.length} 冊`;
  realisticEl.hidden = viewMode !== 'realistic';
  listWrapEl.hidden = viewMode !== 'list';
  if (viewMode === 'realistic') renderRealistic();
  else renderList();
}

export async function refreshShelf() {
  books = await getAllBooks();
  books.sort((a, b) => b.addedAt - a.addedAt); // 追加日の新しい順
  render();
}

// 背表紙写真は表示幅が小さいためJPEG縮小して保存（IndexedDB肥大防止）
async function resizeToBlob(file, maxH = 480) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxH / bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85));
}

// 既存データの一度きり整形: NDL並列タイトル・姓名間カンマの除去＋表紙URLのバックフィル（2026-07-22フィードバック対応）
async function cleanupLegacyData() {
  const all = await getAllBooks();
  let changed = false;
  for (const b of all) {
    let dirty = false;
    const title = stripParallelTitle(b.title);
    if (title && title !== b.title) { b.title = title; dirty = true; }
    const author = (b.author || '').replace(/,\s*/g, ' ').trim();
    if (author !== b.author) { b.author = author; dirty = true; }
    if (!b.coverUrl && b.isbn) {
      const url = await fetchCoverUrl(b.isbn);
      if (url) { b.coverUrl = url; dirty = true; }
    }
    if (dirty) { await updateBook(b); changed = true; }
  }
  if (changed) await refreshShelf();
}

export function initShelf() {
  listEl = document.getElementById('book-list');
  countEl = document.getElementById('shelf-count');
  searchEl = document.getElementById('shelf-search');
  realisticEl = document.getElementById('shelf-realistic');
  listWrapEl = document.getElementById('shelf-list');
  headCountEl = document.getElementById('shelf-head-count');

  searchEl.addEventListener('input', renderList);

  document.querySelectorAll('#view-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });

  const veilEl = document.getElementById('detail-veil');
  veilEl.addEventListener('click', (e) => {
    if (e.target === veilEl) closeDetail();
  });
  document.getElementById('detail-delete').addEventListener('click', deleteCurrent);

  document.getElementById('act-start').addEventListener('click', () =>
    setStatusAndSave('reading', '📖 読みはじめました。しおりを挟みました'));
  document.getElementById('act-finish').addEventListener('click', () =>
    setStatusAndSave('finished', '読了にしました'));
  if (typeof DeviceMotionEvent === 'undefined' || typeof DeviceMotionEvent.requestPermission !== 'function') {
    window.addEventListener('devicemotion', onDeviceMotion);
  }
  attachGrabGesture(document.getElementById('detail-cover-slot'), () => detailBook);

  const photoInput = document.getElementById('spine-photo-input');
  document.getElementById('spine-photo-btn').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file || !detailBook) return;
    try {
      detailBook.spineImage = await resizeToBlob(file);
    } catch {
      showToast('写真を読み込めませんでした');
      return;
    }
    await updateBook(detailBook);
    renderPhotoButtons(detailBook);
    render();
    showToast('📷 背表紙写真を設定しました');
  });
  document.getElementById('spine-photo-del').addEventListener('click', async () => {
    if (!detailBook) return;
    detailBook.spineImage = null;
    await updateBook(detailBook);
    renderPhotoButtons(detailBook);
    render();
    showToast('背表紙写真を削除しました');
  });

  cleanupLegacyData(); // 完了を待たない（終わったら本棚を再描画する）
  return refreshShelf();
}

// 蔵書一覧（本棚/一覧の2ビュー）・検索・削除・詳細シート
// デザインの正: design/design_spec.json（本棚=realistic、一覧=list）

import { getAllBooks, deleteBook, updateBook } from '../db.js';

const FORMAT_LABEL = { paper: '紙', ebook: '電子' };
// データモデル（仕様§4.1）の 'finished' が正。design_spec.json の 'read' は表示層でこのラベルに吸収する
const STATUS_LABEL = { unread: '未読', reading: '読書中', finished: '読了' };

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
  document.getElementById('act-finish').hidden = status !== 'unread';
  document.getElementById('act-shake').hidden = status !== 'reading';
  document.getElementById('shake-hint').hidden = status !== 'reading';
}

async function setStatusAndSave(status, message) {
  if (!detailBook) return;
  detailBook.status = status;
  await updateBook(detailBook);
  renderStatus(detailBook);
  render(); // 本棚のしおりリボン表示を同期
  showToast(message);
}

// しおりが左上へ舞い上がって消える（hondanaBookmark 1s）→ 読了にする
let bookmarkFlying = false;

function flyBookmark() {
  if (bookmarkFlying || !detailBook || detailBook.status !== 'reading') return;
  bookmarkFlying = true;
  const ribbon = document.createElement('div');
  ribbon.className = 'bookmark-fly';
  document.body.appendChild(ribbon);
  ribbon.addEventListener('animationend', () => {
    ribbon.remove();
    bookmarkFlying = false;
  });
  setStatusAndSave('finished', '🔖 しおりを外して読了にしました');
}

// 振り検知（design_spec.json: 加速度合計>32・1.2sデバウンス）。
// iOSは DeviceMotionEvent.requestPermission が必要なため対象外（ボタンタップで代替可）
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
    flyBookmark();
  }
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
    slot.appendChild(img);
  } else {
    // プロトタイプのcoverStyle: 背表紙色グラデ＋書名上・著者下（背の帯とハイライトはCSSの::before/::after）
    const ph = document.createElement('div');
    ph.className = 'detail-cover-ph';
    const { color } = spineStyle(book);
    ph.style.background = `linear-gradient(150deg, ${color.bg}, ${color.bg} 60%, rgba(0,0,0,.25))`;
    ph.style.color = color.fg;
    const phTitle = document.createElement('div');
    phTitle.className = 'ph-title';
    phTitle.textContent = book.title || '（タイトル不明）';
    const phAuthor = document.createElement('div');
    phAuthor.className = 'ph-author';
    phAuthor.textContent = book.author || '';
    ph.append(phTitle, phAuthor);
    slot.appendChild(ph);
  }
  document.getElementById('detail-title').textContent = book.title || '（タイトル不明）';
  document.getElementById('detail-author').textContent = book.author || '';
  document.getElementById('detail-publisher').textContent = book.publisher || '—';
  document.getElementById('detail-format').textContent = FORMAT_LABEL[book.format] || book.format;
  document.getElementById('detail-isbn').textContent = book.isbn || '—';
  document.getElementById('detail-added').textContent = new Date(book.addedAt).toLocaleDateString('ja-JP');
  renderStatus(book);
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

// 書誌データは textContent で挿入する（XSS対策・仕様§9）
function renderSpine(book) {
  const btn = document.createElement('button');
  btn.className = 'spine';
  btn.type = 'button';
  const { color, height, width } = spineStyle(book);
  btn.style.height = `${height}px`;
  btn.style.width = `${width}px`;
  btn.style.background = `linear-gradient(90deg, rgba(255,255,255,.18), rgba(0,0,0,.14) 60%), ${color.bg}`;
  btn.style.color = color.fg;

  const title = document.createElement('span');
  title.className = 'spine-title';
  title.textContent = book.title || '（不明）';
  const author = document.createElement('span');
  author.className = 'spine-author';
  author.textContent = book.author || '';
  btn.append(title, author);
  // 読書中は上端に朱色しおりリボン（揺れアニメ hondanaRibbon — design_spec.json）
  if (book.status === 'reading') {
    const ribbon = document.createElement('span');
    ribbon.className = 'spine-ribbon';
    btn.appendChild(ribbon);
  }
  btn.addEventListener('click', () => openDetail(book));
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
  title.textContent = book.title || '（タイトル不明）';
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
  document.getElementById('act-shake').addEventListener('click', flyBookmark);
  if (typeof DeviceMotionEvent === 'undefined' || typeof DeviceMotionEvent.requestPermission !== 'function') {
    window.addEventListener('devicemotion', onDeviceMotion);
  }

  return refreshShelf();
}

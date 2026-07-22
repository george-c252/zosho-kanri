// 蔵書一覧（本棚/一覧の2ビュー）・検索・削除・詳細シート
// デザインの正: design/design_spec.json（本棚=realistic、一覧=list）

import { getAllBooks, deleteBook } from '../db.js';

const FORMAT_LABEL = { paper: '紙', ebook: '電子' };

// 背表紙パレット（design_spec.jsonの世界観に合わせた落ち着いた和色。
// 3段フォールバックの③: タイトルhashで割当。①撮影写真②表紙色抽出はM4以降 — 仕様§6.1）
const SPINE_PALETTE = [
  { bg: '#2e4a66', fg: '#f3ead6' }, // 藍
  { bg: '#5d3a45', fg: '#f3ead6' }, // 海老茶
  { bg: '#3d5647', fg: '#f3ead6' }, // 千歳緑
  { bg: '#8a5a2b', fg: '#f3ead6' }, // 琥珀
  { bg: '#54455e', fg: '#f3ead6' }, // 竜胆
  { bg: '#7d2f35', fg: '#f3ead6' }, // 蘇芳
  { bg: '#31424e', fg: '#f3ead6' }, // 藍鼠
  { bg: '#9d7a2f', fg: '#3a2a16' }, // 芥子
  { bg: '#e8e0cd', fg: '#3a2a16' }, // 生成
  { bg: '#4f7a83', fg: '#f3ead6' }, // 錆浅葱
  { bg: '#8f5d68', fg: '#f3ead6' }, // 梅鼠
  { bg: '#6b6f45', fg: '#3a2a16' }, // 松葉
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

/* ---- 詳細ボトムシート ---- */

const veil = () => document.getElementById('detail-veil');
let detailBook = null;

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
    const ph = document.createElement('div');
    ph.className = 'detail-cover-ph';
    const { color } = spineStyle(book);
    ph.style.background = color.bg;
    ph.style.color = color.fg;
    ph.textContent = book.title || '（タイトル不明）';
    slot.appendChild(ph);
  }
  document.getElementById('detail-title').textContent = book.title || '（タイトル不明）';
  document.getElementById('detail-author').textContent = book.author || '';
  document.getElementById('detail-publisher').textContent = book.publisher || '—';
  document.getElementById('detail-format').textContent = FORMAT_LABEL[book.format] || book.format;
  document.getElementById('detail-isbn').textContent = book.isbn || '—';
  document.getElementById('detail-added').textContent = new Date(book.addedAt).toLocaleDateString('ja-JP');
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

  return refreshShelf();
}

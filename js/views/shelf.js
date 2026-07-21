// 蔵書一覧・検索・削除（仕様§6.1のM2スコープ: 一覧・インクリメンタル検索・削除）

import { getAllBooks, deleteBook } from '../db.js';

const FORMAT_LABEL = { paper: '紙', ebook: '電子' };

let listEl;
let countEl;
let searchEl;
let books = [];

function matches(book, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    book.title.toLowerCase().includes(q) ||
    book.author.toLowerCase().includes(q)
  );
}

// 書誌データは textContent で挿入する（XSS対策・仕様§9）
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

function render() {
  const query = searchEl.value.trim();
  const visible = books.filter((b) => matches(b, query));
  listEl.replaceChildren(...visible.map(renderItem));
  countEl.textContent = query
    ? `${visible.length}冊（全${books.length}冊）`
    : `全${books.length}冊`;
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
  searchEl.addEventListener('input', render);
  return refreshShelf();
}

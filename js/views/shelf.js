// 蔵書一覧（本棚/一覧の2ビュー）・検索・削除・詳細シート
// デザインの正: design/design_spec.json（本棚=realistic、一覧=list）

import { getAllBooks, deleteBook, updateBook } from '../db.js';
import { stripParallelTitle, amazonCoverUrl, normalizeAuthor, kanaKey, lookupTitleKana } from '../bookapi.js';

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
let sortEl;
let books = [];
let viewMode = 'realistic';

// 並び順: manual=自分でドラッグして並べた順 / added=登録した順 / kana=あいうえお順。端末に記憶する
const SORT_STORAGE_KEY = 'zosho.shelfSort';
const SORT_MODES = ['manual', 'added', 'kana'];
let sortMode = SORT_MODES.includes(localStorage.getItem(SORT_STORAGE_KEY))
  ? localStorage.getItem(SORT_STORAGE_KEY)
  : 'manual';

// タイトル文字列から決定論的に背表紙の色・寸法を決める（同じ本は常に同じ見た目）
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function spineStyle(book) {
  const h = hashCode(book.id || book.title || '');
  // 3段フォールバックの②: 表紙から抽出した色があれば優先。無ければ③hash割当（仕様§6.1）
  const color = book.spineColor || SPINE_PALETTE[h % SPINE_PALETTE.length];
  return {
    color,
    height: 152 + (h % 41),      // 152〜192px（design_spec.json）
    width: 27 + ((h >> 4) % 16), // 27〜42px
  };
}

// 表紙画像の縁ピクセルの最頻色を「表紙の背景色」として抽出する（Amazon書影はCORS許可ありを実測済み）
function extractSpineColor(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        if (img.naturalWidth <= 1) return resolve(null); // Amazonの「画像なし1x1」
        const w = 24;
        const h = 36;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const counts = new Map();
        const pick = (x, y) => {
          const i = (y * w + x) * 4;
          const key = `${data[i] >> 4}_${data[i + 1] >> 4}_${data[i + 2] >> 4}`; // 16段階量子化で近い色をまとめる
          const c = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          c.n += 1;
          c.r += data[i];
          c.g += data[i + 1];
          c.b += data[i + 2];
          counts.set(key, c);
        };
        // 縁2px分だけ数える（中央の絵柄でなく「背景」を拾うため）
        for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) pick(x, y);
        for (let y = 2; y < h - 2; y++) for (const x of [0, 1, w - 2, w - 1]) pick(x, y);
        const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
        const r = Math.round(best.r / best.n);
        const g = Math.round(best.g / best.n);
        const b = Math.round(best.b / best.n);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        resolve({
          bg: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
          fg: lum > 150 ? '#3a2a16' : '#f3ead6',
        });
      } catch {
        resolve(null); // CORS不可でcanvasが汚染された場合など
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// 表紙ありで色未抽出の本をまとめて抽出→保存（冪等・毎回の起動で残りを少しずつ処理）
let extractingColors = false;

async function ensureSpineColors() {
  if (extractingColors) return;
  extractingColors = true;
  try {
    let changed = false;
    for (const b of await getAllBooks()) {
      if (b.spineColor || !b.coverUrl) continue;
      const color = await extractSpineColor(b.coverUrl);
      if (color) {
        b.spineColor = color;
        await updateBook(b);
        changed = true;
      }
    }
    if (changed) await refreshShelf();
  } finally {
    extractingColors = false;
  }
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

function attachGrabGesture(el, getBook, onDrop) {
  let timer = null;
  let isGrabbed = false;
  let dir = 0;
  let extremeX = 0; // 現在の振り方向の折り返し基準点
  let startX = 0;
  let startY = 0;
  let count = 0;

  const release = () => {
    clearTimeout(timer);
    timer = null;
    if (isGrabbed) {
      isGrabbed = false;
      el.classList.remove('grabbed');
      el.style.transform = ''; // 棚の元の位置へ戻る（CSS transition）
    }
  };

  el.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しメニュー・テキスト選択の抑止
  el.addEventListener('pointerdown', (e) => {
    if (!getBook()) return;
    startX = extremeX = e.clientX;
    startY = e.clientY;
    dir = 0;
    count = 0;
    el.setPointerCapture(e.pointerId);
    timer = setTimeout(() => {
      isGrabbed = true;
      el.classList.add('grabbed');
      el.style.transform = 'translateY(-12px) scale(1.07)'; // 棚から持ち上げる
      if (navigator.vibrate) navigator.vibrate(30);
    }, GRAB_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (!isGrabbed) {
      // つかむ前に大きく動いたらキャンセル（タップ・スクロールとの誤爆防止）
      if (timer && Math.abs(e.clientX - startX) > 12) release();
      return;
    }
    // 掴んだ本は指についてくる（左右の振りで少し傾く）
    el.style.transform =
      `translate(${e.clientX - startX}px, ${e.clientY - startY - 12}px) scale(1.07) rotate(${dir * 5}deg)`;
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
  el.addEventListener('pointerup', (e) => {
    if (isGrabbed) {
      suppressNextClick = true; // 掴んだだけで離した時も詳細は開かない
      if (onDrop) onDrop(getBook(), e.clientX, e.clientY); // ドロップ位置で並び替え
    }
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
    // 表紙URL切れ、またはAmazon書影の「画像なし1x1 GIF」はプレースホルダーに戻す
    img.addEventListener('error', () => img.replaceWith(buildCoverPh(book)));
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 1) img.replaceWith(buildCoverPh(book));
    });
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
  btn.dataset.id = book.id; // 並び替えのドロップ位置判定用
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
  attachGrabGesture(btn, () => book, reorderBook); // 長押しで掴む→擦ればしおり・運んでドロップで並び替え
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
    const toPh = () => {
      const ph = document.createElement('div');
      ph.className = 'cover-placeholder';
      ph.textContent = '📖';
      img.replaceWith(ph);
    };
    img.addEventListener('error', toPh);
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 1) toPh(); // Amazon書影の「画像なし1x1 GIF」対策
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

/* ---- 並び順（手動 / 登録順 / あいうえお順） ---- */

const jaCollator = new Intl.Collator('ja');

// ヨミが取れている本はヨミで、取れない本はタイトルそのもので比較する
function kanaOf(book) {
  return book.titleKana || kanaKey(book.title);
}

// いずれのモードでも左から右＝先頭から順。同着は登録の古い順で安定させる
function sortBooks() {
  if (sortMode === 'kana') {
    books.sort((a, b) => jaCollator.compare(kanaOf(a), kanaOf(b)) || a.addedAt - b.addedAt);
  } else if (sortMode === 'added') {
    books.sort((a, b) => a.addedAt - b.addedAt);
  } else {
    // 手動並び順（ドラッグ&ドロップ）。未割当（新規追加）は末尾に追加日の古い順
    books.sort((a, b) => {
      const ao = a.shelfOrder ?? Infinity;
      const bo = b.shelfOrder ?? Infinity;
      if (ao !== bo) return ao - bo;
      return a.addedAt - b.addedAt;
    });
  }
}

function setSortMode(mode) {
  sortMode = mode;
  localStorage.setItem(SORT_STORAGE_KEY, mode);
  if (sortEl) sortEl.value = mode;
}

// 登録済みの本にヨミが無ければ書誌APIから補う（あいうえお順を選んだ時だけ・1冊ずつ・冪等）。
// 取れなかった本は kanaFetched で覚え、起動のたびに問い合わせ直さない
let fetchingKana = false;

async function ensureTitleKana() {
  if (fetchingKana || sortMode !== 'kana') return;
  fetchingKana = true;
  try {
    let changed = false;
    const todo = (await getAllBooks()).filter((b) => !b.titleKana && !b.kanaFetched && b.isbn);
    if (todo.length) showToast(`ヨミを取得しています…（${todo.length}冊）`);
    for (const b of todo) {
      b.titleKana = await lookupTitleKana(b.isbn);
      b.kanaFetched = true;
      await updateBook(b);
      changed = true;
    }
    if (changed) await refreshShelf();
  } finally {
    fetchingKana = false;
  }
}

export async function refreshShelf() {
  books = await getAllBooks();
  sortBooks();
  render();
  ensureSpineColors(); // 完了を待たない（抽出できたら再描画される）
  ensureTitleKana();   // 同上（あいうえお順のときだけ動く）
}

// 掴んだ本をドロップ位置に並び替える（棚の行→行内の背表紙中心Xで挿入位置を決める）
async function reorderBook(book, x, y) {
  let newIndex = 0;
  for (const row of realisticEl.querySelectorAll('.shelf-row')) {
    const rowRect = row.getBoundingClientRect();
    const spines = [...row.querySelectorAll('.spine')].filter((s) => s.dataset.id !== String(book.id));
    if (rowRect.bottom < y) {
      newIndex += spines.length; // ドロップ位置より上の行は全部前
      continue;
    }
    if (rowRect.top > y) break; // ドロップ位置より下の行 → ここまでで確定
    for (const s of spines) {
      const r = s.getBoundingClientRect();
      if (r.left + r.width / 2 < x) newIndex += 1;
    }
    break;
  }
  const oldIndex = books.findIndex((b) => b.id === book.id);
  if (oldIndex < 0) return;
  books.splice(oldIndex, 1);
  books.splice(newIndex, 0, book);
  // 登録順・あいうえお順を見ている時に動かしたら、いま見えている並びを手動の並び順として引き継ぐ
  const switched = sortMode !== 'manual';
  if (switched) setSortMode('manual');
  let changed = false;
  for (let i = 0; i < books.length; i++) {
    if (books[i].shelfOrder !== i) {
      books[i].shelfOrder = i;
      await updateBook(books[i]);
      changed = true;
    }
  }
  if (changed) {
    render();
    showToast(switched ? '並び替えました（並び順を「並べた順」に切替）' : '並び替えました');
  }
}

/* ---- 背表紙写真のトリミング（枠に合わせてドラッグ・2本指ピンチで調整） ---- */

const crop = {
  scale: 1,
  tx: 0,
  ty: 0,
  pointers: new Map(), // pointerId -> {x, y}
  url: '',
  onDone: null,
};

const cropEl = (id) => document.getElementById(id);

function cropApply() {
  cropEl('crop-img').style.transform = `translate(${crop.tx}px, ${crop.ty}px) scale(${crop.scale})`;
}

function openCropper(file, aspect, onDone) {
  crop.url = URL.createObjectURL(file);
  crop.onDone = onDone;
  crop.pointers.clear();
  const frame = cropEl('crop-frame');
  const fh = Math.min(Math.round(window.innerHeight * 0.5), 480);
  frame.style.height = `${fh}px`;
  frame.style.width = `${Math.max(56, Math.round((fh * aspect.w) / aspect.h))}px`;
  cropEl('crop-img').src = crop.url; // 初期配置はloadイベントで
  cropEl('crop-veil').hidden = false;
}

function closeCropper() {
  cropEl('crop-veil').hidden = true;
  if (crop.url) URL.revokeObjectURL(crop.url);
  crop.url = '';
  crop.onDone = null;
  crop.pointers.clear();
}

// 画像読み込み時: 枠を覆う最小倍率で枠中央に配置
function cropInitLayout() {
  const img = cropEl('crop-img');
  const stageR = cropEl('crop-stage').getBoundingClientRect();
  const frameR = cropEl('crop-frame').getBoundingClientRect();
  crop.scale = Math.max(frameR.width / img.naturalWidth, frameR.height / img.naturalHeight);
  crop.tx = frameR.left - stageR.left + (frameR.width - img.naturalWidth * crop.scale) / 2;
  crop.ty = frameR.top - stageR.top + (frameR.height - img.naturalHeight * crop.scale) / 2;
  cropApply();
}

async function cropConfirm() {
  const img = cropEl('crop-img');
  const imgR = img.getBoundingClientRect();
  const frameR = cropEl('crop-frame').getBoundingClientRect();
  const s = imgR.width / img.naturalWidth; // 画面px → 元画像px
  const canvas = document.createElement('canvas');
  canvas.height = 480;
  canvas.width = Math.max(1, Math.round((480 * frameR.width) / frameR.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d3b485'; // 枠が画像からはみ出た部分は木目ベース色で埋める
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    img,
    (frameR.left - imgR.left) / s,
    (frameR.top - imgR.top) / s,
    frameR.width / s,
    frameR.height / s,
    0, 0, canvas.width, canvas.height
  );
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  const done = crop.onDone;
  closeCropper();
  if (blob && done) done(blob);
  else showToast('写真を読み込めませんでした');
}

function initCropper() {
  const stage = cropEl('crop-stage');
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    crop.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  stage.addEventListener('pointermove', (e) => {
    const p = crop.pointers.get(e.pointerId);
    if (!p) return;
    if (crop.pointers.size === 1) {
      crop.tx += e.clientX - p.x;
      crop.ty += e.clientY - p.y;
    } else if (crop.pointers.size === 2) {
      // ピンチ: もう1本の指との距離の変化率でスケール。中点を不動点にする
      const other = [...crop.pointers.entries()].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(p.x - other.x, p.y - other.y);
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (d0 > 0 && d1 > 0) {
        const r = d1 / d0;
        const stageR = stage.getBoundingClientRect();
        const mx = (e.clientX + other.x) / 2 - stageR.left;
        const my = (e.clientY + other.y) / 2 - stageR.top;
        crop.scale *= r;
        crop.tx = mx - r * (mx - crop.tx);
        crop.ty = my - r * (my - crop.ty);
      }
    }
    p.x = e.clientX;
    p.y = e.clientY;
    cropApply();
  });
  const drop = (e) => crop.pointers.delete(e.pointerId);
  stage.addEventListener('pointerup', drop);
  stage.addEventListener('pointercancel', drop);
  cropEl('crop-img').addEventListener('load', () => {
    if (!cropEl('crop-veil').hidden) cropInitLayout();
  });
  cropEl('crop-cancel').addEventListener('click', closeCropper);
  cropEl('crop-ok').addEventListener('click', cropConfirm);
}

// 既存データの一度きり整形: NDL並列タイトル・姓名間カンマの除去＋表紙URLのバックフィル（2026-07-22フィードバック対応）
async function cleanupLegacyData() {
  const all = await getAllBooks();
  let changed = false;
  for (const b of all) {
    let dirty = false;
    const title = stripParallelTitle(b.title);
    if (title && title !== b.title) { b.title = title; dirty = true; }
    const author = normalizeAuthor(b.author);
    if (author !== b.author) { b.author = author; dirty = true; }
    if (!b.coverUrl && b.isbn) {
      const url = amazonCoverUrl(b.isbn);
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
  sortEl = document.getElementById('sort-select');

  searchEl.addEventListener('input', renderList);

  sortEl.value = sortMode;
  sortEl.addEventListener('change', () => {
    setSortMode(sortEl.value);
    refreshShelf();
  });

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
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file || !detailBook) return;
    const { width, height } = spineStyle(detailBook);
    openCropper(file, { w: width, h: height }, async (blob) => {
      if (!detailBook) return;
      detailBook.spineImage = blob;
      await updateBook(detailBook);
      renderPhotoButtons(detailBook);
      render();
      showToast('📷 背表紙写真を設定しました');
    });
  });
  initCropper();
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

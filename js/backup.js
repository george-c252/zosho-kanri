// バックアップ（書き出し／読み込み）。
// 蔵書データはIndexedDB＝この端末のこのURLの中にしか無い。キャッシュクリア・機種変で消えるため、
// ファイル1個に固めて端末外へ逃がせるようにする。URL引っ越し時の移行手段も兼ねる（仕様外・2026-07-27追加）。
//
// スマホだけで完結させるのが必須要件:
//   書き出し = Web Share API（共有シートからLINE・ドライブへ直接送れる。ダウンロードフォルダを探さなくていい）
//   読み込み = <input type="file">
// 共有が使えない環境ではファイルのダウンロードに落とす。

import { getAllBooks, updateBook, getAllWishlist, putWishlist } from './db.js';
import { refreshShelf, showToast } from './views/shelf.js';

const FORMAT_TAG = 'zosho-kanri-backup';
const FORMAT_VERSION = 1;
const SORT_STORAGE_KEY = 'zosho.shelfSort'; // shelf.js と同じキー（並び順の設定も一緒に持ち運ぶ）

/* ---- Blob ⇄ データURL ----
   背表紙写真(spineImage)はBlobでJSONに入らないため、書き出し時はデータURL文字列に変換する。
   読み込み時は "data:" で始まる文字列をBlobに戻す。 */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

/* ---- 書き出し ---- */

export async function buildBackup() {
  const books = [];
  for (const book of await getAllBooks()) {
    const copy = { ...book };
    if (copy.spineImage instanceof Blob) copy.spineImage = await blobToDataUrl(copy.spineImage);
    books.push(copy);
  }
  return {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    wishlist: await getAllWishlist(),
    prefs: { shelfSort: localStorage.getItem(SORT_STORAGE_KEY) || null },
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 戻り値: 'shared' | 'cancelled' | 'downloaded'（呼び出し側で案内文を出し分ける）
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '蔵書バックアップ' });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // NotAllowedError 等（写真が多くて共有シートを出すまでに時間がかかった場合など）はDLに落とす
    }
  }
  downloadFile(blob, filename);
  return 'downloaded';
}

/* ---- 読み込み ---- */

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// 同じidは上書き、無いものは追加（マージ）。既存の本を消さないので復元前の中身が壊れない。
export async function restoreBackup(data) {
  if (!data || data.format !== FORMAT_TAG) {
    throw new Error('このファイルは蔵書管理のバックアップではありません');
  }
  if (!Array.isArray(data.books)) {
    throw new Error('バックアップの中身が壊れています');
  }
  let restored = 0;
  for (const book of data.books) {
    if (!book || !book.id) continue;
    const copy = { ...book };
    if (typeof copy.spineImage === 'string' && copy.spineImage.startsWith('data:')) {
      copy.spineImage = await dataUrlToBlob(copy.spineImage);
    }
    await updateBook(copy);
    restored += 1;
  }
  for (const entry of data.wishlist || []) {
    if (entry && entry.isbn) await putWishlist(entry);
  }
  if (data.prefs && data.prefs.shelfSort) {
    localStorage.setItem(SORT_STORAGE_KEY, data.prefs.shelfSort);
  }
  return restored;
}

/* ---- 画面 ---- */

const veil = () => document.getElementById('backup-veil');

function setMessage(text, kind) {
  const el = document.getElementById('backup-msg');
  el.textContent = text;
  el.className = `backup-msg ${kind || ''}`;
  el.hidden = !text;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function openSheet() {
  setMessage('');
  const books = await getAllBooks();
  document.getElementById('backup-count').textContent = `いま ${books.length} 冊が入っています`;
  veil().classList.add('open');
}

function closeSheet() {
  veil().classList.remove('open');
}

async function handleExport(btn) {
  btn.disabled = true;
  setMessage('書き出しています…');
  try {
    const data = await buildBackup();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const size = formatSize(blob.size);
    const result = await deliver(blob, `蔵書バックアップ_${stamp()}.json`);
    if (result === 'cancelled') setMessage('書き出しを中止しました', 'warn');
    else if (result === 'shared') setMessage(`${data.books.length}冊（${size}）を書き出しました`, 'ok');
    else setMessage(`${data.books.length}冊（${size}）をこの端末に保存しました`, 'ok');
  } catch (err) {
    // 例外の message をそのまま出さない（読んでも次の一手が分からない・lessons #001）。
    // 原因の切り分けは開発者向けにコンソールへ残す
    console.error('バックアップの書き出しに失敗', err);
    setMessage('書き出せませんでした。少し待ってから、もう一度お試しください。', 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function handleImport(file) {
  setMessage('読み込んでいます…');
  try {
    const text = await readText(file);
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('このファイルは読めません。書き出したバックアップを選んでください');
    }
    const restored = await restoreBackup(data);
    await refreshShelf();
    setMessage(`${restored}冊を読み込みました`, 'ok');
    showToast(`${restored}冊を復元しました`);
  } catch (err) {
    setMessage(err.message, 'warn');
  }
}

export function initBackup() {
  document.getElementById('backup-open').addEventListener('click', openSheet);
  document.getElementById('backup-close').addEventListener('click', closeSheet);
  veil().addEventListener('click', (e) => {
    if (e.target === veil()) closeSheet();
  });

  const exportBtn = document.getElementById('backup-export');
  exportBtn.addEventListener('click', () => handleExport(exportBtn));

  // accept は付けない。iOSのファイル選択でLINE等から保存したjsonが選べなくなるため、
  // 拡張子で弾かず中身で判定する（restoreBackup 側で検証）。
  const fileInput = document.getElementById('backup-file');
  document.getElementById('backup-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 同じファイルを続けて選べるようにする
    if (file) handleImport(file);
  });
}

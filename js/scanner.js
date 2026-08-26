// ZXing UMDビルド（グローバル ZXing）を前提とする。
// EAN-13専用のhintsを渡して誤検出と負荷を減らす（仕様§9）。

const ZX = window.ZXing;

// カメラが起動できなかった理由を分けて持つ（仕様§9）。
// stage: 'unsupported' … このブラウザにカメラAPIが無い
//        'permission'  … カメラを借りられなかった（許可が下りていない・使用中・見つからない）
//        'playback'    … 借りられたが映像が流れ始めない（iOSが自動再生を止めた時に起きる）
// 使う人に出す文言は main.js の cameraErrorMessage() で決める。
export class CameraStartError extends Error {
  constructor(stage, cause) {
    super(`camera start failed: ${stage}`);
    this.name = 'CameraStartError';
    this.stage = stage;
    this.cause = cause || null;
  }
}

// 映像が流れ始めるのを待つ上限。ZXingは video.play() の失敗を console.warn に握りつぶし、
// 再生開始の 'playing' イベントも来ないまま待ち続けるため、例外ではなく時間で判定する
// （@zxing/library 0.21.3 の tryPlayVideo を実読して確認・2026-08-26）。
const PLAY_TIMEOUT_MS = 8000;

// 978/979始まり＋チェックディジット検証（仕様§5.3）。
// 日本の書籍の下段バーコード（192始まり）はここで弾かれる。
export function isValidBookIsbn(text) {
  if (!/^97[89]\d{10}$/.test(text)) return false;
  const digits = [...text].map(Number);
  const sum = digits
    .slice(0, 12)
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

export function createScanner() {
  const hints = new Map();
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13]);
  const reader = new ZX.BrowserMultiFormatReader(hints);
  let stream = null;

  function stopAll() {
    reader.reset();
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  return {
    // videoEl で背面カメラを起動し、有効なISBNを検出するたび onIsbn(isbn) を呼ぶ。
    // 失敗したときは必ず CameraStartError を投げる（理由は .stage に入る）
    async start(videoEl, onIsbn) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new CameraStartError('unsupported');
      }

      // ① カメラを借りる。ここで落ちたら、許可が下りていないか他アプリが使っている
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        });
      } catch (err) {
        stream = null;
        throw new CameraStartError('permission', err);
      }

      // ② 映像を流してデコードを始める。時間切れなら自動再生を止められたとみなす
      let timer = null;
      try {
        await Promise.race([
          reader.decodeFromStream(stream, videoEl, (result) => {
            if (!result) return; // 未検出フレームは毎回来るので無視
            const text = result.getText();
            if (isValidBookIsbn(text)) onIsbn(text);
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new CameraStartError('playback')), PLAY_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        stopAll();
        throw err instanceof CameraStartError ? err : new CameraStartError('playback', err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    stop() {
      stopAll();
    },
  };
}

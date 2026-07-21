// ZXing UMDビルド（グローバル ZXing）を前提とする。
// EAN-13専用のhintsを渡して誤検出と負荷を減らす（仕様§9）。

const ZX = window.ZXing;

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

  return {
    // videoEl で背面カメラを起動し、有効なISBNを検出するたび onIsbn(isbn) を呼ぶ
    async start(videoEl, onIsbn) {
      await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        videoEl,
        (result) => {
          if (!result) return; // 未検出フレームは毎回来るので無視
          const text = result.getText();
          if (isValidBookIsbn(text)) onIsbn(text);
        }
      );
    },
    stop() {
      reader.reset();
    },
  };
}

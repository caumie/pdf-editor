// 画面外のPNGを保持する。取り出した画像のURLは呼び出し側へ管理を移す。
export function createThumbnailCache(byteLimit, revokeUrl) {
  const entries = new Map();
  let bytes = 0;

  function take(card) {
    const image = entries.get(card);
    if (image) {
      entries.delete(card);
      bytes -= image.bytes;
    }
    return image;
  }

  function discard(card) {
    const image = take(card);
    if (image) revokeUrl(image.url);
  }

  function put(card, image) {
    discard(card);
    entries.set(card, image);
    bytes += image.bytes;
    for (const oldest of entries.keys()) {
      if (bytes <= byteLimit) break;
      discard(oldest);
    }
  }

  return { take, discard, put };
}

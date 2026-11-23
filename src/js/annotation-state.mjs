// 画面内の識別子・表示キャッシュを除き、読み込み時と現在の保存内容を比較する。
// キー順やオブジェクトの作り直しでは変更扱いにせず、配列の座標順は保つ。
export function annotationSavedState(annotation) {
  const { id, appearanceKey, appearancePageIndex, originalAppearance, sourceAnnotationRef, ...saved } = annotation;
  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])]));
    }
    return value;
  }
  return JSON.stringify(ordered(saved));
}

// ロックや更新日時は見た目を変えない。元の形やスタイルに戻したときも元APを使う。
export function annotationAppearanceState(annotation) {
  const { locked, pdfFlags, nativeName, createdAt, modifiedAt, ...visual } = annotation;
  return annotationSavedState(visual);
}

export function currentOriginalAppearance(annotation) {
  const appearance = annotation.originalAppearance;
  return appearance && appearance.state === annotationAppearanceState(annotation) ? appearance : null;
}

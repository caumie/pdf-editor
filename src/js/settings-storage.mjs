const editorSettingsPrefix = "pdf-page-editor.";

export function editorSettingKey(name) {
  return editorSettingsPrefix + name;
}

export function clearSavedEditorSettings(storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key?.startsWith(editorSettingsPrefix)) storage.removeItem(key);
  }
}

import { useRef, useState, type ChangeEvent } from "react";
import { MAX_CIRCUIT_DOCUMENT_JSON_LENGTH } from "../circuit-serialization.js";
import type { CircuitEditorController } from "./useCircuitEditor.js";

function downloadJson(json: string, title: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  const name = Array.from(title.trim(), (character) => character.charCodeAt(0) < 32 ? "_" : character)
    .join("").replaceAll(/[\\/:*?"<>|]/g, "_").slice(0, 120);
  link.download = `${name || "circuit"}.json`;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Let the browser begin the download before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Browser file handling is kept outside the headless controller. */
export function useCircuitFiles(editor: CircuitEditorController, onOpen: () => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function save() {
    try {
      downloadJson(editor.exportDocument(), editor.document.title);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回路ファイルを保存できませんでした。");
    }
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) { return; }
    setLoading(true);
    setError(null);
    try {
      // UTF-8 can use up to four bytes per character; the parser also limits characters.
      if (file.size > MAX_CIRCUIT_DOCUMENT_JSON_LENGTH * 4) { throw new Error("回路ファイルが大きすぎます。"); }
      const json = await file.text();
      if (editor.importDocument(json)) { onOpen(); }
    } catch {
      setError("回路ファイルを読み込めませんでした。ファイルのサイズと内容を確認してください。");
    } finally { setLoading(false); }
  }

  function newDocument() {
    editor.newDocument();
    setError(null);
    onOpen();
  }

  return { inputRef, error, loading, save, readFile, newDocument, open: () => inputRef.current?.click() };
}

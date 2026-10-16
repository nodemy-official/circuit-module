import { useCallback, useReducer, useRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect.js";

/** A getter also detects document replacement before a batched render commits. */
export type DocumentGestureVersion = number | (() => number);

export interface DocumentGestureToken {
  documentEpoch: number;
  version: number | undefined;
}

function versionOf(version?: DocumentGestureVersion) {
  return typeof version === "function" ? version() : version;
}

/** Distinguishes a gesture's own pending edits from changes made by its host. */
export function useDocumentGestureBoundary(document: CircuitDocument, documentVersion?: DocumentGestureVersion) {
  const version = versionOf(documentVersion);
  const committed = useRef({ document, version, epoch: 0, documentEpoch: 0 });
  const latestVersion = useRef(documentVersion);
  latestVersion.current = documentVersion;
  const pendingEdit = useRef(false);
  const [editRevision, notifyEdit] = useReducer((value: number) => value + 1, 0);
  const documentChanged = document !== committed.current.document && !pendingEdit.current;
  const documentEpoch = committed.current.documentEpoch + (documentChanged ? 1 : 0);
  const changed = version !== committed.current.version || documentChanged;
  const epoch = committed.current.epoch + (changed ? 1 : 0);

  useIsomorphicLayoutEffect(() => {
    committed.current = { document, version, epoch, documentEpoch };
    pendingEdit.current = false;
  }, [document, version, epoch, documentEpoch, editRevision]);

  const markEdit = useCallback(() => {
    pendingEdit.current = true;
    // Rejected edits also need a commit so the next external change stays external.
    notifyEdit();
  }, []);

  // Starting a gesture may select its target synchronously. Capture after that
  // callback so only subsequent host commands invalidate the new gesture.
  const capture = useCallback((): DocumentGestureToken => ({
    documentEpoch: committed.current.documentEpoch,
    version: versionOf(latestVersion.current),
  }), []);

  const canStart = useCallback(() =>
    versionOf(latestVersion.current) === committed.current.version,
  []);

  const isCurrent = useCallback((gesture: DocumentGestureToken) =>
    gesture.documentEpoch === committed.current.documentEpoch && versionOf(latestVersion.current) === gesture.version,
  []);

  return { epoch, capture, canStart, markEdit, isCurrent };
}

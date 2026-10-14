import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";

/** A getter also detects document replacement before a batched render commits. */
export type DocumentGestureVersion = number | (() => number);

function versionOf(version?: DocumentGestureVersion) {
  return typeof version === "function" ? version() : version;
}

/** Distinguishes a gesture's own pending edits from changes made by its host. */
export function useDocumentGestureBoundary(document: CircuitDocument, documentVersion?: DocumentGestureVersion) {
  const version = versionOf(documentVersion);
  const committed = useRef({ document, version, epoch: 0 });
  const latestVersion = useRef(documentVersion);
  latestVersion.current = documentVersion;
  const pendingEdit = useRef(false);
  const [editRevision, notifyEdit] = useReducer((value: number) => value + 1, 0);
  const changed = version !== committed.current.version ||
    (document !== committed.current.document && !pendingEdit.current);
  const epoch = committed.current.epoch + (changed ? 1 : 0);

  useLayoutEffect(() => {
    committed.current = { document, version, epoch };
    pendingEdit.current = false;
  }, [document, version, epoch, editRevision]);

  const markEdit = useCallback(() => {
    pendingEdit.current = true;
    // Rejected edits also need a commit so the next external change stays external.
    notifyEdit();
  }, []);

  const isCurrent = useCallback((gestureEpoch: number) =>
    gestureEpoch === committed.current.epoch && versionOf(latestVersion.current) === committed.current.version,
  []);

  return { epoch, markEdit, isCurrent };
}

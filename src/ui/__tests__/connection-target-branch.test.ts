import { expect, it } from "vitest";
import { connectToPoint } from "../../circuit-edit.js";
import { routeDocumentWires } from "../../circuit-geometry.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { connectionTargetAt } from "../connection-target.js";

it.each([false, true])("branches at the closest fractional bend without changing the displayed wire (reversed=%s)", (reversed) => {
  const from = { partId: "top", terminal: "a" as const };
  const to = { partId: "bottom", terminal: "a" as const };
  const anchors = [{ x: 0.1, y: 0.51 }, { x: 0.2, y: 0.51 }];
  const document: CircuitDocument = {
    title: "fractional bend",
    parts: [
      { id: "top", kind: "junction", label: "top", x: 0.1, y: -4 },
      { id: "bottom", kind: "junction", label: "bottom", x: 0.2, y: 6 },
      { id: "source", kind: "junction", label: "source", x: -4, y: 2 },
    ],
    wires: [{
      id: "main",
      from: reversed ? to : from,
      to: reversed ? from : to,
      routeAnchors: reversed ? [...anchors].reverse() : anchors,
    }],
  };
  const routes = routeDocumentWires(document);
  const target = connectionTargetAt(document, routes, { x: 0.19, y: 0.51 }, 0.02);
  expect(target).toEqual({ point: { x: 0.2, y: 0.51 }, wireId: "main" });
  const connected = connectToPoint(document, { partId: "source", terminal: "a" }, target.point);
  expect(connected.ok).toBe(true);
  if (!connected.ok) { return; }
  const junction = connected.document.parts.find((part) => !document.parts.some((before) => before.id === part.id));
  expect(junction).toMatchObject({ kind: "junction", x: 0.2, y: 0.51 });
  expect(connected.document.wires).toHaveLength(3);
  expect(connected.document.wires.filter((wire) => wire.from.partId === junction?.id || wire.to.partId === junction?.id)).toHaveLength(3);
  const splitWires = connected.document.wires.filter((wire) => wire.id !== connected.id);
  const nextRoutes = routeDocumentWires(connected.document);
  const joined = [...nextRoutes.get(splitWires[0]!.id)!, ...nextRoutes.get(splitWires[1]!.id)!.slice(1)];
  expect(joined).toEqual(routes.get("main"));
  // Snapping and splitting also leave the host's source document intact.
  expect(routeDocumentWires(document)).toEqual(routes);
});

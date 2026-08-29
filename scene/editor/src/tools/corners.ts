/**
 * The vertex, edge and face tools.
 *
 * One file rather than three, because after `handleDrag.ts` there is nothing left of them but which handle
 * they show and what the undo entry is called — and three files that differ in two lines each are three
 * places to fix the next bug in.
 *
 * The face tool is not the extrude tool. Extrude slides a face along its own normal and is the tool for
 * thickening a wall; this one carries a face's corners wherever the pointer goes, which tilts the walls
 * around it. Both exist in TrenchBroom for the same reason: one keeps the shape and changes a dimension,
 * the other changes the shape.
 */
import { selectEdges, selectFaces, selectVertices, type SelectMode } from "../doc/selection.ts";
import type { Editor } from "../doc/editor.ts";
import type { Handle } from "../render/handles.ts";
import { brushAt, edgeAt, handleDrag, vertexAt } from "./handleDrag.ts";
import type { InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

/** the handle a click landed on, if it is the kind this tool deals in */
const grabbed = (input: InputState, kind: Handle["kind"]): Handle | undefined => {
  const handle = input.hit?.handle;
  return handle?.kind === kind ? handle : undefined;
};

const mode = (input: InputState): SelectMode => (input.mods.shift ? "toggle" : "replace");

function pickVertex(input: InputState, editor: Editor): Outcome | undefined {
  const handle = grabbed(input, "vertex");
  if (!handle) return undefined;
  const brush = brushAt(editor.world, handle.of)?.brush;
  const found = brush && vertexAt(brush, handle.at);
  if (found === undefined) return undefined;
  return {
    set: (e) => ({
      ...e,
      selection: selectVertices(e.selection, [{ node: handle.of, vertex: found }], mode(input)),
    }),
    note: `corner ${found} of ${handle.of}`,
  };
}

function pickEdge(input: InputState, editor: Editor): Outcome | undefined {
  const handle = grabbed(input, "edge");
  if (!handle) return undefined;
  const brush = brushAt(editor.world, handle.of)?.brush;
  const found = brush && edgeAt(brush, handle.at);
  if (!found) return undefined;
  return {
    set: (e) => ({
      ...e,
      selection: selectEdges(e.selection, [{ node: handle.of, a: found[0], b: found[1] }], mode(input)),
    }),
    note: `edge ${found[0]}–${found[1]} of ${handle.of}`,
  };
}

/**
 * A face is picked by its handle or by clicking the face itself, because the face tool is the one place a
 * designer is as likely to be aiming at the wall as at the little square in the middle of it.
 */
function pickFace(input: InputState): Outcome | undefined {
  const handle = grabbed(input, "face");
  const node = handle?.of ?? input.hit?.node;
  const face = handle ? handle.part : input.hit?.face;
  if (!node || face === undefined) return undefined;
  return {
    set: (e) => ({ ...e, selection: selectFaces(e.world, e.selection, [{ node, face }], mode(input)) }),
    note: `face ${face} of ${node}`,
  };
}

export const vertexTool: Tool = {
  id: "vertex",
  title: "vertex",
  key: "y",
  hint: "drag a corner · click picks one · shift adds · alt drags in a standing plane",
  handles: { vertices: true },
  click: pickVertex,
  drag: (input, editor) => handleDrag(input, editor, "vertex", "move corner"),
};

export const edgeTool: Tool = {
  id: "edge",
  title: "edge",
  key: "u",
  hint: "drag an edge · click picks one · shift adds · alt drags in a standing plane",
  handles: { edges: true },
  click: pickEdge,
  drag: (input, editor) => handleDrag(input, editor, "edge", "move edge"),
};

export const faceTool: Tool = {
  id: "face",
  title: "face",
  key: "i",
  hint: "drag a face by its centre · click picks one · shift adds · x extrudes instead",
  handles: { faces: true },
  click: (input) => pickFace(input),
  drag: (input, editor) => handleDrag(input, editor, "face", "move face"),
};

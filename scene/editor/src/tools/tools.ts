/**
 * The tools, in the order the tool bar shows them.
 *
 * A list rather than a registry with registration calls, because the set of tools an editor has is not
 * something that varies at runtime — it is the editor.
 *
 * The order is the order of a working day: pick and place, then draw, then shape, then dress. Keys are
 * chosen for the left hand and are asserted to be distinct in `tools.check.ts`, because two tools that
 * answer to the same key means one of them can never be reached.
 */
import { attributesTool } from "./attributes.ts";
import { clipTool } from "./clip.ts";
import { edgeTool, faceTool, vertexTool } from "./corners.ts";
import { entityTool } from "./entity.ts";
import { extrudeTool } from "./extrude.ts";
import { rotateTool, scaleTool, shearTool } from "./gizmo.ts";
import { moveTool } from "./move.ts";
import { selectTool } from "./select.ts";
import { shapeTool } from "./shape.ts";
import { sweepTool } from "./sweep.ts";
import { ToolBox, type Tool } from "./tool.ts";

export const TOOLS: Tool[] = [
  selectTool, moveTool, rotateTool, scaleTool, shearTool,
  shapeTool, entityTool,
  extrudeTool, sweepTool, clipTool,
  vertexTool, edgeTool, faceTool,
  attributesTool,
];

export const newToolBox = (): ToolBox => new ToolBox(TOOLS, "select");

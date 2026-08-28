/**
 * The tools, in the order the tool bar shows them.
 *
 * A list rather than a registry with registration calls, because the set of tools an editor has is not
 * something that varies at runtime — it is the editor. M9 adds to this line and nothing else changes.
 */
import { entityTool } from "./entity.ts";
import { extrudeTool } from "./extrude.ts";
import { moveTool } from "./move.ts";
import { selectTool } from "./select.ts";
import { shapeTool } from "./shape.ts";
import { ToolBox, type Tool } from "./tool.ts";

export const TOOLS: Tool[] = [selectTool, moveTool, shapeTool, entityTool, extrudeTool];

export const newToolBox = (): ToolBox => new ToolBox(TOOLS, "select");

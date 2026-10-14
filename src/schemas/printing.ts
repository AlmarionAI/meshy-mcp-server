/**
 * Zod schemas for 3D printing tools
 */

import { z } from "zod";
import { PRINTER_BRANDS } from "../constants.js";
import { ResponseFormatSchema, TaskIdSchema, UrlSchema } from "./common.js";

/**
 * Optional wall-thickness check, shared by analyze and repair. Send
 * printer_type, one print size, or both.
 */
const printSizeFields = {
  printer_type: z.enum(["fdm", "sla", "full_color"])
    .optional()
    .describe("Sets the minimum wall: fdm 1.0 mm, sla 0.8 mm, full_color 2.0 mm (fdm when only a size is sent). Without a size: 150 mm tall for GLB / tasks, an STL's own size, else 150 mm longest side."),
  intended_print_height_mm: z.number()
    .min(1).max(1000)
    .optional()
    .describe("Print height in mm (1–1000); GLB / input_task_id only. At most one print size."),
  intended_print_longest_side_mm: z.number()
    .min(1).max(1000)
    .optional()
    .describe("Print's longest side in mm (1–1000); any format. At most one print size.")
};

export function checkPrintSize(params: { intended_print_height_mm?: number; intended_print_longest_side_mm?: number }): string | null {
  return params.intended_print_height_mm !== undefined && params.intended_print_longest_side_mm !== undefined
    ? "Error: send at most one of intended_print_height_mm and intended_print_longest_side_mm."
    : null;
}

/**
 * Send to slicer input schema (cross-platform 7-slicer detection).
 */
export const SendToSlicerInputSchema = z.object({
  model_url: UrlSchema
    .describe("The model's URL (a placeholder is fine when only detecting)"),
  slicer_type: z.enum([
    "auto",
    "bambu",
    "orcaslicer",
    "creality_print",
    "elegoo_slicer",
    "anycubic_slicer",
    "prusaslicer",
    "cura"
  ])
    .default("auto")
    .describe("'auto' (default): detect all and recommend one; or one slicer."),
  file_name: z.string()
    .default("meshy_model.3mf")
    .describe("File name for the model"),
  is_multicolor: z.boolean()
    .default(false)
    .describe("Only multicolor-capable slicers"),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Analyze-printability input schema — POST /openapi/v1/print/analyze. FREE.
 *
 * Provide input_task_id or model_url; input_task_id wins when both are given.
 *
 * input_task_id: a SUCCEEDED image-to-3d, multi-image-to-3d, text-to-3d, remesh
 * or retexture task on Meshy 6 or newer, or a print-repair task.
 */
export const AnalyzePrintabilityInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("A SUCCEEDED text-to-3d, image-to-3d, multi-image-to-3d, remesh or retexture task on Meshy 6 or newer, or a print-repair task. Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a .glb / .gltf / .obj / .fbx / .stl model (max 400 MB), or a GLB data URI (max 100 MB)."),
  ...printSizeFields,
  response_format: ResponseFormatSchema
}).strict();

/**
 * Repair-printability input schema — POST /openapi/v1/print/repair (10 credits).
 * Output format matches the input format; for input_task_id the output is GLB.
 */
export const RepairPrintabilityInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("A SUCCEEDED text-to-3d, image-to-3d, multi-image-to-3d, remesh or retexture task, or a print-analyze task (which passes on its printer and size). Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a .glb / .gltf / .obj / .fbx / .stl model (max 400 MB), or a GLB data URI (max 100 MB)."),
  ...printSizeFields,
  alpha_thumbnail: z.boolean()
    .optional()
    .describe("Also return a transparent-background preview (alpha_thumbnail_url)."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Process-multicolor input schema — POST /openapi/v1/print/multi-color (10 credits).
 * The input model MUST have textures.
 */
export const ProcessMulticolorInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("A SUCCEEDED textured task: image-to-3d / multi-image-to-3d (unless should_texture was false), refined text-to-3d, remesh or retexture. Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a textured .glb / .fbx, or a GLB data URI."),
  max_colors: z.number()
    .int()
    .min(1, "Minimum 1 color")
    .max(16, "Maximum 16 colors")
    .default(4)
    .describe("Palette size (1–16); match the printer's AMS/MMU capacity."),
  max_depth: z.number()
    .int()
    .min(3, "Minimum depth 3")
    .max(6, "Maximum depth 6")
    .default(4)
    .describe("3–6: higher = finer color boundaries, larger file (realistic only)."),
  style: z.enum(["realistic", "cartoon"])
    .optional()
    .describe("'realistic' (default): photo-like detail, larger file, needs one base color texture with UVs on every part. 'cartoon': flat regions, smaller file, also takes vertex colors."),
  printer_brand: z.enum(PRINTER_BRANDS)
    .optional()
    .describe("Brand whose slicer preset (default printer, 0.4 mm nozzle) goes into the 3MF (default bambu)."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Auto Split input schema — POST /openapi/v1/print/split (10 credits).
 */
export const AutoSplitInputSchema = z.object({
  input_task_id: TaskIdSchema
    .describe("A SUCCEEDED image-to-3d, multi-image-to-3d, text-to-3d preview, remesh, convert or resize task made with meshy-6, meshy-7, meshy-7.1 or latest (not low-poly or Smart Topology)."),
  mode: z.enum(["auto", "by_parts", "by_color"])
    .optional()
    .describe("'auto' (default; Meshy picks the cuts), 'by_parts' (the parts named in prompt), or 'by_color' (the color regions named in prompt; image-to-3d / multi-image-to-3d sources only)."),
  prompt: z.string()
    .min(1)
    .max(600)
    .optional()
    .describe("Required for by_parts / by_color: name 1–10 parts, e.g. 'head, torso, arms, legs'; the rest becomes one more part. If unreadable, the task falls back to auto, still charges, and reports prompt_ignored."),
  target_formats: z.array(z.enum(["glb", "obj", "fbx", "stl", "usdz", "blend", "3mf"]))
    .optional()
    .describe("Extra formats (glb is always made). 3mf gives separately selectable parts in a slicer; stl fuses them into one solid."),
  layout: z.enum(["assembled", "on_plate"])
    .optional()
    .describe("'assembled' (default) or 'on_plate' (parts laid flat, ready to slice)."),
  connectors: z.boolean()
    .optional()
    .describe("Add mortise-and-tenon connectors at each cut so the parts fit together."),
  connector_type: z.enum(["cube", "cylinder"])
    .optional()
    .describe("Connector shape (default cube)."),
  connector_size: z.number()
    .min(0.1).max(0.8)
    .optional()
    .describe("Relative to the cut surface (default 0.5)."),
  connector_height: z.number()
    .min(0.1).max(0.8)
    .optional()
    .describe("Relative extension from the cut (default 0.1)."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * The model source to send: input_task_id when given (the API ignores model_url
 * then, so it is not sent), else model_url. Null when neither is given.
 */
export function printSource(
  params: { input_task_id?: string; model_url?: string }
): { input_task_id: string } | { model_url: string } | null {
  if (params.input_task_id) return { input_task_id: params.input_task_id };
  if (params.model_url) return { model_url: params.model_url };
  return null;
}

export const MISSING_PRINT_SOURCE = "Error: provide input_task_id or model_url.";

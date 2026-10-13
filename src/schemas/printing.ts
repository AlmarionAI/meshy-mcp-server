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
    .describe("Printer you plan to use; sets the minimum wall for the wall-thickness check: fdm 1.0 mm, sla 0.8 mm, full_color 2.0 mm. Defaults to fdm when only a print size is sent."),
  intended_print_height_mm: z.number()
    .min(1).max(1000)
    .optional()
    .describe("Print height in mm (1–1000). GLB input only (any input_task_id counts as GLB). Send at most one print size."),
  intended_print_longest_side_mm: z.number()
    .min(1).max(1000)
    .optional()
    .describe("Length of the print's longest side in mm (1–1000). Works with every input format. Send at most one print size.")
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
    .describe("Download URL of the model file to send to slicer (can be a placeholder when only running detection)"),
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
    .describe("Target slicer. 'auto' (default) detects all installed slicers and recommends the best one. Specify a value to target a particular slicer."),
  file_name: z.string()
    .default("meshy_model.3mf")
    .describe("File name for the model (default: meshy_model.3mf)"),
  is_multicolor: z.boolean()
    .default(false)
    .describe("If true, only recommends multicolor-capable slicers (OrcaSlicer, Bambu Studio, Creality Print, Elegoo Slicer, Anycubic Slicer Next, PrusaSlicer)"),
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
    .describe("ID of a SUCCEEDED task to analyze: text-to-3d, image-to-3d, multi-image-to-3d, remesh or retexture on Meshy 6 or newer (Meshy 7 / 7.1 included), or a print-repair task. Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a 3D model to analyze (.glb / .gltf / .obj / .fbx / .stl, max 100 MB), or a GLB data URI. Ignored when input_task_id is given."),
  ...printSizeFields,
  response_format: ResponseFormatSchema
}).strict();

/**
 * Repair-printability input schema — POST /openapi/v1/print/repair (10 credits).
 * Output format matches the input format; for input_task_id the output is GLB.
 */
export const RepairPrintabilityInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("ID of a SUCCEEDED task with a GLB: text-to-3d, image-to-3d, multi-image-to-3d, remesh, retexture, or a print-analyze task (an analyze task that checked wall thickness passes on its printer and size). Output will be GLB. Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a 3D model to repair (.glb / .stl / .obj / .fbx / .gltf, max 100 MB), or a GLB data URI. Output matches the input format. Ignored when input_task_id is given."),
  ...printSizeFields,
  alpha_thumbnail: z.boolean()
    .optional()
    .describe("Also render a transparent-background (RGBA) preview, returned as alpha_thumbnail_url. Default false."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Process-multicolor input schema — POST /openapi/v1/print/multi-color (10 credits).
 * The input model MUST have textures.
 */
export const ProcessMulticolorInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("ID of a SUCCEEDED textured task: image-to-3d / multi-image-to-3d (textured unless should_texture was false), refined text-to-3d, remesh or retexture. Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a textured 3D model (.glb / .fbx), or a GLB data URI. Ignored when input_task_id is given."),
  max_colors: z.number()
    .int()
    .min(1, "Minimum 1 color")
    .max(16, "Maximum 16 colors")
    .default(4)
    .describe("Maximum number of colors in the output palette (1-16, default: 4). Match this to the user's printer AMS/MMU capability."),
  max_depth: z.number()
    .int()
    .min(3, "Minimum depth 3")
    .max(6, "Maximum depth 6")
    .default(4)
    .describe("Quadtree depth for color precision (3-6, default: 4). Higher = finer color boundaries but larger file. realistic style only."),
  style: z.enum(["realistic", "cartoon"])
    .optional()
    .describe("Color style: 'realistic' (API default; samples the texture for photo-like detail, larger file, needs one base color texture with UVs on every part) or 'cartoon' (flat uniform color regions, smaller file, also accepts vertex colors)."),
  printer_brand: z.enum(PRINTER_BRANDS)
    .optional()
    .describe("Printer brand whose slicer preset (default printer, 0.4 mm nozzle) is written into the 3MF: bambu (API default), anycubic, creality, elegoo, flashforge, prusa, qidi, snapmaker, ankermake."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Auto Split input schema — POST /openapi/v1/print/split (10 credits).
 */
export const AutoSplitInputSchema = z.object({
  input_task_id: TaskIdSchema
    .describe("ID of a SUCCEEDED image-to-3d, multi-image-to-3d, text-to-3d preview, remesh, convert or resize task whose model was made with meshy-6, meshy-7, meshy-7.1 or latest. Low-poly and Smart Topology (meshy-t2) models are not supported. A textured model is accepted; its texture is not carried into the result."),
  mode: z.enum(["auto", "by_parts", "by_color"])
    .optional()
    .describe("How to cut: 'auto' (API default; Meshy picks the cuts), 'by_parts' (the structural parts named in prompt), or 'by_color' (the color regions named in prompt; only for image-to-3d / multi-image-to-3d inputs)."),
  prompt: z.string()
    .min(1)
    .max(600)
    .optional()
    .describe("Required for by_parts / by_color: name 1–10 parts, e.g. 'head, torso, left arm, right arm, legs' or 'the figure and the base'. Anything not named becomes one remaining part. Max 600 characters. Ignored in auto mode."),
  target_formats: z.array(z.enum(["glb", "obj", "fbx", "stl", "usdz", "blend", "3mf"]))
    .optional()
    .describe("Extra export formats (glb is always produced). glb/obj/fbx/usdz/blend/3mf keep each part as its own object; stl fuses the parts into one solid. Use 3mf for separately selectable parts in a slicer."),
  layout: z.enum(["assembled", "on_plate"])
    .optional()
    .describe("'assembled' (API default; parts stay in place) or 'on_plate' (parts laid flat and spread out, ready to slice)."),
  connectors: z.boolean()
    .optional()
    .describe("Add mortise-and-tenon connectors at each cut so the printed parts fit together. Default false."),
  connector_type: z.enum(["cube", "cylinder"])
    .optional()
    .describe("Connector shape when connectors is true (API default cube)."),
  connector_size: z.number()
    .min(0.1).max(0.8)
    .optional()
    .describe("Connector size relative to the cut surface, 0.1–0.8 (API default 0.5)."),
  connector_height: z.number()
    .min(0.1).max(0.8)
    .optional()
    .describe("How far the connector extends from the cut surface, relative to it, 0.1–0.8 (API default 0.1)."),
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

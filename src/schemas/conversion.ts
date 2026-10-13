/**
 * Zod schemas for standalone post-processing tools: convert, resize, uv-unwrap.
 *
 * All three take input_task_id or model_url; input_task_id wins when both are
 * given (see printSource in ./printing.js).
 */

import { z } from "zod";
import { ConvertFormat, OriginAt } from "../constants.js";
import { ResponseFormatSchema, TaskIdSchema, UrlSchema } from "./common.js";

/**
 * Convert input schema — POST /openapi/v1/convert (1 credit).
 * Cheaper, dedicated format conversion (vs. remesh). target_formats is required.
 */
export const ConvertInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("ID of a SUCCEEDED Meshy task whose model to convert. Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a 3D model (.glb / .gltf / .obj / .fbx / .stl), or a GLB data URI. Ignored when input_task_id is given."),
  target_formats: z.array(z.nativeEnum(ConvertFormat))
    .min(1, "At least one target format is required")
    .describe("Output formats (required). Options: glb, fbx, obj, usdz, blend, stl, 3mf."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Resize input schema — POST /openapi/v1/resize (1 credit).
 * Exactly one resize mode (resize_height / resize_longest_side / auto_size) is required.
 */
export const ResizeInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("ID of a SUCCEEDED Meshy task whose model to resize (output is GLB). Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a 3D model (.glb / .gltf / .obj / .fbx / .stl), or a GLB data URI; output preserves the input format. Ignored when input_task_id is given."),
  resize_height: z.number()
    .positive()
    .optional()
    .describe("Resize to this exact height in meters. Mutually exclusive with resize_longest_side / auto_size."),
  resize_longest_side: z.number()
    .positive()
    .optional()
    .describe("Resize so the longest side matches this value in meters (aspect ratio preserved). Mutually exclusive with resize_height / auto_size."),
  auto_size: z.boolean()
    .optional()
    .describe("Use AI vision to estimate the real-world height and resize accordingly. Mutually exclusive with resize_height / resize_longest_side."),
  origin_at: z.nativeEnum(OriginAt)
    .optional()
    .describe("Origin placement after resizing: 'bottom' (default) or 'center'."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * UV Unwrap input schema — POST /openapi/v1/uv-unwrap (5 credits).
 * GLB only; meshes over 40,000 faces are rejected with 400 (remesh first).
 */
export const UvUnwrapInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("ID of a SUCCEEDED Meshy task that produced a GLB (≤40,000 faces). Takes priority over model_url when both are given."),
  model_url: UrlSchema.optional()
    .describe("Public URL or data URI of a .glb model (≤40,000 faces). ONLY .glb is supported — convert other formats first. Ignored when input_task_id is given."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Runtime check for resize: exactly one resize mode must be present.
 * Returns null if valid, or an error message if not.
 */
export function validateExactlyOneResizeMode(
  params: { resize_height?: number; resize_longest_side?: number; auto_size?: boolean }
): string | null {
  const modes = [
    params.resize_height !== undefined,
    params.resize_longest_side !== undefined,
    Boolean(params.auto_size)
  ].filter(Boolean).length;
  if (modes !== 1) {
    return "Provide exactly one resize mode: resize_height, resize_longest_side, or auto_size.";
  }
  return null;
}

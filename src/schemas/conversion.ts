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
    .describe("A SUCCEEDED task with a model. Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a .glb / .gltf / .obj / .fbx / .stl model (max 400 MB), or a GLB data URI (max 100 MB)."),
  target_formats: z.array(z.nativeEnum(ConvertFormat))
    .min(1, "At least one target format is required")
    .describe("Formats to produce"),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Resize input schema — POST /openapi/v1/resize (1 credit).
 * Exactly one resize mode (resize_height / resize_longest_side / auto_size) is required.
 */
export const ResizeInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("A SUCCEEDED task with a model (output GLB). Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL of a .glb / .gltf / .obj / .fbx / .stl model (output keeps its format), or a GLB data URI."),
  resize_height: z.number()
    .positive()
    .optional()
    .describe("Height in meters"),
  resize_longest_side: z.number()
    .positive()
    .optional()
    .describe("Longest side in meters (aspect ratio kept)"),
  auto_size: z.boolean()
    .optional()
    .describe("AI-estimate the real-world height"),
  origin_at: z.nativeEnum(OriginAt)
    .optional()
    .describe("'bottom' (default) or 'center'"),
  response_format: ResponseFormatSchema
}).strict();

/**
 * UV Unwrap input schema — POST /openapi/v1/uv-unwrap (5 credits).
 * GLB only; meshes over 40,000 faces are rejected with 400 (remesh first).
 */
export const UvUnwrapInputSchema = z.object({
  input_task_id: TaskIdSchema.optional()
    .describe("A SUCCEEDED task with a GLB. Wins over model_url."),
  model_url: UrlSchema.optional()
    .describe("Public URL or data URI of a .glb (convert other formats first)."),
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

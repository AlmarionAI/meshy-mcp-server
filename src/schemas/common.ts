/**
 * Common Zod schemas shared across tools
 */

import { z } from "zod";
import { ResponseFormat, TaskType } from "../constants.js";
import { toTaskType } from "../utils/endpoints.js";

/**
 * Response format schema
 */
export const ResponseFormatSchema = z.nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

/**
 * Pagination schema
 */
export const PaginationSchema = z.object({
  limit: z.number()
    .int()
    .min(1, "Limit must be at least 1")
    .max(100, "Limit cannot exceed 100")
    .default(20)
    .describe("Maximum number of results to return"),
  offset: z.number()
    .int()
    .min(0, "Offset cannot be negative")
    .default(0)
    .describe("Number of results to skip for pagination")
});

/**
 * Task ID schema
 */
export const TaskIdSchema = z.string()
  .min(1, "Task ID is required")
  .describe("Unique task identifier (UUID)");

/**
 * URL schema
 */
export const UrlSchema = z.string()
  .url("Must be a valid URL")
  .describe("Publicly accessible URL");

/**
 * Prompt schema for the image endpoints, which set no length limit.
 */
export const PromptSchema = z.string()
  .min(1, "Prompt is required")
  .describe("Text description");

/**
 * Task type schema. Optional: when it is omitted, unrecognized or wrong, the
 * server finds the task on the other routes and uses the task's own type.
 * The API's own spellings (rig, animate, print-multi-color, text-to-3d-preview)
 * are accepted too.
 */
export const TaskTypeSchema = z.preprocess(
  value => toTaskType(value),
  z.nativeEnum(TaskType).optional()
).describe("Task type for endpoint routing, e.g. 'text-to-3d', 'image-to-3d', 'multi-image-to-3d', 'remesh', 'retexture', 'rigging', 'animation', 'text-to-image', 'image-to-image', 'convert', 'resize', 'uv-unwrap', 'multi-color-print', 'print-analyze', 'print-repair'. Creative Lab is STAGE-specific: 'creative-lab-{product}-prototype' or 'creative-lab-{product}-build'. Optional: if omitted, unrecognized or wrong, the server finds the task on the other endpoints and reports its actual type, so never fall back to manual HTTP.");

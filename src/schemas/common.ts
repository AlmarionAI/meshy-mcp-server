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
  .describe("markdown (default) or json");

/**
 * Pagination schema
 */
export const PaginationSchema = z.object({
  limit: z.number()
    .int()
    .min(1, "Limit must be at least 1")
    .max(100, "Limit cannot exceed 100")
    .default(20)
    .describe("Results per page, 1–100"),
  offset: z.number()
    .int()
    .min(0, "Offset cannot be negative")
    .default(0)
    .describe("Results to skip")
});

/**
 * Task ID schema
 */
export const TaskIdSchema = z.string()
  .min(1, "Task ID is required")
  .describe("Task ID");

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
).describe("Optional: if omitted or wrong, the server finds the task and reports its real type.");

/**
 * Task type filter for listing: takes the same names, API spellings included,
 * but an unknown value is rejected instead of silently listing every type.
 */
export const TaskTypeFilterSchema = z.preprocess(
  value => toTaskType(value) ?? value,
  z.nativeEnum(TaskType).optional()
).describe("Only this task type (same names as meshy_get_task_status). Omit to query every type and merge the results.");

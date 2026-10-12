/**
 * Zod schema for balance tool
 */

import { z } from "zod";
import { ResponseFormatSchema } from "./common.js";

export const CheckBalanceInputSchema = z.object({
  response_format: ResponseFormatSchema
}).strict();

/** Endpoint names the usage records carry (and the `endpoints` filter takes). */
export const USAGE_ENDPOINTS = [
  "text-to-3d", "text-to-3d-preview", "text-to-3d-refine", "image-to-3d", "multi-image-to-3d",
  "retexture", "remesh", "convert", "resize", "uv-unwrap", "rig", "animate", "text-to-motion",
  "text-to-image", "image-to-image", "print-multi-color", "print-repair", "print-analyze", "print-split"
] as const;

export const ListUsageInputSchema = z.object({
  page_num: z.number().int().min(1).max(255).default(1)
    .describe("Page number (default 1)"),
  page_size: z.number().int().min(1).max(100).default(20)
    .describe("Records per page, 1–100 (default 20)"),
  sort_by: z.enum(["-created_at", "+created_at"]).default("-created_at")
    .describe("'-created_at' newest first (default) or '+created_at' oldest first"),
  start_time: z.string().optional()
    .describe("Start of the created_at window, RFC 3339 (e.g. '2026-08-01T00:00:00Z'). Defaults to 30 days before end_time; the window may span at most 1 year."),
  end_time: z.string().optional()
    .describe("End of the created_at window, RFC 3339. Defaults to now."),
  endpoints: z.array(z.enum(USAGE_ENDPOINTS)).min(1).optional()
    .describe("Only these endpoints ('text-to-3d' covers preview and refine). Omit for all."),
  status: z.enum(["SUCCEEDED", "FAILED"]).optional()
    .describe("Only tasks with this final status. Omit for both."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Standalone post-processing tools: convert, resize, uv-unwrap.
 *
 *   - POST /openapi/v1/convert    — 1 credit, format conversion (cheaper than remesh)
 *   - POST /openapi/v1/resize     — 1 credit, real-world resizing
 *   - POST /openapi/v1/uv-unwrap  — 5 credits, fresh UV layout (GLB only, ≤40k faces)
 *
 * All three take input_task_id or model_url; input_task_id wins when both are given.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshyClient } from "../services/meshy-client.js";
import { handleMeshyError } from "../services/error-handler.js";
import {
  ConvertInputSchema,
  ResizeInputSchema,
  UvUnwrapInputSchema,
  validateExactlyOneResizeMode
} from "../schemas/conversion.js";
import { printSource, MISSING_PRINT_SOURCE } from "../schemas/printing.js";
import { TaskCreatedOutputSchema } from "../schemas/output.js";
import { ResponseFormat } from "../constants.js";
import {
  CreateTaskApiResponse,
  ConvertApiRequest,
  ResizeApiRequest,
  UvUnwrapApiRequest
} from "../types.js";
import { formatTaskCreatedResponse } from "../utils/response-formatter.js";

/**
 * Register conversion / resize / uv-unwrap tools with the MCP server
 */
export function registerConversionTools(server: McpServer, client: MeshyClient) {
  // ── Convert ─────────────────────────────────────────────────────────
  server.registerTool(
    "meshy_convert",
    {
      title: "Convert 3D Model Format",
      description: `Convert a model to other file formats. Cost: 1 credit (cheaper than remesh for a format-only change).

Example: { input_task_id: "abc-123", target_formats: ["stl", "3mf"] }`,
      inputSchema: ConvertInputSchema,
      outputSchema: TaskCreatedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof ConvertInputSchema>) => {
      const source = printSource(params);
      if (!source) {
        return { isError: true, content: [{ type: "text", text: MISSING_PRINT_SOURCE }] };
      }
      try {
        const request: ConvertApiRequest = { ...source, target_formats: params.target_formats };

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/convert",
          request as unknown as Record<string, unknown>
        );
        const taskId = response.result;
        const sourceDesc = params.input_task_id ? `task "${params.input_task_id}"` : "model URL";

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Convert task created for ${sourceDesc} → ${params.target_formats.join(", ")}. Cost: 1 credit.`,
            estimated_time: "10-30 seconds"
          },
          params.response_format as ResponseFormat,
          "Convert Task Created",
          `Converting ${sourceDesc} to: ${params.target_formats.join(", ")}.`,
          "convert"
        );
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleMeshyError(error, { tool: "meshy_convert" }) }] };
      }
    }
  );

  // ── Resize ──────────────────────────────────────────────────────────
  server.registerTool(
    "meshy_resize",
    {
      title: "Resize 3D Model to Real-World Dimensions",
      description: `Rescale a model to real-world size on Meshy. Cost: 1 credit. Give exactly one of resize_height, resize_longest_side or auto_size.

Later tasks (e.g. Auto Split) use the new size. To only scale a downloaded OBJ for a slicer, meshy_download_model with print_ready + print_height_mm does it locally for free.

Example (5 cm figurine): { input_task_id: "abc-123", resize_height: 0.05 }`,
      inputSchema: ResizeInputSchema,
      outputSchema: TaskCreatedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof ResizeInputSchema>) => {
      const source = printSource(params);
      if (!source) {
        return { isError: true, content: [{ type: "text", text: MISSING_PRINT_SOURCE }] };
      }
      const modeError = validateExactlyOneResizeMode(params);
      if (modeError) {
        return { isError: true, content: [{ type: "text", text: modeError }] };
      }
      try {
        const request: ResizeApiRequest = { ...source };
        if (params.resize_height !== undefined) request.resize_height = params.resize_height;
        if (params.resize_longest_side !== undefined) request.resize_longest_side = params.resize_longest_side;
        if (params.auto_size !== undefined) request.auto_size = params.auto_size;
        if (params.origin_at) request.origin_at = params.origin_at;

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/resize",
          request as unknown as Record<string, unknown>
        );
        const taskId = response.result;
        const sourceDesc = params.input_task_id ? `task "${params.input_task_id}"` : "model URL";
        const modeDesc = params.auto_size
          ? "auto-estimated size"
          : params.resize_height !== undefined
            ? `${params.resize_height} m tall`
            : `${params.resize_longest_side} m longest side`;

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Resize task created for ${sourceDesc} (${modeDesc}). Cost: 1 credit.`,
            estimated_time: "10-30 seconds"
          },
          params.response_format as ResponseFormat,
          "Resize Task Created",
          `Resizing ${sourceDesc} to ${modeDesc}.`,
          "resize"
        );
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleMeshyError(error, { tool: "meshy_resize" }) }] };
      }
    }
  );

  // ── UV Unwrap ───────────────────────────────────────────────────────
  server.registerTool(
    "meshy_uv_unwrap",
    {
      title: "Generate UV Unwrap for a 3D Model",
      description: `Make a clean, non-overlapping UV layout ("UV white model") before texturing in Blender, Substance Painter or Unreal. Cost: 5 credits.

GLB input only, ≤40,000 faces (denser meshes are rejected: remesh first). The output GLB keeps the geometry (quads/n-gons triangulated) with fresh UVs and a grey placeholder material.`,
      inputSchema: UvUnwrapInputSchema,
      outputSchema: TaskCreatedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof UvUnwrapInputSchema>) => {
      const source = printSource(params);
      if (!source) {
        return { isError: true, content: [{ type: "text", text: MISSING_PRINT_SOURCE }] };
      }
      try {
        const request: UvUnwrapApiRequest = { ...source };

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/uv-unwrap",
          request as unknown as Record<string, unknown>
        );
        const taskId = response.result;
        const sourceDesc = params.input_task_id ? `task "${params.input_task_id}"` : "model URL";

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `UV Unwrap task created for ${sourceDesc}. Cost: 5 credits.`,
            estimated_time: "~2 minutes"
          },
          params.response_format as ResponseFormat,
          "UV Unwrap Task Created",
          `Generating a fresh UV layout for ${sourceDesc}. Output is a single GLB UV white model.`,
          "uv-unwrap"
        );
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleMeshyError(error, { tool: "meshy_uv_unwrap" }) }] };
      }
    }
  );
}

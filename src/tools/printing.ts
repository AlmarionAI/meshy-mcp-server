/**
 * 3D printing tools — slicer detection, printability analysis, model repair, multicolor processing.
 *
 * Wires up real Meshy print API endpoints:
 *   - POST /openapi/v1/print/analyze   — free printability check
 *   - POST /openapi/v1/print/repair    — 10 credits, fixes topology issues
 *   - POST /openapi/v1/print/multi-color — 10 credits, outputs multicolor 3MF
 *
 * Slicer detection scans the local filesystem for 7 supported slicers and
 * returns launch commands; the agent (not this server) executes them.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshyClient } from "../services/meshy-client.js";
import { handleMeshyError } from "../services/error-handler.js";
import {
  SendToSlicerInputSchema,
  AnalyzePrintabilityInputSchema,
  RepairPrintabilityInputSchema,
  ProcessMulticolorInputSchema,
  AutoSplitInputSchema,
  printSource,
  checkPrintSize,
  MISSING_PRINT_SOURCE
} from "../schemas/printing.js";
import { TaskCreatedOutputSchema } from "../schemas/output.js";
import { AUTO_SPLIT_CREDITS, ResponseFormat, SlicerType } from "../constants.js";
import { CreateTaskApiResponse } from "../types.js";
import { formatTaskCreatedResponse } from "../utils/response-formatter.js";
import { buildApiRequest } from "../utils/request-builder.js";
import {
  detectInstalledSlicers,
  detectSlicer,
  getBestMulticolorSlicer,
  DetectedSlicer
} from "../utils/slicer-detector.js";

/**
 * Build Bambu Studio URL scheme (kept for backward compat).
 */
function buildBambuStudioUrl(modelUrl: string, fileName: string): string {
  const urlWithFragment = `${modelUrl}#/${fileName}`;
  const isMac = process.platform === "darwin";
  if (isMac) {
    return `bambustudioopen://${encodeURIComponent(urlWithFragment)}`;
  }
  return `bambustudio://open?file=${encodeURIComponent(urlWithFragment)}`;
}

/** Format detected slicers into a markdown table. */
function formatSlicerTable(slicers: DetectedSlicer[]): string {
  if (slicers.length === 0) return "No slicers detected.";
  const rows = slicers.map(s =>
    `| ${s.displayName} | ${s.supportsMulticolor ? "Yes" : "No"} | \`${s.path}\` |`
  );
  return `| Slicer | Multicolor | Path |
|--------|-----------|------|
${rows.join("\n")}`;
}

/**
 * Register 3D printing tools with the MCP server
 */
export function registerPrintingTools(server: McpServer, client: MeshyClient) {
  // ── Send to Slicer ──────────────────────────────────────────────
  server.registerTool(
    "meshy_send_to_slicer",
    {
      title: "Send Model to 3D Printing Slicer",
      description: `Detect installed 3D printing slicers and return their launch commands. Call it at the START of a print workflow and keep the result; at the END, replace {file} in a launch_command with the downloaded file's local path and run it. If you cannot run shell commands, give the user the command and the file path.

Detects OrcaSlicer, Bambu Studio, Creality Print, Elegoo Slicer, Anycubic Slicer Next, PrusaSlicer (all multicolor-capable) and UltiMaker Cura.

Several SEPARATE models: open them one at a time, ~2 s apart (\`open -a "Bambu Studio" a.stl; sleep 2; open -a "Bambu Studio" b.stl\`); fired together, a slicer may take only one. Parts of one model go in one project, opened together.`,
      inputSchema: SendToSlicerInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (params: z.infer<typeof SendToSlicerInputSchema>) => {
      try {
        let detected: DetectedSlicer[] = [];
        if (params.slicer_type === "auto") {
          detected = detectInstalledSlicers();
        } else {
          const specific = detectSlicer(params.slicer_type as SlicerType);
          if (specific) detected = [specific];
        }

        if (params.is_multicolor) {
          detected = detected.filter(s => s.supportsMulticolor);
        }

        const recommended = params.is_multicolor
          ? getBestMulticolorSlicer(detected)
          : (detected[0] || null);

        const slicerList = detected.map(s => ({
          name: s.displayName,
          type: s.type,
          path: s.path,
          supports_multicolor: s.supportsMulticolor,
          launch_command: s.launchCommand.replace("{file}", params.model_url),
          url_scheme: s.urlScheme
        }));

        const recommendedOutput = recommended ? {
          name: recommended.displayName,
          type: recommended.type,
          launch_command: recommended.launchCommand.replace("{file}", params.model_url),
          supports_multicolor: recommended.supportsMulticolor
        } : null;

        const bambuSlicer = detected.find(s => s.type === SlicerType.BAMBU);
        const bambuUrlScheme = bambuSlicer
          ? buildBambuStudioUrl(params.model_url, params.file_name)
          : undefined;

        const output = {
          detected_slicers: slicerList,
          recommended_slicer: recommendedOutput,
          model_url: params.model_url,
          file_name: params.file_name,
          bambu_url_scheme: bambuUrlScheme,
          is_multicolor: params.is_multicolor
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          if (detected.length === 0) {
            const slicerSuggestions = params.is_multicolor
              ? "OrcaSlicer, Bambu Studio, Creality Print, Elegoo Slicer, Anycubic Slicer Next, or PrusaSlicer"
              : "OrcaSlicer, Bambu Studio, PrusaSlicer, UltiMaker Cura, or others";
            textContent = `# No Slicer Detected

No ${params.is_multicolor ? "multicolor-capable " : ""}slicer software was found on this system.

**Recommended slicers to install**: ${slicerSuggestions}

**Manual steps**:
1. Download the model from: ${params.model_url}
2. Install a slicer from the list above
3. Open the downloaded file in the slicer: File → Import → select the file`;
          } else {
            const launchCmd = recommendedOutput?.launch_command || "";
            textContent = `# Slicer Detection Result

## Detected Slicers

${formatSlicerTable(detected)}

## Recommended: ${recommendedOutput?.name || "None"}

**Launch command** (execute via Bash):
\`\`\`
${launchCmd}
\`\`\`

**Model URL**: ${params.model_url}
**File Name**: ${params.file_name}${bambuUrlScheme ? `\n\n**Bambu Studio URL Scheme**:\n\`\`\`\n${bambuUrlScheme}\n\`\`\`` : ""}

**Reminders**:
- Execute the launch command above to open the model in the slicer
- Check print settings (layer height, infill, supports) in the slicer before printing
- A Meshy download URL stops working at its task's expires_at (3 days after the task finishes); download the file first`;
          }
        } else {
          textContent = JSON.stringify(output, null, 2);
        }

        return {
          content: [{ type: "text", text: textContent }],
          structuredContent: output
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error) }]
        };
      }
    }
  );

  // ── Analyze Printability ────────────────────────────────────────
  server.registerTool(
    "meshy_analyze_printability",
    {
      title: "Analyze Model Printability",
      description: `Check whether a model is printable: watertightness, non-manifold edges, holes, degenerate faces and volume — plus thin walls when printer_type and/or a print size is given (FDM, SLA/resin or full-color). FREE. This is the authoritative answer to "is it printable?".

The finished task (task_type "print-analyze") reports printability.status:
  - error → meshy_repair_printability (pass this analyze task as input_task_id to reuse its printer and size)
  - warning → repair is optional
  - healthy → download the analyzed source task's model (the analyze task has none)

Example: { input_task_id: "abc-123", printer_type: "sla", intended_print_height_mm: 100 }`,
      inputSchema: AnalyzePrintabilityInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof AnalyzePrintabilityInputSchema>) => {
      const source = printSource(params);
      const invalid = source ? checkPrintSize(params) : MISSING_PRINT_SOURCE;
      if (invalid) {
        return { isError: true, content: [{ type: "text", text: invalid }] };
      }
      try {
        const { input_task_id, model_url, ...options } = params;
        const request = buildApiRequest({ ...source }, options);

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/print/analyze",
          request
        );

        const taskId = response.result;
        const sourceDesc = params.input_task_id
          ? `task "${params.input_task_id}"`
          : `model URL`;

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Printability analysis started for ${sourceDesc}. Cost: FREE.`,
            estimated_time: "10-30 seconds"
          },
          params.response_format as ResponseFormat,
          "Printability Analysis Task Created",
          `Analyzing ${sourceDesc} for printability. The result will report watertightness, volume, non-manifold edges, degenerate faces, and holes` +
            (params.printer_type || params.intended_print_height_mm || params.intended_print_longest_side_mm
              ? `, plus thin walls for ${params.printer_type ?? "fdm"} at the given print size.`
              : "."),
          "print-analyze"
        );
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error) }]
        };
      }
    }
  );

  // ── Repair Printability ─────────────────────────────────────────
  server.registerTool(
    "meshy_repair_printability",
    {
      title: "Repair Model Topology for 3D Printing",
      description: `Repair a model for 3D printing (FDM, SLA/resin or full-color): fixes non-manifold edges, degenerate faces and holes and makes it watertight. Cost: 10 credits. Textures are removed (retexture afterwards if needed).

Output format: input_task_id → GLB; model_url → the input's format (.stl → STL, .obj → OBJ…). To keep a Meshy model as OBJ, pass its OBJ URL (model_urls.obj) as model_url.
With printer_type and/or a print size it also thickens walls that are too thin, when over 5% of the surface is. The model keeps its scale (meshy_resize scales it).`,
      inputSchema: RepairPrintabilityInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof RepairPrintabilityInputSchema>) => {
      const source = printSource(params);
      const invalid = source ? checkPrintSize(params) : MISSING_PRINT_SOURCE;
      if (invalid) {
        return { isError: true, content: [{ type: "text", text: invalid }] };
      }
      try {
        const { input_task_id, model_url, ...options } = params;
        const request = buildApiRequest({ ...source }, options);

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/print/repair",
          request
        );

        const taskId = response.result;
        const sourceDesc = params.input_task_id
          ? `task "${params.input_task_id}"`
          : `model URL`;

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Topology repair started for ${sourceDesc}. Cost: 10 credits.`,
            estimated_time: "30-60 seconds"
          },
          params.response_format as ResponseFormat,
          "Printability Repair Task Created",
          `Repairing ${sourceDesc}'s topology (non-manifold edges, holes, degenerate faces). Output preserves the input format; textures are not preserved.`,
          "print-repair"
        );
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error) }]
        };
      }
    }
  );

  // ── Process Multicolor (real API) ───────────────────────────────
  server.registerTool(
    "meshy_process_multicolor",
    {
      title: "Process Multi-Color 3D Print",
      description: `Turn a textured model into a multi-color 3MF that opens ready to print in the slicer of printer_brand. Cost: 10 credits.

Confirm first: max_colors (the printer's AMS/MMU capacity), style, printer_brand, and max_depth (realistic only).
Download with format "3mf", then open it with meshy_send_to_slicer (is_multicolor). Flashforge, QIDI, Snapmaker and AnkerMake slicers are not detected: give the user the 3MF path for that slicer.`,
      inputSchema: ProcessMulticolorInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof ProcessMulticolorInputSchema>) => {
      const source = printSource(params);
      if (!source) {
        return {
          isError: true,
          content: [{ type: "text", text: MISSING_PRINT_SOURCE }]
        };
      }
      try {
        const { input_task_id, model_url, ...options } = params;
        const request = buildApiRequest({ ...source }, options);

        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/print/multi-color",
          request
        );

        const taskId = response.result;
        const sourceDesc = params.input_task_id
          ? `task "${params.input_task_id}"`
          : `model URL`;

        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Multi-color processing started for ${sourceDesc} with ${params.max_colors} colors (depth: ${params.max_depth}). Cost: 10 credits.`,
            estimated_time: "~1 minute"
          },
          params.response_format as ResponseFormat,
          "Multi-Color Processing Task Created",
          `Processing ${sourceDesc} into ${params.max_colors} colors (depth: ${params.max_depth}). The output will be a 3MF file for multi-color 3D printing.`,
          "multi-color-print"
        );
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error) }]
        };
      }
    }
  );

  // ── Auto Split ──────────────────────────────────────────────────
  server.registerTool(
    "meshy_auto_split",
    {
      title: "Auto Split Model into Printable Parts",
      description: `Cut a model into separately printable parts: when it is too big for the bed, parts need different colors/materials, or it should be assembled. Cost: ${AUTO_SPLIT_CREDITS} credits. The texture is not kept.

There is no bed-size parameter: cuts follow mode and prompt, not your printer, so resize the model to the print size first (meshy_resize) when parts must fit a bed.
Then meshy_download_model (3mf if requested) and meshy_send_to_slicer.

Example: { input_task_id: "abc-123", mode: "by_parts", prompt: "the figure and the base", target_formats: ["3mf"], connectors: true }`,
      inputSchema: AutoSplitInputSchema,
      outputSchema: TaskCreatedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof AutoSplitInputSchema>) => {
      if ((params.mode === "by_parts" || params.mode === "by_color") && !params.prompt) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: mode "${params.mode}" needs a prompt naming the parts to split into.` }]
        };
      }
      try {
        const response = await client.post<CreateTaskApiResponse>(
          "/openapi/v1/print/split",
          buildApiRequest({}, params)
        );
        const taskId = response.result;
        return formatTaskCreatedResponse(
          {
            task_id: taskId,
            status: "PENDING",
            message: `Auto Split started for task "${params.input_task_id}". Cost: ${AUTO_SPLIT_CREDITS} credits.`,
            estimated_time: "1-2 minutes"
          },
          params.response_format,
          "Auto Split Task Created",
          `Splitting task "${params.input_task_id}" into printable parts (mode: ${params.mode ?? "auto"}).`,
          "print-split"
        );
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error) }]
        };
      }
    }
  );
}

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
      description: `Detect installed 3D printing slicer software and return launch commands.

IMPORTANT: This tool should be called as the FIRST STEP in any 3D printing workflow — before generating the model. Save the result and reuse it at the end to open the model in the user's chosen slicer.

Supports 7 slicers: OrcaSlicer, Bambu Studio, Creality Print, Elegoo Slicer, Anycubic Slicer Next, PrusaSlicer, UltiMaker Cura.
Multicolor-capable: OrcaSlicer, Bambu Studio, Creality Print, Elegoo Slicer, Anycubic Slicer Next, PrusaSlicer.

Usage pattern:
1. Call this tool at the START of a print workflow to detect slicers
2. Present detected slicers to the user
3. Generate, analyze, optionally repair / multicolor-process, and download the model
4. At the END, take the launch_command, replace {file} with the local file path, execute via Bash. If you cannot run shell commands, give the user the command and the file path to run themselves.

Args:
  - model_url (string): Download URL of the model file (can be a placeholder at detection time)
  - slicer_type (enum): 'auto' (default, detect all) or a specific slicer
  - file_name (string): File name for the model (default: "meshy_model.3mf")
  - is_multicolor (boolean): If true, only recommends multicolor-capable slicers (default: false)
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns:
  {
    "detected_slicers": [{"name": "OrcaSlicer", "launch_command": "open -a \\"OrcaSlicer\\" \\"{file}\\"", ...}],
    "recommended_slicer": {"name": "...", "launch_command": "..."},
    "model_url": "https://..."
  }

The launch_command contains {file} as placeholder. Replace it with the actual local file path before executing via Bash.

MULTIPLE MODELS: when opening several SEPARATE/unrelated models in a slicer (e.g. results from different generation tasks), run their open commands ONE AT A TIME with a short delay (~1–2s) between them — e.g. \`open -a "Bambu Studio" "modelA.stl"; sleep 2; open -a "Bambu Studio" "modelB.stl"\`. Firing them at once can make the slicer (Bambu Studio especially) respond to only one. (Parts of a SINGLE model belong in one project — open those together, not spaced.)`,
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
      description: `Run automated printability analysis (FDM, SLA/resin or full-color) on a 3D model. Cost: FREE (0 credits).

This is the authoritative way to answer "is this model printable / suitable for 3D printing / ready to print?". Printability here means geometry validity — watertightness, manifold edges, holes, degenerate faces, and volume — measured by this check. It's free, so run it whenever printability is the question, then use the result to decide whether the mesh needs repair (\`meshy_repair_printability\`).

Provide ONE of (input_task_id wins if both are given):
  - input_task_id: a SUCCEEDED Meshy task. **Must use Meshy 6 or newer** (Meshy 7 / 7.1 included). Supported task types: text-to-3d, image-to-3d, multi-image-to-3d, remesh, retexture — and print-repair, to re-check a repaired model.
  - model_url: a public URL of a 3D model file (.glb / .gltf / .obj / .fbx / .stl, max 100 MB) or a GLB data URI.

Optional wall-thickness check at the size you plan to print (takes longer): send printer_type, one print size, or both. The result adds printability.thin_walls and intended_print.

Args:
  - input_task_id (string, optional): Upstream Meshy task ID
  - model_url (string, optional): Public model URL
  - printer_type (enum, optional): "fdm" (1.0 mm min wall), "sla" (0.8 mm), "full_color" (2.0 mm)
  - intended_print_height_mm (number, optional): 1–1000, GLB / input_task_id only
  - intended_print_longest_side_mm (number, optional): 1–1000, any format. Send at most one size.
    With printer_type and no size: 150 mm tall for GLB / tasks, the file's own size for STL, 150 mm longest side otherwise
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns:
  { "task_id": "...", "status": "PENDING", ... }

Next Steps:
  Use meshy_get_task_status with task_id and task_type="print-analyze" to wait for completion.
  Once SUCCEEDED, the task object's \`printability\` field contains:
    - status: "healthy" / "warning" / "error" / "unknown"
    - issue_count, error_count, warning_count
    - metrics: { is_watertight, volume, non_manifold_edges, degenerate_faces, holes }
  - status="error" → call meshy_repair_printability before printing (pass this analyze task as its input_task_id to reuse the printer and size).
  - status="warning" → repair is optional.
  - status="healthy" → download the analyzed source task's model (the analyze task has none).

Examples:
  - From a task: { input_task_id: "abc-123" }
  - From a URL:  { model_url: "https://example.com/model.glb" }
  - Wall check for a 100 mm SLA print: { input_task_id: "abc-123", printer_type: "sla", intended_print_height_mm: 100 }`,
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
      description: `Repair a 3D model's topology for 3D printing (FDM, SLA/resin or full-color) — fixes non-manifold edges, degenerate faces, holes, and ensures watertightness. Cost: 10 credits.

Output format mirrors the input format:
  - input_task_id → output is GLB
  - model_url with .stl → output is STL
  - model_url with .obj → output is OBJ
  - model_url with .glb → output is GLB
  - model_url with .fbx / .gltf → output is FBX / GLTF

Provide ONE of (input_task_id wins if both are given):
  - input_task_id: a SUCCEEDED Meshy task that produced a GLB asset (text-to-3d, image-to-3d, multi-image-to-3d, remesh, retexture), or a print-analyze task. An analyze task that checked wall thickness passes on its printer and size.
  - model_url: a public URL of a 3D model (.glb / .gltf / .obj / .fbx / .stl, max 100 MB), or a GLB data URI. To keep a Meshy model as OBJ, pass the task's OBJ URL (model_urls.obj) here.

To also thicken walls that are too thin at the planned print size, send printer_type, one print size, or both (same fields as meshy_analyze_printability). Walls are thickened only when more than 5% of the surface is too thin; the model keeps its scale (use meshy_resize to scale it).

Args:
  - input_task_id (string, optional): Upstream Meshy task ID
  - model_url (string, optional): Public model URL
  - printer_type (enum, optional): "fdm" / "sla" / "full_color"
  - intended_print_height_mm / intended_print_longest_side_mm (number, optional): 1–1000 mm, at most one
  - alpha_thumbnail (boolean, optional): also render a transparent-background preview
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns:
  { "task_id": "...", "status": "PENDING", ... }

Next Steps:
  Use meshy_get_task_status with task_id and task_type="print-repair" to wait for completion.
  Once SUCCEEDED, model_urls contains the repaired model in the same format as the input.
  Note: textures are NOT preserved — repair operates on geometry only.

Examples:
  - From a task: { input_task_id: "abc-123" }
  - From an STL: { model_url: "https://example.com/model.stl" }`,
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
      description: `Process a textured 3D model for multi-color 3D printing. Cost: 10 credits.

Segments the model's texture into discrete color regions and creates a task that outputs a 3MF file that opens ready to print in the slicer of printer_brand (Bambu Studio, Anycubic Slicer Next, Creality Print, Elegoo Slicer, PrusaSlicer, OrcaSlicer…).

PREREQUISITES:
  - The input model MUST have textures: a textured image-to-3d / multi-image-to-3d task (should_texture left on), or texture it first with meshy_text_to_3d_refine or meshy_retexture.
  - A multicolor-capable slicer should be installed on the user's system.

IMPORTANT: Before calling, ask the user to confirm:
  - max_colors: depends on their printer's multi-color capability (e.g. Bambu AMS supports 4-16 colors).
  - style: "realistic" (default, photo-like detail, larger file) or "cartoon" (flat color regions, smaller file).
  - printer_brand: whose slicer preset to write into the 3MF (default "bambu").
  - max_depth (realistic only): color boundary precision vs. file size.

Provide input_task_id or model_url (input_task_id wins if both are given).

Args:
  - input_task_id (string, optional): Task ID of a completed TEXTURED model. Takes priority over model_url.
  - model_url (string, optional): Public URL of a textured .glb or .fbx model, or a GLB data URI.
  - max_colors (number): Max colors for segmentation (1-16, default: 4). MUST confirm with user based on their printer capability.
  - max_depth (number): Segmentation depth (3-6, default: 4). Higher = finer separation, larger file. realistic style only.
  - style (enum, optional): "realistic" or "cartoon". realistic needs one base color texture with UVs on every part; cartoon also accepts vertex colors
  - printer_brand (enum, optional): "bambu" (default), "anycubic", "creality", "elegoo", "flashforge", "prusa", "qidi", "snapmaker", "ankermake"
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns:
  { "task_id": "...", "status": "PENDING", ... }

Next Steps:
  1. Use meshy_get_task_status with task_id and task_type="multi-color-print" to wait for completion
  2. The completed task will have a 3MF download URL in model_urls
  3. Use meshy_download_model with format="3mf" to download
  4. Use meshy_send_to_slicer with is_multicolor=true to open the 3MF in a multicolor slicer. Flashforge, QIDI, Snapmaker and AnkerMake slicers are not detected: give the user the 3MF path to open in that slicer

Examples:
  - Default: { input_task_id: "abc-123" }
  - Custom: { input_task_id: "abc-123", max_colors: 8, max_depth: 5 }
  - From URL: { model_url: "https://example.com/textured.glb", max_colors: 6 }
  - Creality preset, flat colors: { input_task_id: "abc-123", style: "cartoon", printer_brand: "creality" }`,
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
      description: `Cut a generated model into separately printable parts. Cost: ${AUTO_SPLIT_CREDITS} credits.

Use when a model is too big for the print bed, needs parts printed in different colors/materials, or should be assembled after printing. There is no bed-size parameter: the cuts follow mode/prompt, not your printer, so scale the model to the print size first (meshy_resize) when parts must fit a bed.

Input: input_task_id of a SUCCEEDED image-to-3d, multi-image-to-3d, text-to-3d preview, remesh, convert or resize task made with meshy-6, meshy-7, meshy-7.1 or latest (not low-poly, not Smart Topology). A textured model is accepted, but the texture is not kept.

Args:
  - input_task_id (string, required)
  - mode (enum, optional): "auto" (default, Meshy chooses the cuts), "by_parts" (cut along parts named in prompt), "by_color" (cut along color regions named in prompt; image-to-3d / multi-image-to-3d inputs only)
  - prompt (string): required for by_parts / by_color. Name 1–10 parts ("head, torso, arms, legs"); unnamed geometry becomes one remaining part. If Meshy cannot read the prompt it falls back to auto, still charges, and the task reports prompt_ignored: true
  - target_formats (string[], optional): extra formats; glb is always produced. Use "3mf" for separately selectable parts in a slicer ("stl" fuses all parts into one solid)
  - layout (enum, optional): "assembled" (default) or "on_plate" (parts laid flat, ready to slice)
  - connectors (boolean, optional): add mortise-and-tenon connectors at the cuts; connector_type "cube" | "cylinder", connector_size and connector_height 0.1–0.8
  - response_format (enum): "markdown" or "json" (default: "markdown")

Next Steps:
  meshy_get_task_status with task_type "print-split" (the result reports part_count), then meshy_download_model (3mf if requested), then meshy_send_to_slicer to open the parts.

Examples:
  - { input_task_id: "abc-123" }
  - { input_task_id: "abc-123", mode: "by_parts", prompt: "the figure and the base", target_formats: ["3mf"], connectors: true }`,
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

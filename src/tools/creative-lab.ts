/**
 * Creative Lab tool — one tool that turns a photo into a finished
 * physical-product 3D model, end-to-end.
 *
 * Most products have two stages — prototype then build — linked by
 * input_task_id. This tool runs both internally, hides the intermediate
 * prototype, and returns only the final 3D product. Collapsible Fidget is a
 * single task. Cost per product: see creativeLabCredits().
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshyClient, pollTask } from "../services/meshy-client.js";
import { handleMeshyError } from "../services/error-handler.js";
import { resolveImageSource } from "../services/file-utils.js";
import { CreativeLabInputSchema, checkCreativeLabParams } from "../schemas/creative-lab.js";
import {
  ResponseFormat,
  TaskStatus,
  CreativeLabProduct,
  creativeLabCredits,
  TaskType
} from "../constants.js";
import {
  CreateTaskApiResponse,
  CreativeLabPrototypeApiRequest,
  CreativeLabBuildApiRequest,
  GetTaskResponse
} from "../types.js";
import { describeTaskError } from "../utils/response-formatter.js";

/** Text progress bar (no trailing % — the MCP client appends the percentage itself). */
function progressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/** Why a stage did not succeed, for the error message. */
function stageFailure(task: GetTaskResponse | undefined, timeoutSeconds: number): string {
  if (task?.status === TaskStatus.FAILED) return `failed: ${describeTaskError(task.task_error)} (failed tasks are refunded)`;
  if (task?.status === TaskStatus.CANCELED) return "was canceled";
  return `did not finish in ${timeoutSeconds}s (status ${task?.status ?? "unknown"}). It is still running; check it with meshy_get_task_status`;
}

/**
 * Register the Creative Lab tool with the MCP server
 */
export function registerCreativeLabTools(server: McpServer, client: MeshyClient) {
  server.registerTool(
    "meshy_creative_lab",
    {
      title: "Creative Lab — Make a Product (end-to-end)",
      description: `Turn a source photo into a finished Creative Lab product 3D model.

Products and cost:
  - "figure" (chibi collectible), "keychain", "fridge-magnet", "vinyl-figure" (vinyl-toy style),
    "brick-figure" (brick-minifigure style), "fidget-pixel" (pixel-art board of interlocking pieces) → 36 credits (6 + 30)
  - "lamp" (3D-printable lampshade with base plate) → 36 credits (30 + 6)
  - "keycap" (Cherry MX 1u keycap) → 62 credits (12 + 50)
  - "fidget-collapsible" (nested-ring collapsible fidget from the photo's outline) → 6 credits, single stage

Most products run two Meshy stages — concept prototype then 3D build — and this tool returns ONLY the final 3D model; the intermediate concept image is internal and never surfaced. One call does everything; it blocks while the stages run (typically 2–5 minutes) and reports progress.

IMPORTANT: confirm the credit cost with the user before calling — keycap costs 62, fidget-collapsible 6.

INPUT — provide ONE image source (every product is image-only):
  - Local image → file_path: "/absolute/path/photo.jpg" (.jpg/.jpeg/.png/.webp)
  - Remote image → image_url: "https://example.com/photo.jpg" (or data URI)

Args:
  - product (enum, REQUIRED): "figure" | "lamp" | "keychain" | "fridge-magnet" | "vinyl-figure" | "brick-figure" | "keycap" | "fidget-pixel" | "fidget-collapsible"
  - image_url / file_path (string): image source
  - image_subject (enum, optional): lamp only — "character" | "landscape"
  - pixel_subject (enum): fidget-pixel only, REQUIRED — "person" (chibi sprite) | "other" (bead-art icon)
  - name_text (string, optional): keychain only — text to engrave, ≤10 characters
  - head_size_mm (10–40, default 23), vertical_offset_mm (-5–5), base_model: keycap only
  - build_options (object, optional): build settings for keychain / fridge-magnet (badge_shape, size_mm, relief…), lamp (diameter_mm, thickness_mm, light_source_preset…) and fidget-pixel (shape, grid_size 16|32, piece_size_mm, color_count, piece_height_mm). See the parameter description for every key.
  - output_format (enum, optional): keychain / fridge-magnet "glb" | "obj" | "zip"; lamp "stl" | "zip"; fidget-pixel "3mf"
  - name (string, optional): display name (≤100 chars); not engraved
  - timeout_seconds (number): max wait per stage (default 300, max 600)
  - response_format (enum): "markdown" or "json" (default: "markdown")

Outputs: figure-type products and keychain / fridge-magnet give GLB (or the chosen format); lamp gives lamp_stl (+ base_stl with a fixture preset); keycap a model; fidget-pixel a 3MF with one object per piece; fidget-collapsible STL + GLB. Download with meshy_download_model and the task_type this tool reports; omit format to save every part.

To multicolor-print the result: a Creative Lab model can only be sent to meshy_process_multicolor as model_url — pass its GLB URL, or a data URI of the downloaded GLB.

Examples:
  - { product: "figure", file_path: "/Users/me/portrait.jpg" }
  - { product: "keychain", file_path: "/Users/me/dog.jpg", name_text: "Biscuit", build_options: { badge_shape: "star" } }
  - { product: "lamp", image_url: "https://example.com/owl.jpg", image_subject: "character", build_options: { diameter_mm: 180 } }
  - { product: "fidget-pixel", file_path: "/Users/me/cat.jpg", pixel_subject: "other", build_options: { grid_size: 16 } }
  - { product: "keycap", file_path: "/Users/me/cat.jpg", head_size_mm: 25 }

If the prototype stage does not succeed, the build is NOT started. A FAILED stage is refunded; one that is still running when the wait ends keeps running and is charged.`,
      inputSchema: CreativeLabInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof CreativeLabInputSchema>, extra) => {
      if (!params.image_url && !params.file_path) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: provide an image source — image_url or file_path. Every Creative Lab product is image-only." }]
        };
      }
      const invalid = checkCreativeLabParams(params);
      if (invalid) {
        return { isError: true, content: [{ type: "text", text: `Error: ${invalid}` }] };
      }

      const product = params.product;
      const singleStage = product === CreativeLabProduct.FIDGET_COLLAPSIBLE;
      const protoType = `creative-lab-${product}-prototype` as TaskType;
      const buildType = (singleStage ? TaskType.CREATIVE_LAB_FIDGET_COLLAPSIBLE : `creative-lab-${product}-build`) as TaskType;
      // Kept outside the try so an error after a create still names the task
      // that was created (and charged).
      let protoId: string | undefined;
      let buildId: string | undefined;
      try {
        const credits = creativeLabCredits(product);
        const timeoutMs = params.timeout_seconds * 1000;
        const imageUrl = await resolveImageSource(params.image_url, params.file_path);

        // One combined 0–100% bar: prototype is 0–30%, build 30–100% (or the
        // whole bar for a single-stage product).
        const notify = (stage: "prototype" | "build", progress: number) => {
          const overall = singleStage ? progress
            : stage === "prototype" ? Math.round(progress * 0.3) : 30 + Math.round(progress * 0.7);
          const message = `Creating your ${product} ${progressBar(overall)}`;
          try {
            server.sendLoggingMessage({ level: "info", data: message });
          } catch {
            // logging not critical
          }
          if (extra?._meta?.progressToken !== undefined) {
            server.server.notification({
              method: "notifications/progress",
              params: { progressToken: extra._meta.progressToken, progress: overall, total: 100, message }
            }).catch(() => {});
          }
        };

        let proto: GetTaskResponse | undefined;
        let buildReq: Record<string, unknown>;
        if (singleStage) {
          buildReq = { image_url: imageUrl };
          if (params.name) buildReq.name = params.name;
        } else {
          // ── Stage 1: prototype ────────────────────────────────────────
          const protoReq: CreativeLabPrototypeApiRequest = { image_url: imageUrl };
          if (params.name) protoReq.name = params.name;
          if (params.image_subject) protoReq.image_subject = params.image_subject;
          if (params.pixel_subject) protoReq.type = params.pixel_subject;
          if (params.name_text !== undefined) protoReq.name_text = params.name_text;

          protoId = (await client.post<CreateTaskApiResponse>(
            `/openapi/creative-lab/${product}/v1/prototype`,
            protoReq as unknown as Record<string, unknown>
          )).result;
          proto = (await pollTask(client, protoId, protoType, timeoutMs, t => notify("prototype", t.progress || 0))).task;

          if (proto?.status !== TaskStatus.SUCCEEDED) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: `Error: Creative Lab ${product} prototype ${stageFailure(proto, params.timeout_seconds)}. The build stage was NOT started${proto?.status === TaskStatus.FAILED ? "" : ` (the prototype is charged ${credits.prototype} credits)`}. Prototype task_id: ${protoId} (task_type "${protoType}").`
              }]
            };
          }

          // ── Stage 2: build request ────────────────────────────────────
          const build: CreativeLabBuildApiRequest = { input_task_id: protoId };
          if (params.name) build.name = params.name;
          const options: Record<string, string | number | boolean> = { ...params.build_options };
          if (product === CreativeLabProduct.KEYCAP) {
            // Keycap builds one of the prototype's candidates.
            const candidateId = (proto as unknown as { candidate_ids?: string[] }).candidate_ids?.[0];
            if (!candidateId) {
              return {
                isError: true,
                content: [{
                  type: "text",
                  text: `Error: the keycap prototype (task_id ${protoId}) succeeded but returned no candidate_ids, so the build cannot be started. Only the ${credits.prototype}-credit prototype was charged.`
                }]
              };
            }
            build.candidate_id = candidateId;
            if (params.base_model) options.base_model = params.base_model;
            if (params.head_size_mm !== undefined) options.head_size_mm = params.head_size_mm;
            if (params.vertical_offset_mm !== undefined) options.vertical_offset_mm = params.vertical_offset_mm;
          }
          if (Object.keys(options).length > 0) build.options = options;
          if (params.output_format) build.output = { format: params.output_format };
          buildReq = build as unknown as Record<string, unknown>;
        }

        // ── Build (or the single stage) ─────────────────────────────────
        const buildPath = singleStage
          ? "/openapi/creative-lab/fidget-collapsible/v1"
          : `/openapi/creative-lab/${product}/v1/build`;
        buildId = (await client.post<CreateTaskApiResponse>(buildPath, buildReq)).result;
        const build = (await pollTask(client, buildId, buildType, timeoutMs, t => notify("build", t.progress || 0))).task;

        if (build?.status !== TaskStatus.SUCCEEDED) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Error: Creative Lab ${product} ${singleStage ? "task" : "build"} ${stageFailure(build, params.timeout_seconds)}. Task_id: ${buildId} (task_type "${buildType}").${protoId ? ` Prototype task_id: ${protoId}.` : ""}`
            }]
          };
        }

        const formats = build.model_urls
          ? Object.keys(build.model_urls).filter(k => build.model_urls![k as keyof typeof build.model_urls])
          : [];
        const totalCredits = (proto?.consumed_credits || 0) + (build.consumed_credits || 0);

        const output = {
          task_id: buildId,
          task_type: buildType,
          status: "SUCCEEDED",
          product,
          model_urls: build.model_urls,
          formats,
          consumed_credits: totalCredits,
          prototype_task_id: protoId
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          textContent = `# Creative Lab ${product} — Done

**Task ID**: ${buildId}
**Outputs**: ${formats.join(", ") || "none"}
**Credits Consumed**: ${totalCredits}${singleStage ? "" : " (prototype + build)"}

The final 3D ${product} is ready. Download it with \`meshy_download_model\` (task_id "${buildId}", task_type "${buildType}", no format) to save every part.`;
        }

        return {
          content: [{ type: "text", text: textContent }],
          structuredContent: output
        };
      } catch (error) {
        const created = [
          protoId && `Prototype task_id: ${protoId} (task_type "${protoType}")`,
          buildId && `${singleStage ? "Task" : "Build task"}_id: ${buildId} (task_type "${buildType}")`
        ].filter(Boolean);
        const note = created.length
          ? `\n\nAlready created (check with meshy_get_task_status before starting over): ${created.join("; ")}.`
          : "";
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error, { tool: "meshy_creative_lab" }) + note }]
        };
      }
    }
  );
}

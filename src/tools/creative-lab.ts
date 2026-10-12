/**
 * Creative Lab tool — one tool that turns a photo into a finished
 * physical-product 3D model, end-to-end.
 *
 * The Meshy API has two stages — prototype then build — linked by input_task_id.
 * This tool runs BOTH internally, hides the intermediate prototype, and returns only
 * the final 3D product. Cost per product: see creativeLabCredits().
 *
 * Products (OpenAPI): figure, lamp, keychain, fridge-magnet, vinyl-figure, brick-figure, keycap.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshyClient, pollTask } from "../services/meshy-client.js";
import { handleMeshyError } from "../services/error-handler.js";
import { resolveImageSource } from "../services/file-utils.js";
import { CreativeLabInputSchema } from "../schemas/creative-lab.js";
import {
  ResponseFormat,
  TaskStatus,
  CreativeLabProduct,
  creativeLabCredits,
  CREATIVE_LAB_KEYCAP_PROTOTYPE_CREDITS,
  TaskType
} from "../constants.js";
import {
  CreateTaskApiResponse,
  CreativeLabPrototypeApiRequest,
  CreativeLabBuildApiRequest
} from "../types.js";
import { describeTaskError } from "../utils/response-formatter.js";

/** Text progress bar (no trailing % — the MCP client appends the percentage itself). */
function progressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
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
    "brick-figure" (brick-minifigure style) → 36 credits (6 + 30)
  - "lamp" (3D-printable lampshade with base plate) → 36 credits (30 + 6)
  - "keycap" (Cherry MX 1u keycap) → 62 credits (12 + 50)

This runs the full two-stage Meshy pipeline internally — concept prototype then 3D build — and returns ONLY the final 3D model. The intermediate concept image is internal and is never surfaced. One call does everything; it blocks while both stages run (typically 2–5 minutes) and reports progress.

IMPORTANT: confirm the credit cost with the user before calling — and note keycap costs 62, not 36.

INPUT — provide ONE image source (every product is image-only):
  - Local image → file_path: "/absolute/path/photo.jpg" (.jpg/.jpeg/.png/.webp)
  - Remote image → image_url: "https://example.com/photo.jpg" (or data URI)

Args:
  - product (enum, REQUIRED): "figure" | "lamp" | "keychain" | "fridge-magnet" | "vinyl-figure" | "brick-figure" | "keycap"
  - image_url / file_path (string, optional): image source
  - image_subject (enum, optional): "character" | "landscape" — lamp only
  - head_size_mm (number, optional): keycap only — head longest edge in mm (10–40, default 23)
  - base_model (string, optional): keycap only — "cherry-mx-1x1-r1" (the only profile today)
  - name (string, optional): display name (≤100 chars)
  - timeout_seconds (number): max wait per stage (default 300, max 600)
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns: the final build task_id + available model formats (GLB / OBJ+MTL). Then use meshy_download_model with task_type "creative-lab-{product}-build" to save the model.

To multicolor-print the result: a Creative Lab model can only be sent to meshy_process_multicolor as model_url — pass its build GLB URL, or a data URI of the downloaded GLB.

Examples:
  - { product: "figure", file_path: "/Users/me/portrait.jpg" }
  - { product: "lamp", image_url: "https://example.com/owl.jpg", image_subject: "character" }
  - { product: "keycap", file_path: "/Users/me/cat.jpg", head_size_mm: 25 }

If the prototype stage fails, the build is NOT started (only the prototype is charged).`,
      inputSchema: CreativeLabInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof CreativeLabInputSchema>, extra) => {
      // Kept outside the try so an error after a create still names the task
      // that was created (and charged).
      let protoId: string | undefined;
      let buildId: string | undefined;
      try {
        const hasImage = Boolean(params.image_url || params.file_path);
        if (!hasImage) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: provide an image source — image_url or file_path. Every Creative Lab product is image-only." }]
          };
        }

        const product = params.product;

        const credits = creativeLabCredits(product);
        const protoBase = `/openapi/creative-lab/${product}/v1/prototype`;
        const buildBase = `/openapi/creative-lab/${product}/v1/build`;
        const timeoutMs = params.timeout_seconds * 1000;

        // Progress relay — reports a single combined 0–100% bar; the prototype/build split
        // is internal and not surfaced. (prototype maps to 0–30%, build to 30–100%.)
        const notify = (stage: "prototype" | "build", _status: string, progress: number) => {
          const overall = stage === "prototype"
            ? Math.round(progress * 0.3)
            : 30 + Math.round(progress * 0.7);
          try {
            server.sendLoggingMessage({
              level: "info",
              data: `Creating your ${product} ${progressBar(overall)}`
            });
          } catch {
            // logging not critical
          }
          if (extra?._meta?.progressToken !== undefined) {
            server.server.notification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: overall,
                total: 100,
                // No literal % here — the MCP client appends the percentage itself.
                message: `Creating your ${product} ${progressBar(overall)}`
              }
            }).catch(() => {});
          }
        };

        // ── Stage 1: prototype ──────────────────────────────────────────
        const protoReq: CreativeLabPrototypeApiRequest = {
          image_url: await resolveImageSource(params.image_url, params.file_path)
        };
        if (params.image_subject) protoReq.image_subject = params.image_subject;
        if (params.name) protoReq.name = params.name;

        const protoResp = await client.post<CreateTaskApiResponse>(
          protoBase,
          protoReq as unknown as Record<string, unknown>
        );
        protoId = protoResp.result;
        const protoPoll = await pollTask(client, protoId, `creative-lab-${product}-prototype` as TaskType, timeoutMs,
          t => notify("prototype", t.status, t.progress || 0));
        const proto = protoPoll.task;

        if (proto?.status !== TaskStatus.SUCCEEDED) {
          const reason = proto?.status === TaskStatus.FAILED
            ? `failed: ${describeTaskError(proto.task_error)}. Failed tasks are refunded`
            : proto?.status === TaskStatus.CANCELED
              ? "was canceled"
              : `did not finish in ${params.timeout_seconds}s (status ${proto?.status ?? "unknown"}). It is still running; check it with meshy_get_task_status`;
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Error: Creative Lab ${product} prototype ${reason}. The build stage was NOT started (the prototype costs ${credits.prototype} credits). Prototype task_id: ${protoId} (task_type "creative-lab-${product}-prototype").`
            }]
          };
        }

        // ── Stage 2: build ──────────────────────────────────────────────
        const buildReq: CreativeLabBuildApiRequest = { input_task_id: protoId };
        if (params.name) buildReq.name = params.name;

        // Keycap is the one product whose build is not input_task_id-only: it
        // requires candidate_id, picked from the candidate_ids the prototype
        // returns, and accepts an options object. Every other product 400s on
        // these fields, so they are keycap-scoped.
        if (product === CreativeLabProduct.KEYCAP) {
          const candidateId = (proto as unknown as { candidate_ids?: string[] }).candidate_ids?.[0];
          if (!candidateId) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: `Error: the keycap prototype (task_id ${protoId}) succeeded but returned no candidate_ids, so the build cannot be started. Only the ${CREATIVE_LAB_KEYCAP_PROTOTYPE_CREDITS}-credit prototype was charged.`
              }]
            };
          }
          buildReq.candidate_id = candidateId;
          const options: { base_model?: string; head_size_mm?: number } = {};
          if (params.base_model) options.base_model = params.base_model;
          if (params.head_size_mm !== undefined) options.head_size_mm = params.head_size_mm;
          if (Object.keys(options).length > 0) buildReq.options = options;
        }

        const buildResp = await client.post<CreateTaskApiResponse>(
          buildBase,
          buildReq as unknown as Record<string, unknown>
        );
        buildId = buildResp.result;
        const buildPoll = await pollTask(client, buildId, `creative-lab-${product}-build` as TaskType, timeoutMs,
          t => notify("build", t.status, t.progress || 0));
        const build = buildPoll.task;

        if (build?.status !== TaskStatus.SUCCEEDED) {
          const reason = build?.status === TaskStatus.FAILED
            ? `failed: ${describeTaskError(build.task_error)}`
            : build?.status === TaskStatus.CANCELED
              ? "was canceled"
              : `did not finish in ${params.timeout_seconds}s (status ${build?.status ?? "unknown"}). It is still running`;
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Error: Creative Lab ${product} build ${reason}. Build task_id: ${buildId} (task_type "creative-lab-${product}-build" — check it with meshy_get_task_status). Prototype task_id: ${protoId}.`
            }]
          };
        }

        const formats = build.model_urls
          ? Object.keys(build.model_urls).filter(k => build.model_urls![k as keyof typeof build.model_urls])
          : [];
        const totalCredits = (proto.consumed_credits || 0) + (build.consumed_credits || 0);

        const output = {
          task_id: buildId,
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

**Build Task ID**: ${buildId}
**Available Formats**: ${formats.join(", ").toUpperCase() || "none"}
**Credits Consumed**: ${totalCredits} (prototype + build)

The final 3D ${product} is ready. Download it with \`meshy_download_model\` (task_id "${buildId}", task_type "creative-lab-${product}-build").`;
        }

        return {
          content: [{ type: "text", text: textContent }],
          structuredContent: output
        };
      } catch (error) {
        const created = [
          protoId && `Prototype task_id: ${protoId} (task_type "creative-lab-${params.product}-prototype")`,
          buildId && `Build task_id: ${buildId} (task_type "creative-lab-${params.product}-build")`
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

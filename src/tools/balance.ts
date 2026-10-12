/**
 * Account tools — credit balance and API usage records
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshyClient } from "../services/meshy-client.js";
import { handleMeshyError } from "../services/error-handler.js";
import { CheckBalanceInputSchema, ListUsageInputSchema } from "../schemas/balance.js";
import { BalanceOutputSchema } from "../schemas/output.js";
import { CHARACTER_LIMIT, ResponseFormat } from "../constants.js";
import { BalanceResponse, UsageRecord } from "../types.js";

/**
 * Register the balance tool with the MCP server
 */
export function registerBalanceTool(server: McpServer, client: MeshyClient) {
  server.registerTool(
    "meshy_check_balance",
    {
      title: "Check Credit Balance",
      description: `Check your Meshy account credit balance. Free.

Returns the credits available now, split into monthly credits (expire at the next monthly refresh) and permanent credits (never expire). For team members these are the team's shared pool.

Args:
  - response_format (enum): Output format - "markdown" or "json" (default: "markdown")

Returns:
  { "balance": 1000, "monthly_credits": 600, "permanent_credits": 400, "monthly_resets_at": "2026-11-01T00:00:00.000Z" }

Examples:
  - Check balance: {}
  - JSON format: { response_format: "json" }`,
      inputSchema: CheckBalanceInputSchema,
      outputSchema: BalanceOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof CheckBalanceInputSchema>) => {
      try {
        const data = await client.get<BalanceResponse>("/openapi/v1/balance");

        const resetsAt = typeof data.monthly_resets_at === "number"
          ? new Date(data.monthly_resets_at).toISOString()
          : undefined;
        const output = {
          balance: data.balance,
          monthly_credits: data.monthly_credits,
          permanent_credits: data.permanent_credits,
          monthly_resets_at: resetsAt
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Meshy Credit Balance`, "", `**Balance**: ${data.balance} credits`];
          if (data.monthly_credits !== undefined) {
            lines.push(`- Monthly: ${data.monthly_credits}${resetsAt ? ` (expire and refresh at ${resetsAt})` : ""}`);
          }
          if (data.permanent_credits !== undefined) lines.push(`- Permanent: ${data.permanent_credits} (never expire)`);
          textContent = lines.join("\n");
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
          content: [{
            type: "text",
            text: handleMeshyError(error)
          }]
        };
      }
    }
  );

  server.registerTool(
    "meshy_list_usage",
    {
      title: "List API Usage Records",
      description: `List the team's finished API tasks with the credits each consumed, newest first. Free. Use it to break down spend per endpoint or per API key.

Only for API keys on a Studio or Enterprise team; any other key gets a 403.

Covers tasks that reached SUCCEEDED or FAILED (FAILED tasks are refunded, so they show 0 credits). Credits are charged at creation, so a task still running is not listed yet. Without start_time / end_time it covers the last 30 days.

Args:
  - page_num (number): Page, default 1. page_size (number): 1–100, default 20
  - sort_by (enum): "-created_at" (default) or "+created_at"
  - start_time / end_time (string, optional): RFC 3339 window on created_at, at most 1 year
  - endpoints (string[], optional): e.g. ["image-to-3d", "text-to-3d"] ("text-to-3d" covers preview and refine)
  - status (enum, optional): "SUCCEEDED" or "FAILED"
  - response_format (enum): "markdown" or "json" (default: "markdown")

Returns: { records: [{ task_id, endpoint, status, created_at, finished_at, consumed_credits, api_key_name, api_key_suffix }], page_num, page_size, has_more }

Examples:
  - Last 30 days: {}
  - September image-to-3d spend: { start_time: "2026-09-01T00:00:00Z", end_time: "2026-10-01T00:00:00Z", endpoints: ["image-to-3d"], page_size: 100 }`,
      inputSchema: ListUsageInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: z.infer<typeof ListUsageInputSchema>) => {
      try {
        const query: Record<string, unknown> = {
          page_num: params.page_num,
          page_size: params.page_size,
          sort_by: params.sort_by
        };
        if (params.start_time) query.start_time = params.start_time;
        if (params.end_time) query.end_time = params.end_time;
        if (params.endpoints) query.endpoints = params.endpoints.join(",");
        if (params.status) query.status = params.status;

        const data = await client.get<UsageRecord[]>("/openapi/v1/usage/tasks", query);
        const records = Array.isArray(data) ? data : [];
        const output = {
          records,
          page_num: params.page_num,
          page_size: params.page_size,
          has_more: records.length >= params.page_size
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.MARKDOWN) {
          const total = records.reduce((sum, r) => sum + (r.consumed_credits || 0), 0);
          const lines = [
            `# API Usage (page ${params.page_num})`,
            "",
            `**Records**: ${records.length} — **Credits on this page**: ${total}`,
            "",
            "| Created | Endpoint | Status | Credits | API key | Task ID |",
            "|---|---|---|---|---|---|",
            ...records.map(r =>
              `| ${new Date(r.created_at).toISOString()} | ${r.endpoint} | ${r.status} | ${r.consumed_credits} | ${r.api_key_name ?? ""} …${r.api_key_suffix ?? ""} | ${r.task_id} |`)
          ];
          if (output.has_more) lines.push("", `More records: call again with page_num ${params.page_num + 1}.`);
          textContent = lines.join("\n");
        } else {
          textContent = JSON.stringify(output, null, 2);
        }
        if (textContent.length > CHARACTER_LIMIT) {
          textContent = textContent.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated: use a smaller page_size or a narrower filter.]";
        }

        return {
          content: [{ type: "text", text: textContent }],
          structuredContent: output
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleMeshyError(error, { tool: "meshy_list_usage" }) }]
        };
      }
    }
  );
}

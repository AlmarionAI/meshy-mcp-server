/**
 * Shared response formatting for task creation tools.
 */

import { ResponseFormat } from "../constants.js";
import { TaskError } from "../types.js";

/**
 * One line for a failed task's task_error: "[type/code] message (guide: doc_url)".
 * `type` decides the retry: timeout / service_unavailable / server_error are
 * refunded and worth creating again; invalid_input needs a changed input.
 */
export function describeTaskError(error?: TaskError): string {
  if (!error) return "Unknown error";
  const tag = [error.type, error.code].filter(Boolean).join("/");
  const guide = error.doc_url ? ` (guide: ${error.doc_url})` : "";
  return `${tag ? `[${tag}] ` : ""}${error.message || "Unknown error"}${guide}`;
}

export interface TaskCreatedOutput {
  [x: string]: unknown;
  task_id: string;
  status: string;
  message: string;
  estimated_time: string;
}

/**
 * Format a task creation response with consistent structure across all tools.
 *
 * @param output - Structured output data
 * @param responseFormat - Desired response format (markdown or json)
 * @param title - Markdown title (e.g., "3D Generation Task Created")
 * @param body - Additional markdown body text (e.g., "Your 3D model is being generated...")
 * @param nextStepHint - Optional hint for the task_type parameter in next steps
 */
export function formatTaskCreatedResponse(
  output: TaskCreatedOutput,
  responseFormat: ResponseFormat,
  title: string,
  body: string,
  nextStepHint?: string
): { content: { type: "text"; text: string }[]; structuredContent: TaskCreatedOutput } {
  let textContent: string;

  if (responseFormat === ResponseFormat.MARKDOWN) {
    const taskTypeParam = nextStepHint ? ` and task_type "${nextStepHint}"` : "";
    textContent = `# ${title}

**Task ID**: ${output.task_id}
**Status**: ${output.status}
**Estimated Time**: ${output.estimated_time}

${body}

**Next Steps**:
1. **Recommended**: Use \`meshy_get_task_status\` with task_id "${output.task_id}"${taskTypeParam} to automatically wait for completion.
2. **Alternative**: Use \`meshy_get_task_status\` with wait=false to check once.`;
  } else {
    textContent = JSON.stringify(output, null, 2);
  }

  return {
    content: [{ type: "text", text: textContent }],
    structuredContent: output
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPrintingTools } from "../dist/tools/printing.js";
import { registerPostProcessingTools } from "../dist/tools/postprocessing.js";
import { registerImageTools } from "../dist/tools/image.js";
import { registerBalanceTool } from "../dist/tools/balance.js";
import { registerCreativeLabTools } from "../dist/tools/creative-lab.js";

// Offline request checks for the endpoints and options added in 0.7.0.
// The fake client answers every GET with a finished task of the type the path
// implies, so tools that wait (Creative Lab) run to completion instantly.

function createHarness(register, getResponses = {}) {
  const tools = new Map();
  const posts = [];
  const gets = [];
  let next = 0;
  const client = {
    async post(path, body) {
      posts.push({ path, body });
      return { result: `task-${++next}` };
    },
    async get(path, query) {
      gets.push({ path, query });
      for (const [prefix, response] of Object.entries(getResponses)) {
        if (path.startsWith(prefix)) return typeof response === "function" ? response(path) : response;
      }
      return [];
    },
    async getWithRetryAfter(path) {
      return { data: await this.get(path) };
    },
  };
  register(
    {
      registerTool(name, config, handler) {
        tools.set(name, { schema: config.inputSchema, handler });
      },
      sendLoggingMessage() {},
      server: { notification: async () => {} },
    },
    client,
  );
  return {
    posts,
    gets,
    schema: (name) => tools.get(name).schema,
    async run(name, input) {
      const { schema, handler } = tools.get(name);
      return handler(schema.parse(input), {});
    },
    async call(name, input) {
      const result = await this.run(name, input);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return posts.at(-1);
    },
    async invalid(name, input) {
      const result = await this.run(name, input);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(posts.length, 0);
      return result.content[0].text;
    },
  };
}

test("auto split forwards its options and needs a prompt for prompt modes", async () => {
  const h = createHarness(registerPrintingTools);
  assert.match(await h.invalid("meshy_auto_split", { input_task_id: "t", mode: "by_parts" }), /needs a prompt/);
  const { path, body } = await h.call("meshy_auto_split", {
    input_task_id: "t",
    mode: "by_parts",
    prompt: "the figure and the base",
    target_formats: ["3mf"],
    layout: "on_plate",
    connectors: true,
    connector_type: "cylinder",
  });
  assert.equal(path, "/openapi/v1/print/split");
  assert.deepEqual(body, {
    input_task_id: "t",
    mode: "by_parts",
    prompt: "the figure and the base",
    target_formats: ["3mf"],
    layout: "on_plate",
    connectors: true,
    connector_type: "cylinder",
  });
  assert.equal(h.schema("meshy_auto_split").safeParse({ input_task_id: "t", connector_size: 0.9 }).success, false);
});

test("printability takes a printer and one print size; multi-color takes style and brand", async () => {
  const h = createHarness(registerPrintingTools);
  assert.match(
    await h.invalid("meshy_analyze_printability", { input_task_id: "t", intended_print_height_mm: 100, intended_print_longest_side_mm: 100 }),
    /at most one/,
  );
  const { body: analyze } = await h.call("meshy_analyze_printability", { input_task_id: "t", printer_type: "sla", intended_print_height_mm: 100 });
  assert.deepEqual(analyze, { input_task_id: "t", printer_type: "sla", intended_print_height_mm: 100 });
  const { body: repair } = await h.call("meshy_repair_printability", { model_url: "https://example.invalid/m.stl", intended_print_longest_side_mm: 80, alpha_thumbnail: true });
  assert.deepEqual(repair, { model_url: "https://example.invalid/m.stl", intended_print_longest_side_mm: 80, alpha_thumbnail: true });
  const { body: color } = await h.call("meshy_process_multicolor", { input_task_id: "t", style: "cartoon", printer_brand: "creality" });
  assert.equal(color.style, "cartoon");
  assert.equal(color.printer_brand, "creality");
  assert.equal(h.schema("meshy_process_multicolor").safeParse({ input_task_id: "t", printer_brand: "acme" }).success, false);
});

test("animate takes exactly one of action_id, action_ids, motion_task_id", async () => {
  const h = createHarness(registerPostProcessingTools);
  await h.invalid("meshy_animate", { rig_task_id: "r" });
  await h.invalid("meshy_animate", { rig_task_id: "r", action_id: 1, motion_task_id: "m" });
  assert.equal(h.schema("meshy_animate").safeParse({ rig_task_id: "r", action_ids: [1, 1] }).success, false);
  assert.equal(h.schema("meshy_animate").safeParse({ rig_task_id: "r", action_ids: Array.from({ length: 11 }, (_, i) => i) }).success, false);
  const { body: multi } = await h.call("meshy_animate", { rig_task_id: "r", action_ids: [92, 4] });
  assert.deepEqual(multi, { rig_task_id: "r", action_ids: [92, 4] });
  const { body: motion } = await h.call("meshy_animate", { rig_task_id: "r", motion_task_id: "m" });
  assert.deepEqual(motion, { rig_task_id: "r", motion_task_id: "m" });
});

test("text to motion checks prompt and duration steps", async () => {
  const h = createHarness(registerPostProcessingTools);
  const schema = h.schema("meshy_text_to_motion");
  assert.equal(schema.safeParse({ prompt: "jump", duration: 2.25 }).success, false);
  assert.equal(schema.safeParse({ prompt: "jump", duration: 10.5 }).success, false);
  assert.equal(schema.safeParse({ prompt: "a".repeat(401), duration: 3 }).success, false);
  const { path, body } = await h.call("meshy_text_to_motion", { prompt: "jump", duration: 2.5, mode: "swift" });
  assert.equal(path, "/openapi/v1/text-to-motion");
  assert.deepEqual(body, { prompt: "jump", duration: 2.5, mode: "swift" });
});

test("library and usage lookups send their filters as query parameters", async () => {
  const lib = createHarness(registerPostProcessingTools, {
    "/openapi/v1/animations/library": [{ action_id: 92, name: "Double Combo Attack", key: "k", category: "Fighting", sub_category: "s", preview_url: "u" }],
  });
  const found = await lib.run("meshy_list_animations", { search: "combo", category: "Fighting", action_ids: [92, 4] });
  assert.equal(found.structuredContent.count, 1);
  assert.deepEqual(lib.gets[0].query, { search: "combo", category: "Fighting", action_ids: "92,4" });

  const usage = createHarness(registerBalanceTool, { "/openapi/v1/usage/tasks": [] });
  await usage.run("meshy_list_usage", { endpoints: ["image-to-3d", "rig"], status: "FAILED", start_time: "2026-09-01T00:00:00Z" });
  assert.deepEqual(usage.gets[0].query, {
    page_num: 1,
    page_size: 20,
    sort_by: "-created_at",
    start_time: "2026-09-01T00:00:00Z",
    endpoints: "image-to-3d,rig",
    status: "FAILED",
  });
});

test("balance reports monthly and permanent credits", async () => {
  const h = createHarness(registerBalanceTool, {
    "/openapi/v1/balance": { balance: 1000, monthly_credits: 600, permanent_credits: 400, monthly_resets_at: Date.UTC(2026, 10, 1) },
  });
  const result = await h.run("meshy_check_balance", {});
  assert.deepEqual(result.structuredContent, {
    balance: 1000,
    monthly_credits: 600,
    permanent_credits: 400,
    monthly_resets_at: "2026-11-01T00:00:00.000Z",
  });
});

test("image-to-image chains from a task and both image tools take remove_background", async () => {
  const h = createHarness(registerImageTools);
  const { body } = await h.call("meshy_image_to_image", {
    ai_model: "nano-banana-2-1",
    prompt: "make it red",
    input_task_id: "img",
    reference_image_urls: ["https://example.invalid/a.png"],
    aspect_ratio: "16:9",
    remove_background: true,
  });
  assert.equal(body.input_task_id, "img");
  assert.equal("reference_image_urls" in body, false);
  assert.equal(body.aspect_ratio, "16:9");
  assert.equal(body.remove_background, true);
  const { body: t2i } = await h.call("meshy_text_to_image", { ai_model: "nano-banana-2-lite", prompt: "cat", remove_background: true });
  assert.equal(t2i.remove_background, true);
});

const finished = (path) => {
  const type = path.match(/creative-lab\/([^/]+)\/v1(?:\/(prototype|build))?/);
  return {
    id: path.split("/").at(-1),
    type: `creative-lab-${type[1]}${type[2] ? `-${type[2]}` : ""}`,
    status: "SUCCEEDED",
    progress: 100,
    consumed_credits: 6,
    model_urls: { glb: "https://example.invalid/model.glb" },
  };
};

test("creative lab: keychain engraving goes on the prototype, options and format on the build", async () => {
  const h = createHarness(registerCreativeLabTools, { "/openapi/creative-lab/": finished });
  await h.call("meshy_creative_lab", {
    product: "keychain",
    image_url: "https://example.invalid/dog.png",
    name_text: "Biscuit",
    build_options: { badge_shape: "star", size_mm: 45 },
    output_format: "obj",
  });
  assert.deepEqual(h.posts.map((p) => p.path), ["/openapi/creative-lab/keychain/v1/prototype", "/openapi/creative-lab/keychain/v1/build"]);
  assert.equal(h.posts[0].body.name_text, "Biscuit");
  assert.deepEqual(h.posts[1].body, { input_task_id: "task-1", options: { badge_shape: "star", size_mm: 45 }, output: { format: "obj" } });
});

test("creative lab: fidget pixel needs a subject; collapsible fidget is one task", async () => {
  const h = createHarness(registerCreativeLabTools, { "/openapi/creative-lab/": finished });
  assert.match(await h.invalid("meshy_creative_lab", { product: "fidget-pixel", image_url: "https://example.invalid/a.png" }), /pixel_subject/);
  assert.match(await h.invalid("meshy_creative_lab", { product: "figure", image_url: "https://example.invalid/a.png", name_text: "x" }), /keychain only/);
  assert.match(await h.invalid("meshy_creative_lab", { product: "lamp", image_url: "https://example.invalid/a.png", output_format: "glb" }), /stl, zip/);
  assert.equal(h.schema("meshy_creative_lab").safeParse({ product: "keychain", name_text: "elevenchars" }).success, false);

  await h.call("meshy_creative_lab", { product: "fidget-pixel", image_url: "https://example.invalid/a.png", pixel_subject: "person", build_options: { grid_size: 16 } });
  assert.equal(h.posts[0].body.type, "person");
  assert.deepEqual(h.posts[1].body.options, { grid_size: 16 });

  const single = createHarness(registerCreativeLabTools, { "/openapi/creative-lab/": finished });
  const result = await single.run("meshy_creative_lab", { product: "fidget-collapsible", image_url: "https://example.invalid/a.png", name: "ring" });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(single.posts, [{ path: "/openapi/creative-lab/fidget-collapsible/v1", body: { image_url: "https://example.invalid/a.png", name: "ring" } }]);
  assert.equal(result.structuredContent.task_type, "creative-lab-fidget-collapsible");
});

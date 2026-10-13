import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPrintingTools } from "../dist/tools/printing.js";
import { registerPostProcessingTools } from "../dist/tools/postprocessing.js";
import { registerImageTools } from "../dist/tools/image.js";
import { registerBalanceTool } from "../dist/tools/balance.js";
import { registerCreativeLabTools } from "../dist/tools/creative-lab.js";
import { registerTaskTools } from "../dist/tools/tasks.js";
import { registerWorkspaceTools } from "../dist/tools/workspace.js";

// Offline request checks for the endpoints and options added or changed in 0.6.3.
// The fake client answers every GET with a finished task of the type the path
// implies, so tools that wait (Creative Lab) run to completion instantly.

function createHarness(register, getResponses = {}) {
  const tools = new Map();
  const posts = [];
  const gets = [];
  const deletes = [];
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
    async delete(path) {
      deletes.push(path);
      return {};
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
    deletes,
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

test("cancel deletes a finished task only after confirmation and explains refunds", async () => {
  const task = (status, type) => () => ({ id: "t", type, status });
  const done = createHarness(registerTaskTools, { "/openapi/v1/image-to-3d/t": task("SUCCEEDED", "image-to-3d") });
  const refused = await done.run("meshy_cancel_task", { task_id: "t" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /confirm_delete/);
  assert.deepEqual(done.deletes, []);
  const deleted = await done.run("meshy_cancel_task", { task_id: "t", confirm_delete: true });
  assert.deepEqual(done.deletes, ["/openapi/v1/image-to-3d/t"]);
  assert.match(deleted.structuredContent.message, /permanently/);

  const running = createHarness(registerTaskTools, { "/openapi/v1/image-to-3d/t": task("IN_PROGRESS", "image-to-3d") });
  const notStopped = await running.run("meshy_cancel_task", { task_id: "t", confirm_delete: true });
  assert.equal(notStopped.isError, true);
  assert.match(notStopped.content[0].text, /cannot be stopped/);
  assert.deepEqual(running.deletes, []);

  const pending = createHarness(registerTaskTools, { "/openapi/v1/image-to-3d/t": task("PENDING", "image-to-3d") });
  assert.match((await pending.run("meshy_cancel_task", { task_id: "t" })).structuredContent.message, /refunded/);

  const lab = createHarness(registerTaskTools, {
    "/openapi/creative-lab/figure/v1/build/t": task("IN_PROGRESS", "creative-lab-figure-build"),
  });
  const canceled = await lab.run("meshy_cancel_task", { task_id: "t", task_type: "creative-lab-figure-build" });
  assert.match(canceled.structuredContent.message, /not refunded/);
  assert.deepEqual(lab.deletes, ["/openapi/creative-lab/figure/v1/build/t"]);
});

test("remesh sends only the fields the caller set", async () => {
  const h = createHarness(registerPostProcessingTools);
  const { body } = await h.call("meshy_remesh", { input_task_id: "t", target_polycount: 10000, alpha_thumbnail: true });
  assert.deepEqual(body, { input_task_id: "t", target_formats: ["glb"], target_polycount: 10000, alpha_thumbnail: true });
});

test("retexture on meshy-6-lite suggests models retexture accepts", async () => {
  const h = createHarness(registerPostProcessingTools);
  const text = await h.invalid("meshy_retexture", { input_task_id: "t", text_style_prompt: "gold", ai_model: "meshy-6-lite", texture_resolution: "4k" });
  assert.match(text, /meshy-6, meshy-7 or latest/);
  assert.doesNotMatch(text, /7\.1/);
});

test("download saves every Creative Lab part unless a format is asked for", async () => {
  const { createServer } = await import("node:http");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = createServer((req, res) => {
    if (req.url === "/gone.stl") res.statusCode = 404;
    res.end(req.url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshy-dl-"));
  try {
    const lamp = () => ({
      id: "t",
      type: "creative-lab-lamp-build",
      status: "SUCCEEDED",
      model_urls: { glb: `${base}/lamp.glb`, lamp_stl: `${base}/lamp.stl`, base_stl: `${base}/base.stl` },
    });
    const h = createHarness(registerTaskTools, { "/openapi/creative-lab/lamp/v1/build/t": lamp });
    const all = await h.run("meshy_download_model", { task_id: "t", task_type: "creative-lab-lamp-build", save_to: path.join(dir, "all.stl") });
    assert.equal(all.structuredContent.count, 3, JSON.stringify(all));
    const one = await h.run("meshy_download_model", { task_id: "t", task_type: "creative-lab-lamp-build", format: "glb", save_to: path.join(dir, "one.glb") });
    assert.equal(one.structuredContent.format, "glb", JSON.stringify(one));
    assert.equal(fs.readFileSync(path.join(dir, "one.glb"), "utf-8"), "/lamp.glb");

    const partial = createHarness(registerTaskTools, {
      "/openapi/creative-lab/lamp/v1/build/t": () => ({ ...lamp(), model_urls: { glb: `${base}/lamp.glb`, base_stl: `${base}/gone.stl` } }),
    });
    const some = await partial.run("meshy_download_model", { task_id: "t", task_type: "creative-lab-lamp-build", save_to: path.join(dir, "some.stl") });
    assert.equal(some.isError, undefined, JSON.stringify(some));
    assert.equal(some.structuredContent.count, 1);
    assert.deepEqual(some.structuredContent.not_saved.map((n) => [n.part, n.url]), [["base_stl", `${base}/gone.stl`]]);
    assert.match(some.content[0].text, /Not saved/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list_tasks takes the API's task type names and rejects unknown ones", async () => {
  const h = createHarness(registerTaskTools, { "/openapi/v1/rigging": [] });
  const schema = h.schema("meshy_list_tasks");
  assert.equal(schema.parse({ task_type: "rig" }).task_type, "rigging");
  assert.equal(schema.safeParse({ task_type: "nope" }).success, false);
  await h.run("meshy_list_tasks", { task_type: "rig" });
  assert.deepEqual(h.gets.map((g) => g.path), ["/openapi/v1/rigging"]);
});

test("list_models asks only image-to-3d by default and merges the types it is given", async () => {
  const done = (id, created_at, extra = { model_urls: { glb: "u" } }) => ({ id, status: "SUCCEEDED", created_at, ...extra });
  const h = createHarness(registerWorkspaceTools, {
    "/openapi/v1/image-to-3d": [done("i1", 300), done("i2", 100), { id: "i3", status: "FAILED", created_at: 400 }],
    "/openapi/v2/text-to-3d": [done("t1", 200)],
    "/openapi/v1/rigging": [done("r1", 250, { result: { rigged_character_glb_url: "u" } })],
    "/openapi/v1/remesh": () => { throw new Error("down"); },
  });
  const first = await h.run("meshy_list_models", {});
  assert.deepEqual(h.gets.map((g) => g.path), ["/openapi/v1/image-to-3d"]);
  assert.deepEqual(first.structuredContent.models.map((m) => m.id), ["i1", "i2"]);
  assert.equal(first.structuredContent.has_more, false);

  const merged = await h.run("meshy_list_models", { task_types: ["image-to-3d", "text-to-3d", "rig", "remesh"], offset: 1, limit: 2 });
  assert.deepEqual(merged.structuredContent.models.map((m) => [m.id, m.task_type, m.formats.join()]), [
    ["r1", "rigging", "glb"],
    ["t1", "text-to-3d", "glb"],
  ]);
  assert.equal(merged.structuredContent.has_more, true);
  assert.equal(merged.structuredContent.next_offset, 3);
  assert.deepEqual(merged.structuredContent.failed_types, ["remesh"]);
  assert.equal(h.gets.at(-1).query.page_size, 3);
  assert.equal(h.schema("meshy_list_models").safeParse({ task_types: ["text-to-image"] }).success, false);
});

test("task status carries type-specific results and fits its output schema", async () => {
  const { TaskStatusOutputSchema } = await import("../dist/schemas/output.js");
  const split = () => ({ id: "s", type: "print-split", status: "SUCCEEDED", progress: 100, part_count: 4, prompt_ignored: true, model_urls: { glb: "u" }, thumbnail_url: "t" });
  const h = createHarness(registerTaskTools, { "/openapi/v1/print/split/s": split });
  for (const wait of [false, true]) {
    const result = await h.run("meshy_get_task_status", { task_id: "s", task_type: "print-split", wait });
    const out = JSON.parse(JSON.stringify(result.structuredContent));
    assert.equal(out.part_count, 4, JSON.stringify(result));
    assert.equal(out.prompt_ignored, true);
    assert.equal(TaskStatusOutputSchema.strict().safeParse(out).success, true, JSON.stringify(out));
  }
});

test("list_tasks queries the five generation and image types unless told otherwise", async () => {
  const h = createHarness(registerTaskTools, {
    "/openapi/v1/rigging": [{ id: "r", status: "SUCCEEDED", created_at: 2 }],
    "/openapi/v1/print/split": [{ id: "p", status: "FAILED", created_at: 1 }],
  });
  const def = await h.run("meshy_list_tasks", {});
  assert.match(def.content[0].text, /Default types only: printing, rigging/);
  assert.match(def.structuredContent.note, /pass task_types/);
  assert.deepEqual(h.gets.map((g) => g.path).sort(), [
    "/openapi/v1/image-to-3d",
    "/openapi/v1/image-to-image",
    "/openapi/v1/multi-image-to-3d",
    "/openapi/v1/text-to-image",
    "/openapi/v2/text-to-3d",
  ]);
  h.gets.length = 0;
  const both = await h.run("meshy_list_tasks", { task_type: "rig", task_types: ["print-split", "rigging"] });
  assert.deepEqual(h.gets.map((g) => g.path).sort(), ["/openapi/v1/print/split", "/openapi/v1/rigging"]);
  assert.deepEqual(both.structuredContent.tasks.map((t) => [t.id, t.task_type]), [["r", "rigging"], ["p", "print-split"]]);
  assert.equal(h.schema("meshy_list_tasks").safeParse({ task_types: ["nope"] }).success, false);
});

test("a task listed by a sibling route appears once, under its own type", async () => {
  const t2i = { id: "a", type: "text-to-image", status: "SUCCEEDED", created_at: 2 };
  const i2i = { id: "b", type: "image-to-image", status: "SUCCEEDED", created_at: 1 };
  const h = createHarness(registerTaskTools, {
    "/openapi/v1/text-to-image": [t2i, i2i],
    "/openapi/v1/image-to-image": [i2i],
  });
  const both = await h.run("meshy_list_tasks", { task_types: ["text-to-image", "image-to-image"] });
  assert.deepEqual(both.structuredContent.tasks.map((t) => [t.id, t.task_type]), [["a", "text-to-image"], ["b", "image-to-image"]]);
  const one = await h.run("meshy_list_tasks", { task_type: "text-to-image" });
  assert.deepEqual(one.structuredContent.tasks.map((t) => t.id), ["a"]);
});

test("a truncated list continues right after the tasks it showed", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, type: "image-to-3d", status: "SUCCEEDED", created_at: 1000 - i, name: "x".repeat(2000) }));
  const h = createHarness(registerTaskTools, { "/openapi/v1/image-to-3d": many });
  const page = await h.run("meshy_list_tasks", { task_type: "image-to-3d", limit: 40 });
  const shown = page.structuredContent.tasks.length;
  assert.ok(shown < 40, `expected truncation, got ${shown}`);
  assert.equal(page.structuredContent.has_more, true);
  assert.equal(page.structuredContent.next_offset, shown);
});

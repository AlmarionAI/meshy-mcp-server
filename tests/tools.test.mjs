import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPostProcessingTools } from "../dist/tools/postprocessing.js";
import { registerImageTools } from "../dist/tools/image.js";
import { registerCreativeLabTools } from "../dist/tools/creative-lab.js";
import { registerPrintingTools } from "../dist/tools/printing.js";
import { registerConversionTools } from "../dist/tools/conversion.js";
import { registerGenerationTools } from "../dist/tools/generation.js";
import { creativeLabCredits, CreativeLabProduct } from "../dist/constants.js";

// Same offline harness as generation.test.mjs, for the other tool groups.
function createHarness(register) {
  const tools = new Map();
  const requests = [];
  register(
    {
      registerTool(name, config, handler) {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    },
    {
      async post(path, body) {
        requests.push({ path, body });
        return { result: "offline-task-id" };
      },
    },
  );
  return {
    requests,
    async call(name, input) {
      const { schema, handler } = tools.get(name);
      const result = await handler(schema.parse(input));
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return requests.at(-1);
    },
    async invalid(name, input) {
      const { schema, handler } = tools.get(name);
      const result = await handler(schema.parse(input));
      assert.equal(result.isError, true);
      assert.equal(requests.length, 0);
    },
    schema(name) {
      return tools.get(name).schema;
    },
  };
}

test("retexture multi-view sends the explicit meshy-7 the API requires", async () => {
  const { call } = createHarness(registerPostProcessingTools);
  const { body } = await call("meshy_retexture", {
    input_task_id: "offline",
    multiview_image_urls: ["https://example.invalid/front.png"],
  });
  assert.equal(body.ai_model, "meshy-7");
});

test("retexture keeps Meshy UVs by default, leaves uploads and lighting to the API", async () => {
  const { call } = createHarness(registerPostProcessingTools);
  const { body } = await call("meshy_retexture", {
    input_task_id: "offline",
    text_style_prompt: "a".repeat(800),
  });
  assert.equal(body.ai_model, "latest");
  assert.equal(body.enable_original_uv, true);
  assert.equal("remove_lighting" in body, false);
  const { body: upload } = await call("meshy_retexture", {
    model_url: "https://example.invalid/model.glb",
    text_style_prompt: "gold",
  });
  assert.equal("enable_original_uv" in upload, false);
  const { body: optOut } = await call("meshy_retexture", {
    input_task_id: "offline",
    text_style_prompt: "gold",
    enable_original_uv: false,
  });
  assert.equal(optOut.enable_original_uv, false);
  const { body: meshy6 } = await call("meshy_retexture", {
    input_task_id: "offline",
    text_style_prompt: "gold",
    ai_model: "meshy-6",
    remove_lighting: false,
    enable_original_uv: true,
  });
  assert.equal(meshy6.remove_lighting, false);
  assert.equal(meshy6.enable_original_uv, true);
});

test("retexture accepts meshy-6-lite and rejects retired meshy-5", async () => {
  const h = createHarness(registerPostProcessingTools);
  const { body } = await h.call("meshy_retexture", {
    input_task_id: "offline",
    text_style_prompt: "gold",
    ai_model: "meshy-6-lite",
    remove_lighting: true,
  });
  assert.equal(body.ai_model, "meshy-6-lite");
  assert.equal("remove_lighting" in body, false);
  assert.equal(
    h.schema("meshy_retexture").safeParse({ input_task_id: "x", text_style_prompt: "x", ai_model: "meshy-5" }).success,
    false,
  );
});

for (const [label, input] of [
  ["multi-view on meshy-6", { input_task_id: "x", ai_model: "meshy-6", multiview_image_urls: ["https://example.invalid/a.png"] }],
  ["8k on meshy-6-lite", { input_task_id: "x", ai_model: "meshy-6-lite", text_style_prompt: "x", texture_resolution: "8k" }],
]) {
  test(`retexture rejects ${label} before posting`, async () => {
    const { invalid } = createHarness(registerPostProcessingTools);
    await invalid("meshy_retexture", input);
  });
}

test("text-to-image omits aspect_ratio unless set and accepts GPT Image 2.5", async () => {
  const { call } = createHarness(registerImageTools);
  const { body } = await call("meshy_text_to_image", {
    ai_model: "gpt-image-2-5-flare",
    prompt: "a cat",
    generate_multi_view: true,
  });
  assert.equal(body.ai_model, "gpt-image-2-5-flare");
  assert.equal("aspect_ratio" in body, false);
  const { body: wide } = await call("meshy_text_to_image", {
    ai_model: "gpt-image-2",
    prompt: "a cat",
    aspect_ratio: "16:9",
  });
  assert.equal(wide.aspect_ratio, "16:9");
});

test("text-to-image rejects aspect_ratio with multi-view before posting", async () => {
  const { invalid } = createHarness(registerImageTools);
  await invalid("meshy_text_to_image", {
    ai_model: "nano-banana",
    prompt: "a cat",
    generate_multi_view: true,
    aspect_ratio: "1:1",
  });
});

test("creative lab is image-only and lamp is billed 30 + 6", async () => {
  const h = createHarness(registerCreativeLabTools);
  assert.equal(h.schema("meshy_creative_lab").safeParse({ product: "lamp", text: "an owl" }).success, false);
  await h.invalid("meshy_creative_lab", { product: "lamp" });
  assert.deepEqual(creativeLabCredits(CreativeLabProduct.LAMP), { prototype: 30, build: 6, total: 36 });
  assert.deepEqual(creativeLabCredits(CreativeLabProduct.KEYCAP), { prototype: 12, build: 50, total: 62 });
  assert.deepEqual(creativeLabCredits(CreativeLabProduct.FIGURE), { prototype: 6, build: 30, total: 36 });
});

test("print and conversion tools send input_task_id alone when both sources are given", async () => {
  const both = { input_task_id: "offline", model_url: "https://example.invalid/m.glb" };
  const printing = createHarness(registerPrintingTools);
  for (const name of ["meshy_analyze_printability", "meshy_repair_printability", "meshy_process_multicolor"]) {
    const { body } = await printing.call(name, both);
    assert.equal(body.input_task_id, "offline", name);
    assert.equal("model_url" in body, false, name);
  }
  const conversion = createHarness(registerConversionTools);
  for (const [name, extra] of [
    ["meshy_convert", { target_formats: ["stl"] }],
    ["meshy_resize", { resize_height: 1 }],
    ["meshy_uv_unwrap", {}],
  ]) {
    const { body } = await conversion.call(name, { ...both, ...extra });
    assert.equal(body.input_task_id, "offline", name);
    assert.equal("model_url" in body, false, name);
  }
  await createHarness(registerPrintingTools).invalid("meshy_repair_printability", {});
});

test("image prompts have no length cap", async () => {
  const { call } = createHarness(registerImageTools);
  const { body } = await call("meshy_text_to_image", { ai_model: "nano-banana", prompt: "a".repeat(2000) });
  assert.equal(body.prompt.length, 2000);
  const { body: one } = await call("meshy_image_to_image", {
    ai_model: "nano-banana",
    prompt: "x",
    reference_image_urls: ["https://example.invalid/a.png"],
  });
  assert.equal(one.prompt, "x");
});

test("multi-image accepts the deprecated model_type but never sends it", async () => {
  const h = createHarness(registerGenerationTools);
  const input = { image_urls: ["https://example.invalid/a.png"], model_type: "lowpoly" };
  assert.equal(h.schema("meshy_multi_image_to_3d").safeParse(input).success, true);
  const { body } = await h.call("meshy_multi_image_to_3d", input);
  assert.equal("model_type" in body, false);
});

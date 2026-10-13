/**
 * Server-level instructions sent to clients on connection.
 * Provides top-level workflow routing so the agent picks the right tool chain.
 * Specific parameter details and constraints live in each tool's description.
 */

export const MESHY_INSTRUCTIONS = `
# Meshy AI — Workflow Guide

Earlier results: meshy_list_models lists finished 3D models (image-to-3d by default; task_types widens it); meshy_list_tasks lists every task, unfinished ones included.

## Rule 1: Cost Confirmation
Before calling ANY tool that costs credits, present the cost and wait for user confirmation.

| Tool | Credits |
|------|---------|
| meshy_text_to_3d (preview, mesh only) | 20 (meshy-7.1 / latest / meshy-6), 5 (meshy-6-lite, meshy-t2) |
| meshy_text_to_3d_refine | 10 (15 with texture_resolution "8k") |
| meshy_image_to_3d / meshy_multi_image_to_3d | see the generation table below |
| meshy_retexture | 10 (15 with texture_resolution "8k") |
| meshy_remesh | 5 |
| meshy_rig | 5 (includes walking + running) |
| meshy_animate | 3 per action (action_ids: 3 × number of actions) |
| meshy_text_to_motion | 10 (prime) / 3 (swift) |
| meshy_analyze_printability | 0 (free) |
| meshy_repair_printability | 10 |
| meshy_process_multicolor | 10 |
| meshy_auto_split | 10 |
| meshy_convert | 1 |
| meshy_resize | 1 |
| meshy_uv_unwrap | 5 |
| meshy_creative_lab | 36 (6 + 30; lamp is 30 + 6) — EXCEPT keycap 62 (12 + 50) and fidget-collapsible 6 (single stage) |
| meshy_text_to_image / meshy_image_to_image | nano-banana 3 / nano-banana-2 6 / nano-banana-2-lite 3 / nano-banana-2-1 4 / nano-banana-pro 9 / GPT Image models (gpt-image-2, gpt-image-2-5-flare, gpt-image-2-5-sunburst): text 9, image 12 |
| meshy_check_balance / meshy_list_usage / meshy_list_animations / status, list, download | 0 (free) |

### 3D generation cost (image-to-3d / multi-image-to-3d)
| ai_model | mesh only | + 2K/4K texture | + 8K texture |
|---|---|---|---|
| meshy-7.1 / latest | 20 | 30 | 35 |
| meshy-6 | 20 | 30 | 35 |
| meshy-6-lite | 5 | 15 | — (2K only) |
| meshy-t2 (smart-topology, single-image only) | 5 | 15 | 20 |

Ultra geometry (geometry_resolution "2k" or "4k", or the deprecated ultra_mode) adds **+5** on meshy-7.1 / latest. Multi-image takes "2k" but not "4k".
Legacy ids: meshy-7 is deprecated and billed like meshy-7.1; meshy-5 is retired and not accepted (use meshy-6-lite); meshy-t1 is deprecated (use meshy-t2); model_type "lowpoly" is billed like meshy-6 and retires on 2026-10-30 (use smart-topology + meshy-t2).
texture_resolution "8k" costs 5 more than 2K/4K — always confirm it explicitly.

### Current generation routing
Standard text preview, single-image, and multi-image generation take ai_model "latest" (default, = Meshy 7.1), "meshy-7.1", "meshy-6" or "meshy-6-lite". Prefer an explicit model for reproducibility.
Smart Topology uses model_type "smart-topology" with ai_model "meshy-t2" on text preview and single-image generation, not multi-image. T2 directly targets 100–15,000 triangle faces (default 4,000), without remesh/decimation. Text T2 rejects quad topology.
geometry_resolution "standard" / "2k" / "4k" controls geometry detail on standard 7.1/latest; multi-image supports standard/2k only. ultra_mode is deprecated in favor of the 2k pass. Confirm higher-detail cost first.
Standard target_polycount requires should_remesh true and is superseded by decimation_mode. Do not automatically remesh Smart Topology output.
Refine ai_model is optional: omit it to inherit the preview model. T2 is not an explicit refine override.
image_enhancement applies to Meshy 6/7.1/latest. remove_lighting applies to Meshy 6 only, except on multi-image where 7.1/latest honor it too.
Multi-image can drive the texture from 1–4 views of the same object (texture_image_urls, meshy-7.1/latest only).
Prices above match https://docs.meshy.ai/en/api/pricing as of 2026-10-12; point the user there if a number looks off.

## Rule 2: Never Re-create a Task You Are Unsure About
If a create call fails with a timeout, network error or 5xx, the task may still have been created and charged. Check meshy_list_tasks for it before calling the create tool again. When meshy_get_task_status runs out of wait time, the task keeps running on Meshy: call it again with the same task_id instead of starting over. Meshy advises allowing up to 60 minutes from creation.

## Rule 3: Determine Output Format BEFORE Generating
The API parameter target_formats controls which formats are produced. Decide the output format before calling any generation tool, because target_formats must be set at creation time. Ask user about their intended use first.

## Rule 4: Identify the Use Case, Then Confirm with User
Determine which scenario below best matches, present a suggested plan to the user, and confirm before executing. When a request spans several scenarios (e.g. A then L), combine their steps and confirm the combined plan.

---

Each scenario below is a recommended workflow. Discuss with the user to confirm the plan before executing.

## Scenario A: 3D Printing (white model)
Trigger: user mentions print, slicer, figurine, miniature, statue, physical model — single-color.
Suggested flow:
1. Detect installed slicers (meshy_send_to_slicer, slicer_type:"auto") — present list, save for later
2. Generate an untextured model with target_formats:["obj"]: meshy_text_to_3d (preview), or meshy_image_to_3d with should_texture:false
3. Wait for completion
4. Optionally check printability (meshy_analyze_printability, free; pass printer_type and a print size to also check wall thickness). If it reports errors, repair with model_url = the generation task's OBJ URL (model_urls.obj) so the result stays OBJ; repair by input_task_id outputs GLB, which print_ready cannot fix
5. Download the OBJ (the repair task's, if repaired) with print_ready=true and print_height_mm (local Z-up fix and scaling)
6. Present slicer list from step 1, ask user which to use, execute launch_command via Bash
If the model must be printed in pieces (too big for the bed, separate colors or materials), use Scenario L.

## Scenario B: 3D Printing (multicolor)
Trigger: user wants multicolor/color print.
Suggested flow:
1. Detect multicolor-capable slicers (meshy_send_to_slicer, is_multicolor:true) — present list, save for later
2. Generate a textured model — image-to-3d / multi-image-to-3d (textured by default), or text-to-3d preview + refine
3. Multi-color processing (meshy_process_multicolor) with input_task_id from the textured task — 10 credits, outputs 3MF. Ask for style (realistic / cartoon) and printer_brand (writes that brand's slicer preset; default bambu)
4. Wait for completion (task_type:"multi-color-print")
5. Download with format "3mf"
6. Present slicer list from step 1, ask user which to use, execute launch_command via Bash

## Scenario C: Game Engine (Unity/Unreal/Godot)
Trigger: user mentions game, Unity, Unreal, Godot, game-ready.
Suggested flow:
1. Generate model with target_formats:["fbx"]
2. Textures: image-to-3d / multi-image output is already textured (unless should_texture:false); a text-to-3d preview needs meshy_text_to_3d_refine
3. Inspect topology and face count. Smart Topology may already meet the budget; remesh only if needed and separately approved
4. Download FBX

## Scenario D: Character Animation
Trigger: user mentions rig, animate, walking, running, character animation.
Suggested flow:
1. Generate model with pose_mode:"t-pose"
2. Textures (rigging needs a textured humanoid): image-to-3d / multi-image output is already textured (unless should_texture:false); a text-to-3d preview needs meshy_text_to_3d_refine
3. Rig the model (meshy_rig, ≤300K faces; if over, remesh to reduce polycount first)
4. Download — rigging includes walking+running free, as separate files. For other actions use meshy_animate:
   - preset actions: look up action ids with meshy_list_animations (free) — never guess ids. action_ids puts up to 10 clips in one file (3 credits each; include the walk/run ids to bundle them too)
   - a described motion ("a backflip into a crouch"): meshy_text_to_motion (prime 10 / swift 3 credits), then meshy_animate with motion_task_id (biped rigs only)

## Scenario E: AR / Apple
Trigger: user mentions AR, USDZ, Vision Pro, Quick Look.
Suggested flow:
1. Generate model with target_formats:["usdz"]
2. Textures: image-to-3d / multi-image output is already textured (unless should_texture:false); a text-to-3d preview needs meshy_text_to_3d_refine
3. If the model has no USDZ yet, convert it (meshy_convert, target_formats:["usdz"], 1 credit)
4. Download USDZ

## Scenario F: Retexture
Trigger: user wants to change textures/style of existing model.
Suggested flow:
1. Ask the user for EXACTLY ONE style input — they are mutually exclusive:
   - text_style_prompt (a description of the style), or
   - image_style_url (one image used as a STYLE reference), or
   - multiview_image_urls (1–4 photos OF THE SAME OBJECT from different angles; runs on Meshy 7, not meshy-6 / meshy-6-lite)
2. Apply retexture (meshy_retexture)

## Scenario H: Cheap Format Conversion / Resize
Trigger: user has an existing model (task or URL) and only needs another file format, or wants it scaled to real-world dimensions — no re-generation.
Suggested flow:
1. Format only → meshy_convert with target_formats (1 credit). Cheaper than remesh for format-only changes; supports 3mf.
2. Real-world size → meshy_resize (1 credit) with exactly one of resize_height / resize_longest_side / auto_size.
3. Wait for completion (task_type "convert" / "resize"), then meshy_download_model.

## Scenario I: UV Unwrap (before external texturing)
Trigger: user wants to texture a model in Blender / Substance Painter / Unreal, or needs a clean UV layout / "UV white model".
Suggested flow:
1. Ensure the source is a GLB with ≤40,000 faces — if denser, run meshy_remesh with a lower target_polycount first.
2. meshy_uv_unwrap (5 credits) with input_task_id or model_url.
3. Wait for completion (task_type "uv-unwrap"), then meshy_download_model (format "glb"). The output is a single GLB with fresh UVs and a placeholder material.

## Scenario J: Creative Lab Consumer Products (9 products)
Trigger: user wants a stylized physical-product model from a photo — chibi figure, vinyl figure, brick minifigure, keychain, fridge magnet, keycap, lamp, pixel-art fidget board, or collapsible ring fidget. Every product needs a photo; none take a text prompt.
Suggested flow:
1. Confirm the cost: 36 credits for figure / vinyl-figure / brick-figure / keychain / fridge-magnet / lamp / fidget-pixel, **62 for keycap**, **6 for fidget-collapsible**.
2. Call meshy_creative_lab once with product + an image source (file_path / image_url). It runs the whole pipeline internally and returns the final 3D model — the intermediate concept image is internal and is NOT shown to the user. Product options: keychain name_text (engraving, ≤10 characters); fidget-pixel pixel_subject (person / other, required); keycap head_size_mm / vertical_offset_mm; build_options and output_format for keychain, fridge-magnet, lamp and fidget-pixel.
3. Download the result with meshy_download_model and the task_type the tool reports; omit format to save every part (e.g. lamp + base STLs).

## Scenario K: Cleaner Topology / Part-Separated Geometry (cheaply)
Trigger: user wants an editable, part-separated, or lower-poly model from an image or text.
Suggested flow:
1. Confirm current T2 cost, face target, and whether textures are wanted.
2. Call meshy_image_to_3d or meshy_text_to_3d with model_type:"smart-topology", ai_model:"meshy-t2", and target_polycount (100–15,000). Set should_texture false on the image route when only geometry is approved.
3. Text preview produces an untextured mesh; separately confirm refine before texturing. Do not force a refine model override.
4. Multi-image does not offer Smart Topology. Deprecated lowpoly is not the preferred route.

## Scenario L: Print in Parts (Auto Split)
Trigger: model is too big for the print bed, or parts should be printed separately / in different colors and assembled.
Suggested flow:
1. Source must be a SUCCEEDED image-to-3d, multi-image-to-3d, text-to-3d preview, remesh, convert or resize task on Meshy 6 / 7 / 7.1 (not low-poly or Smart Topology).
2. Confirm 10 credits and how to cut: mode "auto", "by_parts" with a prompt naming 1–10 parts, or "by_color" (image-to-3d / multi-image-to-3d sources only). There is no bed-size parameter: resize to the print size first if parts must fit a bed. Offer connectors so the pieces fit together, layout "on_plate" for print-ready placement, and target_formats ["3mf"] for separately selectable parts in a slicer.
3. meshy_auto_split, wait (task_type "print-split"), meshy_download_model, then open the file in a slicer (meshy_send_to_slicer).

## Scenario G: General 3D Model (default)
Trigger: none of the above.
Suggested flow:
1. Ask user about intended use to determine format
2. From text, offer the image route (meshy_text_to_image → user approves the image → meshy_image_to_3d with input_task_id; textured in one task), or a quick meshy_text_to_3d preview (+ meshy_text_to_3d_refine for textures)
3. Download in chosen format
`;

/**
 * Zod schemas for post-processing tools (remesh, retexture, rig, animate)
 */

import { z } from "zod";
import { AIModel, OriginAt, TextureResolution, Topology, AnimationPostProcessOp } from "../constants.js";
import { ResponseFormatSchema, UrlSchema } from "./common.js";

/**
 * Remesh input schema
 */
export const RemeshInputSchema = z.object({
  input_task_id: z.string()
    .min(1)
    .optional()
    .describe("ID of a SUCCEEDED text-to-3d (preview or refine), image-to-3d or retexture task to remesh"),
  model_url: UrlSchema
    .optional()
    .describe("Public URL of a model to remesh (.glb / .gltf / .obj / .fbx / .stl, max 100 MB), or a GLB data URI"),
  target_formats: z.array(z.enum(["glb", "fbx", "obj", "usdz", "blend", "stl", "3mf"]))
    .default(["glb"])
    .describe("Output formats to generate (default: ['glb']): glb, fbx, obj, usdz, blend, stl, 3mf. 3MF is only produced when listed."),
  topology: z.nativeEnum(Topology)
    .optional()
    .describe("Mesh topology type (quad or triangle)"),
  target_polycount: z.number()
    .int()
    .min(100, "Polycount must be at least 100")
    .max(300000, "Polycount cannot exceed 300,000")
    .optional()
    .describe("Target polygon count for the remeshed model (100–300,000)"),
  decimation_mode: z.number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Adaptive decimation polycount level (1=ultra, 2=high, 3=medium, 4=low). When set, target_polycount is ignored."),
  resize_height: z.number()
    .optional()
    .describe("DEPRECATED — use meshy_resize. Resize the model to this height in meters. Not combinable with auto_size."),
  resize_longest_side: z.number()
    .optional()
    .describe("DEPRECATED — use meshy_resize. Resize so the longest side matches this value in meters."),
  auto_size: z.boolean()
    .optional()
    .describe("DEPRECATED — use meshy_resize. Estimate the real-world height with AI and resize to it."),
  origin_at: z.nativeEnum(OriginAt)
    .optional()
    .describe("DEPRECATED — use meshy_resize. Origin position: 'bottom' or 'center'."),
  convert_format_only: z.boolean()
    .optional()
    .describe("DEPRECATED — use meshy_convert (1 credit instead of 5). Only change the file format, ignoring remesh options."),
  alpha_thumbnail: z.boolean()
    .optional()
    .describe("Also render a transparent-background (RGBA) preview, returned as alpha_thumbnail_url. Default false."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Retexture input schema
 */
export const RetextureInputSchema = z.object({
  input_task_id: z.string()
    .min(1)
    .optional()
    .describe("Task ID of an existing completed task to retexture"),
  model_url: UrlSchema
    .optional()
    .describe("Direct URL to a model file to retexture"),
  text_style_prompt: z.string()
    .max(800, "Prompt must not exceed 800 characters")
    .optional()
    .describe("Text prompt describing the desired texture style. Max 800 characters. Mutually exclusive with image_style_url and multiview_image_urls — provide exactly one style input."),
  image_style_url: UrlSchema
    .optional()
    .describe("URL of a SINGLE image to use as texture style reference. Mutually exclusive with text_style_prompt and multiview_image_urls."),
  multiview_image_urls: z.array(UrlSchema)
    .min(1, "Provide at least 1 view")
    .max(4, "At most 4 views are accepted")
    .optional()
    .describe("1–4 ordered views OF THE SAME OBJECT (not style references) — element 0 is the primary reference and alone drives the metallic/roughness prediction. Runs on Meshy 7 (the tool sends ai_model 'meshy-7' for you when ai_model is 'latest'). Mutually exclusive with text_style_prompt and image_style_url."),
  ai_model: z.enum([AIModel.MESHY_6_LITE, AIModel.MESHY_6, AIModel.MESHY_7, AIModel.LATEST])
    .default(AIModel.LATEST)
    .describe("AI model: 'latest' (default, = Meshy 7), 'meshy-7', 'meshy-6', or 'meshy-6-lite' (fast, 2K textures only). No meshy-7.1 on retexture. multiview_image_urls needs Meshy 7. Texturing costs 10 credits at 2K/4K, 15 at 8K."),
  enable_original_uv: z.boolean()
    .optional()
    .describe("Keep the model's existing UV layout instead of unwrapping fresh UVs. Default: true with input_task_id (Meshy-generated UVs are reused), API default false with model_url (fresh unwrap, safest for uploads without good UVs)."),
  enable_pbr: z.boolean()
    .default(false)
    .describe("Enable physically-based rendering textures"),
  texture_resolution: z.nativeEnum(TextureResolution)
    .optional()
    .describe("Base color texture resolution: '2k' (default), '4k', or '8k'. 8K costs 15 credits instead of 10 — confirm with the user before selecting it. 4k/8k need meshy-6 / meshy-7 / latest (not meshy-6-lite); at 8k the PBR maps are 4K and there is no emission map. Replaces the deprecated hd_texture flag."),
  hd_texture: z.boolean()
    .optional()
    .describe("DEPRECATED — use texture_resolution instead (hd_texture: true is exactly texture_resolution: '4k'). Kept for backward compatibility."),
  remove_lighting: z.boolean()
    .optional()
    .describe("Removes highlights and shadows from the base color texture for cleaner results under custom lighting. Only honored on meshy-6 (API default true there); not sent for other models."),
  target_formats: z.array(z.enum(["glb", "obj", "fbx", "stl", "usdz", "3mf"]))
    .optional()
    .describe("Output formats to generate. When omitted, produces glb/obj/fbx/stl/usdz but NOT 3mf. To get 3MF, you MUST include '3mf' explicitly."),
  alpha_thumbnail: z.boolean()
    .optional()
    .describe("Also render a transparent-background (RGBA) preview, returned as alpha_thumbnail_url. Default false."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Rig (rigging) input schema
 */
export const RigInputSchema = z.object({
  input_task_id: z.string()
    .min(1)
    .optional()
    .describe("Task ID of an existing completed task to rig"),
  model_url: UrlSchema
    .optional()
    .describe("Direct URL to a model file to rig"),
  height_meters: z.number()
    .default(1.7)
    .describe("Height of the character in meters (default: 1.7)"),
  texture_image_url: UrlSchema
    .optional()
    .describe("URL of a texture image to apply to the model"),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Animate input schema
 */
export const AnimateInputSchema = z.object({
  rig_task_id: z.string()
    .min(1, "Rig task ID is required")
    .describe("Task ID of the completed rigging task to animate"),
  action_id: z.number()
    .int("Action ID must be an integer")
    .optional()
    .describe("One preset action from the animation library (look ids up with meshy_list_animations). Give exactly one of action_id, action_ids, motion_task_id."),
  action_ids: z.array(z.number().int())
    .min(1)
    .max(10)
    .refine(ids => new Set(ids).size === ids.length, "action_ids must be unique")
    .optional()
    .describe("1–10 unique preset action ids, returned as ONE file with one clip per action (in this order) — e.g. for a game-engine state machine. 3 credits per action."),
  motion_task_id: z.string()
    .min(1)
    .optional()
    .describe("A SUCCEEDED meshy_text_to_motion task whose clip to apply (biped rigs only; apply it within 3 days, before the clip expires)."),
  post_process: z.object({
    operation_type: z.nativeEnum(AnimationPostProcessOp)
      .describe("Post-processing operation to apply"),
    fps: z.union([
      z.literal(24),
      z.literal(25),
      z.literal(30),
      z.literal(60)
    ])
      .optional()
      .describe("Target FPS for change_fps operation")
  })
    .optional()
    .describe("Optional post-processing to apply after animation"),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Text-to-motion input schema
 */
export const TextToMotionInputSchema = z.object({
  prompt: z.string()
    .min(1, "Prompt is required")
    .max(400, "Prompt must not exceed 400 characters")
    .describe("Natural-language description of the motion, e.g. 'a character jumps over a gap and lands in a crouch'. Max 400 characters."),
  duration: z.number()
    .min(2, "Duration must be at least 2 seconds")
    .max(10, "Duration cannot exceed 10 seconds")
    .multipleOf(0.5, "Duration must be a multiple of 0.5 seconds")
    .describe("Clip length in seconds: 2–10 in steps of 0.5."),
  mode: z.enum(["prime", "swift"])
    .optional()
    .describe("'prime' (API default): highest quality, FBX, 10 credits. 'swift': faster and cheaper, BVH, 3 credits."),
  response_format: ResponseFormatSchema
}).strict();

/**
 * Animation library lookup input schema
 */
export const ListAnimationsInputSchema = z.object({
  search: z.string()
    .min(1)
    .optional()
    .describe("Case-insensitive substring of the animation name or key, e.g. 'walk', 'punch', 'dance'."),
  category: z.enum(["WalkAndRun", "BodyMovements", "DailyActions", "Fighting", "Dancing"])
    .optional()
    .describe("Only this category."),
  sub_category: z.string()
    .min(1)
    .optional()
    .describe("Only this sub-category, e.g. 'AttackingwithWeapon'. Names repeat across categories, so pair it with category to be exact."),
  action_ids: z.array(z.number().int())
    .min(1)
    .max(200)
    .optional()
    .describe("Resolve these ids (up to 200); ids that no longer exist are simply absent."),
  response_format: ResponseFormatSchema
}).strict();


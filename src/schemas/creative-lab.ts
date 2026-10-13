/**
 * Zod schema for the Creative Lab tool (one tool covering every public
 * Creative Lab product).
 *
 * Most products run two stages — prototype (concept image) then build (3D
 * model). This tool runs both, hides the intermediate concept image, and
 * returns only the final 3D product. Collapsible Fidget is a single stage.
 *
 * Cost: see creativeLabCredits(). Every product is image-only.
 */

import { z } from "zod";
import { CreativeLabProduct, KEYCAP_BASE_MODEL } from "../constants.js";
import { ResponseFormatSchema } from "./common.js";

/** Build output formats per product (`output.format`); products not listed take none. */
export const CREATIVE_LAB_OUTPUT_FORMATS: Partial<Record<CreativeLabProduct, readonly string[]>> = {
  [CreativeLabProduct.KEYCHAIN]: ["glb", "obj", "zip"],
  [CreativeLabProduct.FRIDGE_MAGNET]: ["glb", "obj", "zip"],
  [CreativeLabProduct.LAMP]: ["stl", "zip"],
  [CreativeLabProduct.FIDGET_PIXEL]: ["3mf"]
};

/** Products whose build stage takes an `options` object. */
export const CREATIVE_LAB_OPTION_PRODUCTS: readonly CreativeLabProduct[] = [
  CreativeLabProduct.KEYCHAIN,
  CreativeLabProduct.FRIDGE_MAGNET,
  CreativeLabProduct.LAMP,
  CreativeLabProduct.FIDGET_PIXEL,
  CreativeLabProduct.KEYCAP
];

export const CreativeLabInputSchema = z.object({
  product: z.nativeEnum(CreativeLabProduct)
    .describe("The product (see the tool description for costs)."),
  image_url: z.string()
    .optional()
    .describe("Public URL or data URI of the photo (.jpg/.jpeg/.png/.webp). For local files use file_path."),
  file_path: z.string()
    .optional()
    .describe("Absolute path to a local photo; the server encodes it."),
  image_subject: z.enum(["character", "landscape"])
    .optional()
    .describe("Lamp only: what the photo shows."),
  pixel_subject: z.enum(["person", "other"])
    .optional()
    .describe("fidget-pixel only, REQUIRED: 'person' → chibi pixel sprite; 'other' (pets, objects, logos, landscapes) → bead-art icon."),
  name_text: z.string()
    .refine(text => [...text.trim()].length <= 10, "name_text must be at most 10 characters")
    .optional()
    .describe("Keychain only: text to engrave, ≤10 characters (CJK count one each)."),
  head_size_mm: z.number()
    .min(10, "head_size_mm must be at least 10")
    .max(40, "head_size_mm cannot exceed 40")
    .optional()
    .describe("Keycap only: the head's LONGEST edge in mm (default 23), not its height."),
  vertical_offset_mm: z.number()
    .min(-5, "vertical_offset_mm must be at least -5")
    .max(5, "vertical_offset_mm cannot exceed 5")
    .optional()
    .describe("Keycap only: raise (+) or lower (-) the head on the base, in mm (default 0)."),
  base_model: z.literal(KEYCAP_BASE_MODEL)
    .optional()
    .describe("Keycap only: base profile (Cherry MX 1u)."),
  build_options: z.record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Build options (the API checks ranges). Keychain / fridge-magnet: badge_shape (circle|rounded-rect|hexagon|shield|star), size_mm, relief_height_mm, relief_offset_mm, base_thickness_mm, has_closed_back, relief_curve (linear|gamma|s-curve), curve_param, invert_depth, smoothing, relief_scale, depth_threshold, remove_background, export_resolution. Lamp: diameter_mm (50–400), thickness_mm, cut_amount_percent, light_source_preset (bambu_mh001_60mm|none), fixture_offset_x_mm, fixture_offset_z_mm, rotate_x_deg, rotate_y_deg, rotate_z_deg, include_result_json. Fidget pixel: shape (square|hex), grid_size (16|32), piece_size_mm (6|8|10; hex 6|8), color_count (1–8), piece_height_mm (10–80). Other products take none."),
  output_format: z.enum(["glb", "obj", "zip", "stl", "3mf"])
    .optional()
    .describe("Keychain / fridge-magnet: glb (default), obj (zip of OBJ + MTL + texture) or zip (everything). Lamp: stl (default) or zip. Fidget pixel: 3mf. Others: none."),
  name: z.string()
    .max(100, "Name must not exceed 100 characters")
    .optional()
    .describe("Display name for the task; not engraved (see name_text)."),
  timeout_seconds: z.number()
    .int()
    .min(30, "Timeout must be at least 30 seconds")
    .max(600, "Timeout cannot exceed 600 seconds")
    .default(300)
    .describe("Max wait per stage in seconds; a longer stage keeps running (check it with meshy_get_task_status)."),
  response_format: ResponseFormatSchema
}).strict();

/** Product-specific argument checks; returns an error message or null. */
export function checkCreativeLabParams(params: z.infer<typeof CreativeLabInputSchema>): string | null {
  const { product } = params;
  if (product === CreativeLabProduct.FIDGET_PIXEL && !params.pixel_subject) {
    return "fidget-pixel needs pixel_subject: 'person' or 'other'.";
  }
  const onlyFor: [unknown, CreativeLabProduct, string][] = [
    [params.image_subject, CreativeLabProduct.LAMP, "image_subject"],
    [params.pixel_subject, CreativeLabProduct.FIDGET_PIXEL, "pixel_subject"],
    [params.name_text, CreativeLabProduct.KEYCHAIN, "name_text"],
    [params.head_size_mm, CreativeLabProduct.KEYCAP, "head_size_mm"],
    [params.vertical_offset_mm, CreativeLabProduct.KEYCAP, "vertical_offset_mm"],
    [params.base_model, CreativeLabProduct.KEYCAP, "base_model"]
  ];
  for (const [value, owner, field] of onlyFor) {
    if (value !== undefined && product !== owner) return `${field} is for ${owner} only.`;
  }
  if (params.build_options && !CREATIVE_LAB_OPTION_PRODUCTS.includes(product)) {
    return `${product} takes no build_options.`;
  }
  if (params.output_format) {
    const formats = CREATIVE_LAB_OUTPUT_FORMATS[product];
    if (!formats?.includes(params.output_format)) {
      return formats
        ? `${product} output_format must be one of: ${formats.join(", ")}.`
        : `${product} takes no output_format.`;
    }
  }
  return null;
}

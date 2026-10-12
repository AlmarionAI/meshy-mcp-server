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
    .describe("Creative Lab product: 'figure' (chibi collectible), 'lamp' (3D-printable lampshade), 'keychain', 'fridge-magnet', 'vinyl-figure' (vinyl-toy style), 'brick-figure' (brick-minifigure style), 'keycap' (Cherry MX 1u keycap — 62 credits), 'fidget-pixel' (pixel-art board of interlocking pieces, 3MF) or 'fidget-collapsible' (nested-ring collapsible fidget, single stage, 6 credits)."),
  image_url: z.string()
    .optional()
    .describe("PUBLIC image URL or data URI of the source photo (.jpg/.jpeg/.png/.webp). For local files use file_path instead."),
  file_path: z.string()
    .optional()
    .describe("ABSOLUTE path to a LOCAL source photo (.jpg/.jpeg/.png/.webp). PREFERRED for local files; the server auto-encodes it."),
  image_subject: z.enum(["character", "landscape"])
    .optional()
    .describe("Lamp only: subject type of the input image, 'character' or 'landscape'."),
  pixel_subject: z.enum(["person", "other"])
    .optional()
    .describe("Fidget pixel only, REQUIRED: what the photo shows. 'person' makes a chibi pixel sprite; 'other' (pets, objects, logos, landscapes) makes a bead-art pixel icon."),
  name_text: z.string()
    .refine(text => [...text.trim()].length <= 10, "name_text must be at most 10 characters")
    .optional()
    .describe("Keychain only: text to engrave, e.g. a name. At most 10 characters (CJK counts one per character). Omit for no engraving."),
  head_size_mm: z.number()
    .min(10, "head_size_mm must be at least 10")
    .max(40, "head_size_mm cannot exceed 40")
    .optional()
    .describe("Keycap only: scales the head's LONGEST edge to this many millimetres (10–40, default 23). This is NOT the height above the base."),
  vertical_offset_mm: z.number()
    .min(-5, "vertical_offset_mm must be at least -5")
    .max(5, "vertical_offset_mm cannot exceed 5")
    .optional()
    .describe("Keycap only: raise (+) or lower (-) the head before it is seated on the base, in mm (-5 to 5, default 0)."),
  base_model: z.literal(KEYCAP_BASE_MODEL)
    .optional()
    .describe(`Keycap only: keycap base profile. '${KEYCAP_BASE_MODEL}' (Cherry MX 1u) is the only value supported today.`),
  build_options: z.record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Build-stage options, sent as the API's `options` object (the API checks ranges). Keychain / fridge-magnet: badge_shape (circle|rounded-rect|hexagon|shield|star), size_mm, relief_height_mm, relief_offset_mm, base_thickness_mm, has_closed_back, relief_curve (linear|gamma|s-curve), curve_param, invert_depth, smoothing, relief_scale, depth_threshold, remove_background, export_resolution. Lamp: diameter_mm (50–400), thickness_mm, cut_amount_percent, light_source_preset (bambu_mh001_60mm|none), fixture_offset_x_mm, fixture_offset_z_mm, rotate_x_deg, rotate_y_deg, rotate_z_deg, include_result_json. Fidget pixel: shape (square|hex), grid_size (16|32), piece_size_mm (6|8|10; hex 6|8 only), color_count (1–8), piece_height_mm (10–80). Keycap: use head_size_mm / vertical_offset_mm / base_model instead. Other products take no options."),
  output_format: z.enum(["glb", "obj", "zip", "stl", "3mf"])
    .optional()
    .describe("Build output, sent as `output.format`. Keychain / fridge-magnet: glb (default), obj (zip of OBJ + MTL + texture) or zip (every artifact). Lamp: stl (default; lamp_stl + base_stl) or zip. Fidget pixel: 3mf only. Other products take no output format."),
  name: z.string()
    .max(100, "Name must not exceed 100 characters")
    .optional()
    .describe("Optional display name for the task (≤100 chars). Not engraved on anything — use name_text for a keychain engraving."),
  timeout_seconds: z.number()
    .int()
    .min(30, "Timeout must be at least 30 seconds")
    .max(600, "Timeout cannot exceed 600 seconds")
    .default(300)
    .describe("Max seconds to wait for EACH stage (prototype, then build) before returning. Default 300. A stage that runs longer keeps running; check it with meshy_get_task_status."),
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

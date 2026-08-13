import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  AlignCenter,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  Check,
  ClipboardCheck,
  Crop,
  ExternalLink,
  EyeOff,
  FileImage,
  FileText,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import type {
  ExtractedSpec,
  SourceImage,
  TechnicalSpec,
} from "@workspace/api-client-react";
import { Card, Badge, Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/http";
import { draftKey, loadDraft, saveDraft } from "@/lib/draft-store";
import { toast } from "sonner";

type OverviewRow = {
  id: string;
  label: string;
  value: string;
  // false = kept in the optional pool (not shown on the sheet) until the user opts to include it.
  // undefined is treated as included (backward-compatible with older saved drafts).
  included?: boolean;
  // true once the user has hand-edited this value — auto-recompute (Efficacy/Power) then leaves it
  // alone so a manual override sticks instead of being overwritten on every render.
  manual?: boolean;
};

// ---- Page 2: Product Specifications ----
type SpecOption = { power: string; lumen: string };
type SpecGroup = {
  id: string;
  partNumber: string;
  sku: string;
  options: SpecOption[];
  voltage: string;
  efficacy: string;
  cri: string;
  current: string;
  cct: string;
  thd: string;
  lightDistribution: string;
  // Per-variant values for user-inserted custom spec columns, keyed by the column's field id.
  extra?: Record<string, string>;
};

// A spec-table column: a built-in (fixed data field) or a user-inserted custom column. Order in the
// list = column order, so a custom column can be inserted BETWEEN any two.
type SpecColumn = {
  id: string;
  label: string;
  unit: string;
  hidden?: boolean;
  // Built-in fields drive their own data; "custom:<id>" columns read/write group.extra[field].
  field:
    | "partNumber" | "power" | "voltage" | "lumen" | "efficacy" | "cri" | "cct" | "thd" | "lightDistribution"
    | `custom:${string}`;
  scope: "group" | "option"; // group = one value per variant (rowSpan); option = per power row
};

// ---- Page 3: Product Ordering Information (part-number decoder) ----
type OrderingGroupId = "family" | "performance" | "construction";
type OrderingEntry = { code: string; description: string };
type OrderingColumn = {
  id: string;
  group: OrderingGroupId;
  header: string;
  unit: string;
  entries: OrderingEntry[];
};

// ---- Page 3: Accessories Ordering Information ----
type AccessoryRow = {
  id: string;
  code: string;
  description: string;
  imageId: string | null;
  downloadUrl: string;
};

// ---- Page 4: Dimensions ----
type DimensionItem = {
  id: string;
  label: string;
  imageId: string | null;
  width: string;
  height: string;
  depth: string;
};

// A user-added custom section: a heading plus text (one point per line) and/or an image.
type CustomSection = {
  id: string;
  heading: string;
  bodyText: string;
  imageId: string | null;
};

// An extra vendor table (photometric/performance/etc.) captured verbatim and shown at the end.
type ExtraTable = {
  id: string;
  title: string;
  headers: string[];
  rows: string[][];
};

const ORDERING_GROUP_LABELS: Record<OrderingGroupId, string> = {
  family: "Luminaire Family",
  performance: "Electrical / Lighting Performance",
  construction: "Construction",
};

function createDefaultOrderingColumns(): OrderingColumn[] {
  const columns: Array<Omit<OrderingColumn, "id" | "entries">> = [
    { group: "family", header: "Brand", unit: "" },
    { group: "family", header: "Family/Version", unit: "" },
    { group: "family", header: "Size", unit: "" },
    { group: "performance", header: "Power", unit: "W" },
    { group: "performance", header: "Voltage", unit: "V" },
    { group: "performance", header: "Dimming", unit: "" },
    { group: "performance", header: "CCT", unit: "K" },
    { group: "performance", header: "Distribution", unit: "" },
    { group: "performance", header: "Driver", unit: "" },
    { group: "construction", header: "Finish", unit: "" },
    { group: "construction", header: "Manufacturer", unit: "" },
  ];
  return columns.map((column, index) => ({
    ...column,
    id: `ordering-col-${index}`,
    entries: [{ code: "", description: "" }],
  }));
}

type SourcePage = {
  id: string;
  page: number;
  width: number;
  height: number;
  dataUrl: string;
};

type ExtractedCodeEntry = { code?: string; description?: string };
type ExtractedDimension = { label?: string; width?: string; height?: string; depth?: string };

type ExtendedExtractedSpec = ExtractedSpec & {
  productCategory?: string;
  subCategory?: string;
  isProductFamily?: boolean;
  categorySpecificSpecs?: TechnicalSpec[];
  variantOverview?: {
    parameters: string[];
    matrix: string[][];
  };
  variants?: Record<string, unknown>[];
  sourcePages?: SourcePage[];
  sourceText?: string;
  orderingInfo?: Record<string, ExtractedCodeEntry[]>;
  orderingExample?: string;
  accessories?: ExtractedCodeEntry[];
  dimensions?: ExtractedDimension[];
  extraTables?: { title?: string; headers?: string[]; rows?: string[][] }[];
  diagramSections?: { title?: string; caption?: string }[];
};

type QualificationBadgeId =
  | "dlc_premium"
  | "dlc_listed"
  | "energy_star"
  | "etl"
  | "c_ulus"
  | "wet_location"
  | "dimmable"
  | "sensors"
  | "power_selectable"
  | "cct_selectable"
  | "rohs";

type EditorDraft = {
  headerProjectName: string;
  headerCatNumber: string;
  headerFixtureSchedule: string;
  headerNote: string;
  footerNote: string;
  title: string;
  subtitle: string;
  categoryLabel: string;
  subCategory: string;
  // Set once the user edits Category / Sub-category by hand. Persisted with the draft so the fixture
  // auto-prediction never re-fills a field you've taken control of — even after a refresh.
  categoryTouched?: boolean;
  subCategoryTouched?: boolean;
  skuNumber: string;
  overviewRows: OverviewRow[];
  // Overview text size on the sheet: null = auto-fit to the box; a number = manual px override.
  overviewFontPx: number | null;
  description: string;
  featuresText: string;
  applicationAreasText: string;
  certificationsText: string;
  warrantyLabel: string;
  warrantyCopy: string;
  manualSourceImages: SourceImage[];
  selectedImageId: string | null;
  editedImageDataUrls: Record<string, string>;
  // Which section each manual image belongs to: "product" | `accessory:<id>` | `dimension:<id>`.
  imageOwners: Record<string, string>;
  selectedQualificationIds: QualificationBadgeId[];
  // Page 2 — Product Specifications
  specGroups: SpecGroup[];
  // Ordered spec-table columns (built-ins + any inserted custom columns), each with editable
  // label/unit/visibility. Absent on older drafts → the defaults are used.
  specColumns?: SpecColumn[];
  specsNote: string;
  // Page 3 — Product Ordering Information + Accessories
  orderingExample: string;
  orderingColumns: OrderingColumn[];
  // Chosen code per ordering column (columnId -> code). Single-option columns are
  // auto-resolved; multi-option columns use the user's selection.
  orderingSelection: Record<string, string>;
  orderingNote: string;
  accessoryRows: AccessoryRow[];
  // Page 4 — Dimensions
  dimensionItems: DimensionItem[];
  // User-added custom sections (extra page): heading + text points and/or image.
  customSections: CustomSection[];
  // Extra vendor tables (photometric/performance/etc.) captured verbatim, shown at the end.
  extraTables: ExtraTable[];
  // Per-image manual placement on the sheet (keyed by source-image id): the user can drag ANY sheet
  // image (product, dimensions, accessories, custom sections) around its box and resize it. An
  // absent id = centered at 100% (default).
  imagePlacements: Record<string, ImagePlacement>;
  // Predefined sheet sections the user has removed (key -> true = hidden). Hiding a section drops it
  // AND its page(s) from the preview/PDF. Absent/false = shown. See SHEET_SECTION_TOGGLES.
  hiddenSections?: Record<string, boolean>;
};

// The predefined sheet sections the user can remove (each hides the section and its page(s)). Page-1
// blocks (overview/description/features/…) key off "page1:<id>"; the standalone pages use their block
// group. The Overview and the header/footer are core and intentionally not removable.
const SHEET_SECTION_TOGGLES: { key: string; label: string }[] = [
  { key: "page1:description", label: "Product Description" },
  { key: "page1:features", label: "Features" },
  { key: "page1:applications", label: "Application Areas" },
  { key: "page1:warranty", label: "Warranty" },
  { key: "specs", label: "Product Specifications" },
  { key: "ordering", label: "Product Ordering Information" },
  { key: "dims", label: "Dimensions" },
  { key: "accessories", label: "Accessories Ordering Information" },
];

function isSectionHidden(draft: EditorDraft, key: string): boolean {
  return Boolean(draft.hiddenSections?.[key]);
}

// Manual placement of a sheet image: translate offset (px, relative to its centered position in the
// preview) plus a scale multiplier. Applied as a CSS transform so it carries into the PDF export
// unchanged.
type ImagePlacement = {
  x: number;
  y: number;
  scale: number;
  // Fit within the image's slot (via object-position). Absent = centered on that axis.
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
};

const DEFAULT_IMAGE_PLACEMENT: ImagePlacement = { x: 0, y: 0, scale: 1 };

// Shared editing context so EVERY sheet image (across all pages/sections) can be dragged/resized
// without threading callbacks through each render helper. Provided once at the SheetPreview root.
type SheetImageEditing = {
  placements: Record<string, ImagePlacement>;
  editable: boolean;
  onChange?: (imageId: string, placement: ImagePlacement) => void;
};

const SheetImageEditingContext = createContext<SheetImageEditing>({ placements: {}, editable: false });

type CropSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ImageTextLayer = {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  // Text rotation in degrees (0 = horizontal). Used so a vertical mm label converts to a vertical
  // inch label in the same orientation. Rotation is around the text's (x, y) top-left anchor.
  rotation?: number;
};

type ImageEraseLayer = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  shape?: "rect" | "circle";
  rotation?: number; // rotate the cover box (deg) so it hugs rotated text instead of crossing lines
};

// A drawn line or arrow — to redraw dimension leaders/arrows erased while editing unit labels.
type ImageShapeLayer = {
  id: string;
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
};

type ImageEditorMode = "text" | "movetext" | "erase" | "pen" | "crop" | "line" | "arrow";

// Which part of the crop rectangle a drag is manipulating.
type CropHandle = "new" | "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type ImageEditorState = {
  backgroundColor: string;
  brightness: number;
  contrast: number;
  saturation: number;
  removeBackground: boolean;
  imageScale: number;
  rotation: number; // degrees, 0 / 90 / 180 / 270
  flipH: boolean;
  flipV: boolean;
  grayscale: boolean;
  textLayers: ImageTextLayer[];
  eraseLayers: ImageEraseLayer[];
  shapeLayers: ImageShapeLayer[];
};

type OverviewTemplateRow = { label: string; keys: string[] };

function createOverviewTemplateRow(label: string, ...keys: string[]): OverviewTemplateRow {
  return { label, keys: [label, ...keys] };
}

const TEMPLATE_OVERVIEW_ROWS: OverviewTemplateRow[] = [
  { label: "Product Type", keys: ["Product Type", "Product Category"] },
  { label: "Power", keys: ["Power", "Wattage"] },
  { label: "Lumen Output", keys: ["Lumen Output", "Lumens"] },
  { label: "Efficacy", keys: ["Efficacy (lm/W)", "Efficacy"] },
  { label: "Voltage", keys: ["Voltage", "Input Voltage"] },
  { label: "Current", keys: ["Current"] },
  { label: "Frequency", keys: ["Frequency"] },
  { label: "Power Factor", keys: ["Power Factor"] },
  { label: "THD", keys: ["THD", "Total Harmonic Distortion"] },
  { label: "CCT", keys: ["CCT", "Color Temperature (Selectable)", "Color Temperature"] },
  { label: "CRI", keys: ["CRI", "Color Rendering Index"] },
  { label: "R9 (Red Value)", keys: ["R9 (Red Value)", "R9"] },
  { label: "R13 (Skin Tones)", keys: ["R13 (Skin Tones)", "R13"] },
  { label: "Beam Angle", keys: ["Beam Angle"] },
  { label: "Light Distribution", keys: ["Light Distribution"] },
  { label: "BUG Rating", keys: ["BUG Rating", "Backlight Uplight Glare"] },
  { label: "Dimming", keys: ["Dimming"] },
  { label: "Driver", keys: ["Driver", "Power Supply"] },
  { label: "LED Source", keys: ["LED Source", "LED Type"] },
  { label: "Sensor Compatibility", keys: ["Sensor Compatibility"] },
  { label: "Control", keys: ["Control"] },
  { label: "Lifespan", keys: ["Lifespan", "Lifespan (Hours)"] },
  { label: "Warranty", keys: ["Warranty", "Warranty (Years)"] },
  { label: "Operating Temperature", keys: ["Operating Temperature"] },
  { label: "Storage Temperature", keys: ["Storage Temperature"] },
  { label: "Suitable Location", keys: ["Suitable Location"] },
  { label: "IP Rating", keys: ["IP Rating"] },
  { label: "IK Rating", keys: ["IK Rating"] },
  { label: "Housing", keys: ["Housing", "Housing Material"] },
  { label: "Lens", keys: ["Lens", "Cover Material / Lens"] },
  { label: "Mounting", keys: ["Mounting", "Mounting Type", "Installation"] },
  { label: "Fixture Sizes", keys: ["Fixture Sizes", "Fixture Size"] },
  { label: "Thickness", keys: ["Thickness", "Depth"] },
  { label: "Certifications", keys: ["Certifications"] },
  { label: "EPA", keys: ["EPA", "Effective Projected Area"] },
  { label: "Wind Shear Rating", keys: ["Wind Shear Rating"] },
  { label: "Emergency Backup", keys: ["Emergency Backup"] },
  { label: "Surge Protection", keys: ["Surge Protection"] },
  { label: "Finish", keys: ["Finish"] },
];

const CATEGORY_OVERVIEW_TEMPLATES: Record<string, OverviewTemplateRow[]> = {
  // Master overview heads for INDOOR products, in the exact wording/casing supplied. Anything the
  // vendor PDF has that is NOT one of these becomes an optional (not-included) row.
  indoor: [
    createOverviewTemplateRow("Power (Selectable)", "Power", "Wattage"),
    createOverviewTemplateRow("Voltage", "Input Voltage"),
    createOverviewTemplateRow("Current"),
    createOverviewTemplateRow("Power Factor"),
    createOverviewTemplateRow("Total Harmonic Distortion (THD)", "THD"),
    createOverviewTemplateRow("Surge Protection"),
    createOverviewTemplateRow("Lumen Output", "Lumens"),
    createOverviewTemplateRow("Efficacy", "Efficacy (lm/W)"),
    createOverviewTemplateRow("Color Temperature (CCT)", "CCT", "Color Temperature", "Color Temperature (Selectable)"),
    createOverviewTemplateRow("Color Rendering Index (CRI)", "CRI", "Color Rendering", "Color Rendering Index"),
    createOverviewTemplateRow("Beam Angle"),
    createOverviewTemplateRow("Dimming Capability", "Dimming"),
    createOverviewTemplateRow("Operating Temperature"),
    createOverviewTemplateRow("Suitable Location"),
    createOverviewTemplateRow("Ingress Protection Rating (IP)", "IP Rating"),
    createOverviewTemplateRow("Average Life (Hours)", "Lifespan", "Lifespan (Hours)"),
    createOverviewTemplateRow("Warranty (Years)", "Warranty"),
    createOverviewTemplateRow("LED Light Source", "LED Source", "LED Type"),
    createOverviewTemplateRow("Driver"),
    createOverviewTemplateRow("Housing", "Housing Material"),
    createOverviewTemplateRow("Finish", "Finish Options", "Finishes", "Finish Color", "Finish Colours", "Available Finishes"),
    createOverviewTemplateRow("Cover / Lens Material", "Lens", "Cover Material / Lens", "Cover/Lens Material"),
    createOverviewTemplateRow("Cover Type"),
    createOverviewTemplateRow("Power Supply"),
  ],
  // Master overview heads for OUTDOOR products, in the exact wording/casing supplied.
  outdoor: [
    createOverviewTemplateRow("Power (Selectable)", "Power", "Wattage"),
    createOverviewTemplateRow("Voltage", "Input Voltage"),
    createOverviewTemplateRow("Current"),
    createOverviewTemplateRow("Power Factor"),
    createOverviewTemplateRow("Total Harmonic Distortion (THD)", "THD"),
    createOverviewTemplateRow("Surge Protection"),
    createOverviewTemplateRow("Lumen Output", "Lumens"),
    createOverviewTemplateRow("Efficacy", "Efficacy (lm/W)"),
    createOverviewTemplateRow("Color Temperature (CCT)", "CCT", "Color Temperature", "Color Temperature (Selectable)"),
    createOverviewTemplateRow("Color Rendering Index (CRI)", "CRI", "Color Rendering", "Color Rendering Index"),
    createOverviewTemplateRow("Beam Angle"),
    createOverviewTemplateRow("Lighting Distribution", "Light Distribution"),
    createOverviewTemplateRow("BUG Rating (Backlight, Uplight, and Glare)", "BUG Rating", "Backlight Uplight Glare"),
    createOverviewTemplateRow("Dimming Capability", "Dimming"),
    createOverviewTemplateRow("Operating Temperature"),
    createOverviewTemplateRow("Suitable Location"),
    createOverviewTemplateRow("Ingress Protection Rating (IP)", "IP Rating"),
    createOverviewTemplateRow("Impact Protection Rating (IK)", "IK Rating"),
    createOverviewTemplateRow("Average Life (Hours)", "Lifespan", "Lifespan (Hours)"),
    createOverviewTemplateRow("Warranty (Years)", "Warranty"),
    createOverviewTemplateRow("LED Light Source", "LED Source", "LED Type"),
    createOverviewTemplateRow("Driver"),
    createOverviewTemplateRow("Housing", "Housing Material"),
    createOverviewTemplateRow("Finish", "Finish Options", "Finishes", "Finish Color", "Finish Colours", "Available Finishes"),
    createOverviewTemplateRow("Effective Projected Area (EPA)", "EPA", "Effective Projected Area", "Effective Protected Area"),
    createOverviewTemplateRow("Cover / Lens Material", "Lens", "Cover Material / Lens", "Cover/Lens Material"),
    createOverviewTemplateRow("Cover Type"),
    createOverviewTemplateRow("Power Supply"),
  ],
};

// Hazardous Location Lighting is a master category alongside Indoor / Outdoor. It reuses the
// Outdoor master heads (hazardous fixtures are industrial/outdoor in nature). Override with a
// dedicated list here if the hazardous heads should differ.
CATEGORY_OVERVIEW_TEMPLATES.hazardous = CATEGORY_OVERVIEW_TEMPLATES.outdoor;

const OVERVIEW_EXCLUDED_PARAMETERS = new Set([
  "product category",
  "product type",
]);

// Overview rows to hide entirely: only the redundant Product Category / Product Type heads.
// (Color Options / Finish Options and Dimming Capability ARE shown when the vendor lists them.)
function isExcludedOverviewLabel(label: string) {
  const key = normalizeSpecKey(label);
  return OVERVIEW_EXCLUDED_PARAMETERS.has(key);
}

// Rows whose values represent a physical size and should be shown in ft/in.
function isDimensionLabel(label: string) {
  const key = normalizeSpecKey(label);
  return ["dimension", "size", "length", "width", "height", "depth", "thickness"].some((token) =>
    key.includes(token),
  );
}

function mmToFeetInches(mm: number) {
  const inches = mm / 25.4;
  if (inches >= 12) {
    const feet = Math.floor(inches / 12);
    const remainder = inches - feet * 12;
    return remainder >= 0.05 ? `${feet}'-${remainder.toFixed(1)}"` : `${feet}'`;
  }
  return `${inches.toFixed(1)}"`;
}

// Convert a millimetre dimension string to feet/inches. The unit is usually stated once at the end
// (e.g. "1200 x 600 mm" or "Ø140 mm"), so when the group is in mm we convert EVERY bare number and
// keep the separators/markers (x, Ø). Mixed/imperial strings only convert the numbers tagged "mm".
function convertDimensionUnits(value: string) {
  const str = String(value ?? "");
  if (/\bmm\b/i.test(str) && !/(inch|["″']|\bft\b|\bin\b)/i.test(str)) {
    return str
      .replace(/\s*mm\b/gi, "")
      .replace(/(\d+(?:\.\d+)?)/g, (_match, num: string) => mmToFeetInches(Number(num)));
  }
  return str.replace(/(\d+(?:\.\d+)?)\s*mm\b/gi, (_match, num: string) => mmToFeetInches(Number(num)));
}

/** True for overview labels that represent color temperature / CCT. */
function isCctLabel(label: string) {
  return /color\s*temp|\bcct\b/i.test(label ?? "");
}

/** Keep only the Kelvin tokens in a CCT value, dropping any power/lumen pollution. Multiple CCTs
 *  are selectable, so they're joined with " - " (the selectable convention, matching Power); a
 *  single value is shown as-is.
 *  "40W/60W: 3000K-4000K-5000K | 300W: 4000K-5000K" -> "3000K - 4000K - 5000K". */
function extractCctValue(value: string) {
  const tokens = String(value ?? "").match(/\d[\d.]*\s*K\b/gi);
  if (!tokens || tokens.length === 0) return value;
  const seen: string[] = [];
  for (const token of tokens) {
    const normalized = token.replace(/\s+/g, "").toUpperCase();
    if (!seen.includes(normalized)) seen.push(normalized);
  }
  // 2+ distinct CCTs => field-selectable; just dash-join them (the head conveys "selectable").
  return seen.join(" - ");
}

/** True for overview labels that represent beam angle. */
function isBeamAngleLabel(label: string) {
  return /beam\s*angle/i.test(label ?? "");
}

/** Beam angle → degree value(s), e.g. "60° - 120°" -> "60° / 120°". If the value has numbers but no
 *  degree token (e.g. "60" or "15/24/38"), append °. If it is purely descriptive ("Narrow Flood"),
 *  keep the original text rather than blanking the row. */
function extractBeamAngleDegrees(value: string) {
  const raw = String(value ?? "");
  let matches = raw.match(/\d[\d.]*\s*(?:°|deg(?:ree)?s?\b)/gi);
  if (!matches || matches.length === 0) {
    const bare = raw.match(/\d[\d.]*/g);
    if (!bare || bare.length === 0) return raw; // descriptive beam — keep it visible
    matches = bare;
  }
  const seen: string[] = [];
  for (const match of matches) {
    const num = match.match(/\d[\d.]*/)?.[0];
    if (!num) continue;
    const normalized = `${num}°`;
    if (!seen.includes(normalized)) seen.push(normalized);
  }
  return seen.length ? seen.join(" / ") : raw;
}

function isBugRatingLabel(label: string) {
  const key = String(label ?? "").toLowerCase();
  return key.includes("bug rating") || key.includes("backlight");
}

/** BUG rating: show only the HIGHEST B/U/G value (worst case across CCT/config), then a note that it
 *  varies by power & distribution. "B3-B5, U0, G2-G5" -> "B5, U0, G5\n<note>". */
function extractHighestBugRating(value: string) {
  const pick = (letter: string) => {
    const nums = [...String(value ?? "").matchAll(new RegExp(`${letter}\\s*(\\d)`, "gi"))].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : null;
  };
  const b = pick("B");
  const u = pick("U");
  const g = pick("G");
  const parts: string[] = [];
  if (b != null) parts.push(`B${b}`);
  if (u != null) parts.push(`U${u}`);
  if (g != null) parts.push(`G${g}`);
  if (parts.length === 0) return value;
  return parts.join(" - ");
}

function isEpaLabel(label: string) {
  const key = String(label ?? "").toLowerCase();
  return /\bepa\b/.test(key) || key.includes("effective projected area") || key.includes("effective protected area");
}

/** EPA: show only the LOWEST value (per variant/fixture). Only numbers actually attached to a sq-ft
 *  unit are considered, so footnote/figure references ("see figure 1") can't pollute it.
 *  "0.3632 to 1.3923 sq ft" -> "0.3632 sq ft". */
function extractLowestEpa(value: string) {
  const str = String(value ?? "");
  const tagged = [...str.matchAll(/(\d+(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft(?:\^?2|²)|sq\s*feet)/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const nums = tagged.length
    ? tagged
    : [...str.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return value;
  const lowest = Math.min(...nums);
  return `${lowest} sq ft`;
}

/** Sentence-case an overview value: lowercase prose words but PRESERVE all-uppercase tokens
 *  (acronyms/roman numerals/unit letters like IP65, LED, II, V, K, W) and any token with a digit,
 *  then capitalize the first letter of each line (only when it starts with a letter).
 *  "Constant Current" -> "Constant current"; "Type II, III, IV, V" and "160 lm/W" stay intact. */
function toOverviewSentenceCase(value: string) {
  if (!value) return value;
  const lowered = value.replace(/[A-Za-z]+/g, (word) => (word === word.toUpperCase() ? word : word.toLowerCase()));
  return lowered.replace(/^(\s*)([a-z])/gm, (_match, ws: string, ch: string) => ws + ch.toUpperCase());
}

function isIpRatingLabel(label: string) {
  return /ingress\s*protection/i.test(label ?? "") || /\bip\s*rating\b/i.test(label ?? "") || /^\s*ip\s*$/i.test(label ?? "");
}

/** Keep only the IP rating tokens, formatted as "IP65/IP66/IP67". Drops surrounding prose like
 *  "rated for wet locations". Falls back to the original text if no IPxx token is present. */
function extractIpRatings(value: string) {
  // \bip avoids matching inside words like "chip 65".
  const matches = [...String(value ?? "").matchAll(/\bip\s*-?\s*(\d{2})\b/gi)].map((m) => `IP${m[1]}`);
  const unique = [...new Set(matches)];
  return unique.length ? unique.join("/") : value;
}

function isSuitableLocationLabel(label: string) {
  return /suitable\s*location/i.test(label ?? "") || /location\s*rating/i.test(label ?? "");
}

/** Reduce a "Suitable Location" value to the standard DRY/DAMP/WET tokens present, UPPERCASE per the
 *  spec-sheet checklist, e.g. "Suitable for wet & damp locations" -> "DAMP/WET". Falls back to the
 *  original if none found. */
function extractSuitableLocations(value: string) {
  const text = String(value ?? "").toLowerCase();
  const found = ["dry", "damp", "wet"]
    .filter((loc) => new RegExp(`\\b${loc}\\b`).test(text))
    .map((loc) => loc.toUpperCase());
  return found.length ? found.join("/") : value;
}

function isFinishLabel(label: string) {
  return /\bfinish\b/i.test(label ?? "");
}

/** Clean a "Finish" value to the colour(s), but WITHOUT losing accuracy: it strips only generic
 *  process/prefix wording ("powder-coated", "available finishes:") and preserves the real
 *  descriptor — modifiers ("Textured", "Matte"), RAL codes, and any colour, in the original order.
 *  "Powder-coated white / black" -> "white / black"; "Textured Bronze (RAL 8019)" is kept intact. */
function extractFinishColors(value: string) {
  const cleaned = String(value ?? "")
    .replace(/\b(powder[\s-]?coated?|painted|anodized|electro[\s-]?coated|finish(?:es)?|available|options?|colou?rs?)\b\s*:?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:;,\-/]+|[\s:;,\-/]+$/g, "")
    .trim();
  return cleaned || value;
}

function isDriverLabel(label: string) {
  const key = normalizeSpecKey(label);
  return key.includes("driver") || key.includes("power supply");
}

/** Keep the driver name/type only, stripping electrical CLASS designations ("Class 2", "Class II")
 *  the user doesn't want in this field, e.g. "Constant Current, Class 2" -> "Constant Current". */
function extractDriverName(value: string) {
  const stripped = String(value ?? "")
    .replace(/[,;/|]?\s*class\s+(?:\d+|i{1,3}|iv)\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;/|-]+|[\s,;/|-]+$/g, "")
    .trim();
  return stripped || value;
}

function isVoltageLabel(label: string) {
  const key = normalizeSpecKey(label);
  return key === "voltage" || key.includes("input voltage");
}

/** Format a voltage value as a hyphen range ending in V, e.g. "AC 50/60Hz 120-277V" -> "120-277V".
 *  Strips frequency (Hz) and current (A) so neither leaks into the range. Falls back to the original
 *  if no number is present. */
function formatVoltage(value: string) {
  const cleaned = String(value ?? "")
    .replace(/\d+(?:\.\d+)?(?:\s*[/–-]\s*\d+(?:\.\d+)?)*\s*hz\b/gi, " ") // drop frequency
    .replace(/\d+(?:\.\d+)?\s*a\b/gi, " "); // drop current (amps)
  // Keep DISTINCT selectable voltage ranges apart with " | " (e.g. "100-277 | 200-480V") instead of
  // running every number together as "100-277-200-480V". A "-" (or "–") joins a single min-max range;
  // "|", ",", "/", "or"/"and" separate two independent ranges.
  const segments = cleaned.split(/\s*[|,/]\s*|\s+(?:or|and)\s+/i).map((s) => s.trim()).filter(Boolean);
  const toRange = (seg: string) => [...new Set([...seg.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]))].join("-");
  let ranges = segments.map(toRange).filter(Boolean);
  // No explicit separator but four numbers => two min-max ranges ("100-277 200-480" -> two ranges).
  if (ranges.length === 1) {
    const nums = ranges[0].split("-");
    if (nums.length === 4) ranges = [`${nums[0]}-${nums[1]}`, `${nums[2]}-${nums[3]}`];
  }
  const unique = [...new Set(ranges)];
  return unique.length ? `${unique.join(" | ")}V` : value;
}

function isThdLabel(label: string) {
  return /\bthd\b/i.test(label ?? "") || /total\s*harmonic/i.test(label ?? "");
}

/** Ensure a THD value carries a percent sign (keeps any existing comparison sign), e.g.
 *  "< 20" -> "< 20%". Leaves a value that already has "%" untouched. */
function formatThd(value: string) {
  const text = String(value ?? "").trim();
  if (text && /\d/.test(text) && !text.includes("%")) return `${text}%`;
  return text || value;
}

function isPowerFactorLabel(label: string) {
  return /power\s*factor/i.test(label ?? "");
}

/** Keep just the power-factor number (with any comparison sign), dropping stray units/words, e.g.
 *  "0.979 (typical)" -> "0.979", "> 0.9 pf" -> ">0.9". */
function formatPowerFactor(value: string) {
  const match = String(value ?? "").match(/[<>]?=?\s*\d*\.?\d+/);
  return match ? match[0].replace(/\s+/g, "") : value;
}

function isAverageLifeLabel(label: string) {
  return /average\s*life|lifespan|rated\s*life/i.test(label ?? "");
}

/** Format the average-life hours with thousands separators, e.g. "50000 hrs" -> "50,000". Drops
 *  "L70"/"L80"/"L90" designations first (so they aren't mistaken for the hours), then reports the
 *  lowest life-sized number (>= 1000) — the conservative rated life, e.g. "50,000 h (L70) /
 *  100,000 h (L50)" -> "50,000" (the L70 figure), not the optimistic L50 value. */
function formatAverageLife(value: string) {
  const cleaned = String(value ?? "").replace(/\bL\d+\b/gi, " ");
  const nums = [...cleaned.matchAll(/\d[\d,]*/g)]
    .map((m) => parseInt(m[0].replace(/,/g, ""), 10))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return value;
  const life = nums.filter((n) => n >= 1000);
  const pick = life.length ? Math.min(...life) : Math.max(...nums);
  return pick.toLocaleString("en-US");
}

function isPowerSelectableOverviewLabel(label: string) {
  const key = normalizeSpecKey(label);
  return key === "power" || key === "power selectable" || key === "max power" || key === "wattage";
}

/** Format ONE power string into distinct, ascending, hyphen-joined wattages ("30W / 22W" -> "22W-30W"). */
function formatSelectableWatts(value: string) {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of String(value ?? "").match(/\d+(?:\.\d+)?\s*W\b/gi) ?? []) {
    const token = raw.replace(/\s+/g, "").toUpperCase();
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  tokens.sort((a, b) => parseFloat(a) - parseFloat(b));
  return tokens.join("-");
}

/** Power display normaliser that RESPECTS per-variant grouping. It PRESERVES whatever line
 *  structure the value already has (so a manual per-variant split typed in the editor sticks) and
 *  only tidies the wattages within each line — distinct, ascending, hyphen-joined:
 *   - "22W / 30W"                  -> "22W-30W"                    (single selectable line)
 *   - "11 inch: 24W\n14 inch: 30W" -> "11 inch: 24W\n14 inch: 30W" (one line per variant, kept)
 *  Merging a single selectable fixture onto one line is done up front by buildVariantPowerValue, so
 *  the display layer never collapses intentional line breaks. */
function formatPowerSelectable(value: string) {
  const raw = String(value ?? "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return value;
  const formatLine = (line: string) => {
    const prefixMatch = line.match(/^(.*?:\s*)(.*)$/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    const body = prefixMatch ? prefixMatch[2] : line;
    const watts = formatSelectableWatts(body);
    return watts ? `${prefix}${watts}` : line;
  };
  return lines.map(formatLine).join("\n") || value;
}

/** Normalize an overview row value for display (dimensions -> US units, CCT -> Kelvin only,
 *  beam angle -> degrees only, BUG -> highest, EPA -> lowest, IP -> IPxx tokens, Suitable Location
 *  -> DRY/DAMP/WET, Finish -> colours, Driver -> name without class, Voltage -> range+V, THD -> %,
 *  Power Factor -> number, Average Life -> grouped hours, Power -> hyphen-joined wattages),
 *  then sentence-case the text. */
function normalizeOverviewRowValue(label: string, value: string) {
  let result = value;
  if (isDimensionLabel(label)) result = convertDimensionUnits(value);
  else if (isCctLabel(label)) result = extractCctValue(value);
  else if (isBeamAngleLabel(label)) result = extractBeamAngleDegrees(value);
  else if (isBugRatingLabel(label)) result = extractHighestBugRating(value);
  else if (isEpaLabel(label)) result = extractLowestEpa(value);
  else if (isIpRatingLabel(label)) return extractIpRatings(value); // keep IPxx casing exactly
  else if (isSuitableLocationLabel(label)) return extractSuitableLocations(value); // keep UPPERCASE
  else if (isFinishLabel(label)) result = extractFinishColors(value);
  else if (isDriverLabel(label)) result = extractDriverName(value);
  else if (isVoltageLabel(label)) return formatVoltage(value); // keep "V" casing
  else if (isThdLabel(label)) return formatThd(value);
  else if (isPowerFactorLabel(label)) return formatPowerFactor(value);
  else if (isPowerSelectableOverviewLabel(label)) return formatPowerSelectable(value); // keep "W" casing
  else if (isAverageLifeLabel(label)) return formatAverageLife(value);
  return toOverviewSentenceCase(result);
}

function buildWarrantyStatement(years: number) {
  return `This product is backed by a limited ${years}-year manufacturer's warranty covering defects in materials and workmanship under normal use and service from the date of purchase. Warranty coverage is subject to published terms, conditions, exclusions, and proper installation, operation, and maintenance.`;
}

const WARRANTY_COPY_5_YEARS = buildWarrantyStatement(5);
const WARRANTY_COPY_7_YEARS = buildWarrantyStatement(7);
const WARRANTY_COPY_10_YEARS = buildWarrantyStatement(10);

const QUALIFICATION_BADGES: Array<{
  id: QualificationBadgeId;
  label: string;
  imageFile: string;
  keywords: string[];
}> = [
  { id: "dlc_premium", label: "DLC Premium", imageFile: "DLC-Premium.png", keywords: ["dlc premium"] },
  { id: "dlc_listed", label: "DLC Listed", imageFile: "DLC-Standred.png", keywords: ["dlc listed", "dlc"] },
  { id: "energy_star", label: "Energy Star", imageFile: "Energy-Star.png", keywords: ["energy star"] },
  { id: "etl", label: "ETL", imageFile: "ETL.png", keywords: ["etl"] },
  { id: "c_ulus", label: "UL Listed", imageFile: "UL.png", keywords: ["culus", "ul listed", "ul", "culus listed"] },
  { id: "wet_location", label: "IP65", imageFile: "IP65.png", keywords: ["wet", "ip65", "ip66", "damp"] },
  { id: "dimmable", label: "Dimmable", imageFile: "Dimmable.png", keywords: ["dimmable", "0-10v", "0 10v", "dimming"] },
  { id: "sensors", label: "Sensors", imageFile: "Sensors.png", keywords: ["sensor", "occupancy", "daylight"] },
  { id: "power_selectable", label: "Power Selectable", imageFile: "Power-Selectable.png", keywords: ["power selectable", "wattage selectable", "selectable wattage"] },
  { id: "cct_selectable", label: "CCT Selectable", imageFile: "CCT-Selectable.png", keywords: ["cct selectable", "selectable cct"] },
  { id: "rohs", label: "RoHS", imageFile: "RoHS.png", keywords: ["rohs"] },
];

const SHEET_PREVIEW_WIDTH = 816;
const SHEET_PREVIEW_HEIGHT = 1056;
// Vertical gap between stacked pages in the preview (matches gap-8 in SheetPreview).
const PREVIEW_PAGE_GAP = 32;
const PRODUCT_NAME_REGISTRY_KEY = "ikio-product-name-registry-v1";
const CONSTELLATION_CODENAMES = [
  "Orion",
  "Lyra",
  "Cygnus",
  "Aquila",
  "Phoenix",
  "Draco",
  "Hydra",
  "Vela",
  "Carina",
  "Cassiopeia",
  "Perseus",
  "Andromeda",
  "Centauri",
  "Pegasus",
  "Auriga",
  "Delphinus",
  "Volans",
  "Lacerta",
  "Argo",
  "Altair",
];

type ProductNameRegistry = {
  assigned: Record<string, string[]>;
  used: string[];
};

function normalizeText(value: string | undefined) {
  return (value ?? "")
    .replace(/\u00c2\u00b0|Â°/g, "°")
    .replace(/\u00e2\u20ac\u201c|\u00e2\u20ac\u201d|â€“|â€”/g, "-")
    .trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createImageEditorState(): ImageEditorState {
  return {
    backgroundColor: "#ffffff",
    brightness: 100,
    contrast: 100,
    saturation: 100,
    removeBackground: false,
    imageScale: 100,
    rotation: 0,
    flipH: false,
    flipV: false,
    grayscale: false,
    textLayers: [],
    eraseLayers: [],
    shapeLayers: [],
  };
}

/** Draw a line or arrow (with a filled arrowhead) onto a canvas context — used both for committed
 *  shape layers and the live drag preview, so dimension leaders/arrows can be redrawn. */
function drawShapeOnContext(
  context: CanvasRenderingContext2D,
  shape: { type: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number },
) {
  const { x1, y1, x2, y2, color, width } = shape;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, width);
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  if (shape.type === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(8, width * 3.5);
    context.beginPath();
    context.moveTo(x2, y2);
    context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
    context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }
  context.restore();
}

/**
 * Whiten the background of an image on a canvas by flood-filling inward from the edges: only
 * background pixels connected to the border (and close to the sampled corner colour) become white,
 * so the product itself is preserved. Used by the editor's manual "Remove Background" toggle.
 */
function whitenConnectedBackground(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const { width, height } = canvas;
  if (width < 2 || height < 2) return;

  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, width, height);
  } catch {
    return;
  }
  const data = imageData.data;

  const cornerPixels = [0, width - 1, (height - 1) * width, height * width - 1];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const p of cornerPixels) {
    const i = p * 4;
    br += data[i];
    bg += data[i + 1];
    bb += data[i + 2];
  }
  br /= 4;
  bg /= 4;
  bb /= 4;

  const tolSq = 46 * 46;
  const isBackground = (i: number) => {
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db < tolSq;
  };

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) {
    stack.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + (width - 1));
  }

  while (stack.length) {
    const p = stack.pop() as number;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    if (!isBackground(i)) continue;

    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;

    const x = p % width;
    const y = (p - x) / width;
    if (x > 0 && !visited[p - 1]) stack.push(p - 1);
    if (x < width - 1 && !visited[p + 1]) stack.push(p + 1);
    if (y > 0 && !visited[p - width]) stack.push(p - width);
    if (y < height - 1 && !visited[p + width]) stack.push(p + width);
  }

  context.putImageData(imageData, 0, 0);
}

function resolveSourceImage(image: SourceImage, editedImageDataUrls: Record<string, string>): SourceImage {
  return {
    ...image,
    dataUrl: editedImageDataUrls[image.id] ?? image.dataUrl,
  };
}

function getDraftSourceImages(spec: ExtendedExtractedSpec, draft: EditorDraft) {
  return [...spec.sourceImages, ...draft.manualSourceImages].map((image) =>
    resolveSourceImage(image, draft.editedImageDataUrls),
  );
}

/** Vendor-library images are the embedded photos/diagrams the backend harvested from the PDF
 *  (id "vendorimg-<kind>-<page>-<i>"). They are a PICKABLE library — never auto-placed as the hero. */
function isLibraryImageId(id: string) {
  return typeof id === "string" && id.startsWith("vendorimg-");
}

/** The backend's classification of a vendor library image: "photo" | "diagram" (or "" if unknown). */
function libraryImageKind(id: string): "photo" | "diagram" | "" {
  const match = /^vendorimg-(photo|diagram)-/.exec(id);
  return (match?.[1] as "photo" | "diagram") ?? "";
}

/** Sort vendor images so the most relevant for a section come first: dimension drawings surface
 *  line-drawing "diagram" images; product/accessory surface real "photo" images. */
function sortVendorImagesFor(
  images: SourceImage[],
  target: "product" | "accessory" | "dimension" | "custom",
) {
  // Dimension and custom (photometric / distribution / mounting) sections are line-drawing figures —
  // surface "diagram" images first; product/accessory want real photos first.
  const preferDiagram = target === "dimension" || target === "custom";
  const rank = (id: string) => {
    const kind = libraryImageKind(id);
    if (preferDiagram) return kind === "diagram" ? 0 : kind === "photo" ? 1 : 2;
    return kind === "photo" ? 0 : kind === "diagram" ? 1 : 2;
  };
  return [...images].sort((a, b) => rank(a.id) - rank(b.id));
}

/** Default owner for an image: library images belong to the pickable library (not the product) so
 *  they never auto-render as the hero photo; everything else defaults to the product. */
function defaultImageOwner(imageId: string) {
  return isLibraryImageId(imageId) ? "library" : "product";
}

function slugifyName(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const SPEC_LABEL_ALIASES: Record<string, string> = {
  "power (selectable)": "Power",
  "max power": "Power",
  power: "Power",
  wattage: "Power",
  voltage: "Voltage",
  "input voltage": "Voltage",
  lumens: "Lumen Output",
  "lumen output": "Lumen Output",
  efficiency: "Efficacy",
  efficacy: "Efficacy",
  "efficacy (lm/w)": "Efficacy",
  "color temperature (selectable)": "CCT",
  "color temp (selectable)": "CCT",
  "color temperature": "CCT",
  cct: "CCT",
  "color rendering (cri)": "CRI",
  "color rendering index": "CRI",
  cri: "CRI",
  "lighting angle": "Beam Angle",
  "beam spread": "Beam Angle",
  "bug rating (backlight, uplight, glare)": "BUG Rating",
  "light distribution type": "Light Distribution",
  "distribution type": "Light Distribution",
  distribution: "Light Distribution",
  "dimmable lighting control": "Dimming",
  "operating temperature (°f)": "Operating Temperature",
  "operating temperature (â°f)": "Operating Temperature",
  "operating temperature (å°f)": "Operating Temperature",
  "operating temperature (ã¢â°f)": "Operating Temperature",
  "ingress protection rating (ip)": "IP Rating",
  "ingress protection (ip)": "IP Rating",
  ip: "IP Rating",
  "impact protection rating (ik)": "IK Rating",
  "impact protection (ik)": "IK Rating",
  ik: "IK Rating",
  "lifespan (avg life hours)": "Lifespan",
  "lifespan (avg life, warranty)": "Lifespan",
  "lifespan (hours)": "Lifespan",
  certification: "Certifications",
  certifications: "Certifications",
  listing: "Certifications",
  "warranty (years)": "Warranty",
  "led light source": "LED Source",
  "housing material": "Housing",
  housing: "Housing",
  "cover material / lens": "Lens",
  lens: "Lens",
  "mounting type": "Mounting",
  mounting: "Mounting",
  installation: "Mounting",
  "led type": "LED Source",
  "base / power supply": "Driver",
  "power supply": "Driver",
  "driver type": "Driver",
  "led driver": "Driver",
  driver: "Driver",
  "product category": "Product Type",
  "product type": "Product Type",
  "fixture type": "Product Type",
  r9: "R9 (Red Value)",
  "r9 (red value)": "R9 (Red Value)",
  r13: "R13 (Skin Tones)",
  "r13 (skin tones)": "R13 (Skin Tones)",
  "percent flicker (%)": "Percent Flicker (%)",
  flicker: "Percent Flicker (%)",
  epa: "EPA",
  "effective projected area": "EPA",
  "effective projected area (epa)": "EPA",
  "wind shear rating": "Wind Shear Rating",
  "bug rating": "BUG Rating",
  control: "Control",
  "control output": "Control",
  "control module": "Control",
  "intelligent control": "Control",
  sensor: "Sensor Compatibility",
  "sensor compatibility": "Sensor Compatibility",
  structure: "Structure",
  "qualified part number": "Qualified Part Number",
  diffuser: "Diffuser",
  "protection against electric": "Protection Class",
  "fixture size": "Fixture Sizes",
  "fixture sizes": "Fixture Sizes",
  thickness: "Thickness",
  depth: "Thickness",
  "emergency back-up": "Emergency Backup",
  "emergency backup": "Emergency Backup",
  "suitable location": "Suitable Location",
};

function normalizeSpecAliasKey(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/â°|å°|ã¢â°|Â°/g, "°")
    .replace(/\(deg f\)/g, "(°f)")
    .replace(/\(f\)/g, "(°f)");
}

function canonicalizeSpecLabel(value: string) {
  const normalized = normalizeSpecAliasKey(value);
  return SPEC_LABEL_ALIASES[normalized] ?? normalizeText(value);
}

function uniquePreserveOrder(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortOptionValues(values: string[]) {
  return [...values].sort((left, right) => {
    const leftMatch = left.match(/-?\d+(?:\.\d+)?/);
    const rightMatch = right.match(/-?\d+(?:\.\d+)?/);

    if (leftMatch && rightMatch) {
      const numericDifference = Number(leftMatch[0]) - Number(rightMatch[0]);
      if (numericDifference !== 0) return numericDifference;
    }

    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  });
}

const SELECTABLE_MARKERS = new Set([
  "yes",
  "no",
  "yes/no",
  "yes / no",
  "true",
  "false",
  "y",
  "n",
]);

function isSelectableMarker(value: string) {
  return SELECTABLE_MARKERS.has(normalizeText(value).toLowerCase());
}

function normalizeOptionList(value: string, tokenPattern: RegExp, separator = " | ", strict = false) {
  const normalized = normalizeText(value);
  if (!normalized) return normalized;

  const matchedTokens = sortOptionValues(uniquePreserveOrder(
    Array.from(normalized.matchAll(new RegExp(tokenPattern.source, `${tokenPattern.flags.replace(/g/g, "")}g`)))
      .map((match) => normalizeText(match[0])),
  ));

  if (matchedTokens.length >= 1) {
    return matchedTokens.join(separator);
  }

  if (strict) {
    return "";
  }

  return sortOptionValues(uniquePreserveOrder(
    normalized
      .split(/\s*(?:\||\/|,|;|\r?\n)\s*/)
      .map((token) => token.trim())
      .filter(Boolean),
  )).join(separator);
}

function compactSelectableValue(label: string, value: string) {
  const normalizedLabel = normalizeSpecKey(label);
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return normalizedValue;

  if (normalizedLabel === "power" || normalizedLabel === "power selectable" || normalizedLabel === "max power") {
    return normalizeOptionList(normalizedValue, /\d(?:[\d.\s-])*(?:w|watt|watts)\b/i, " - ", true);
  }

  if (normalizedLabel === "cct" || normalizedLabel.includes("color temperature")) {
    return normalizeOptionList(normalizedValue, /\d{3,5}\s*k\b/i, " - ", true);
  }

  if (normalizedLabel === "lumens" || normalizedLabel === "lumen output") {
    const withoutTaggedCct = normalizedValue.replace(/\([^)]*?\d{3,5}\s*k[^)]*\)/gi, "");
    return normalizeOptionList(withoutTaggedCct, /\d[\d,]*(?:\.\d+)?\s*lm\b/i, " - ", true);
  }

  if (normalizedLabel === "efficacy") {
    return normalizeOptionList(normalizedValue, /\d[\d,]*(?:\.\d+)?\s*(?:lm\s*\/\s*w|lm\s*\/\s*ft)\b/i, " - ", true);
  }

  return normalizedValue
    .split(/\r?\n/)
    .map((item) => item.replace(/\s*(?:\||\/)\s*/g, " - ").trim())
    .filter(Boolean)
    .join("\n");
}

function formatOverviewValue(label: string, value: string) {
  if (!value) return value;
  const normalizedLabel = normalizeSpecKey(label);

  if (normalizedLabel === "power") {
    return compactSelectableValue(label, value);
  }

  if (normalizedLabel === "cct") {
    return compactSelectableValue(label, value);
  }

  if (normalizedLabel === "lumen output") {
    return compactSelectableValue(label, value);
  }

  if (normalizedLabel === "voltage") {
    return normalizeOptionList(value, /\d[\d.\s-]*(?:v|vac|vdc)\b/i);
  }

  if (normalizedLabel === "efficacy") {
    return compactSelectableValue(label, value);
  }

  if (normalizedLabel.includes("dimension")) {
    const normalized = normalizeText(value);
    const inchMatch = normalized.match(/\(([^)"]*(?:\d+(?:\.\d+)?\s*"\s*(?:x|×)\s*)+\d+(?:\.\d+)?\s*")\)/i);
    if (inchMatch?.[1]) {
      return normalizeText(inchMatch[1]).replace(/\s*[x×]\s*/g, ' x ');
    }

    const allQuotedValues = Array.from(normalized.matchAll(/\d+(?:\.\d+)?\s*"/g)).map((match) => match[0].replace(/\s+/g, ""));
    if (allQuotedValues.length >= 2) {
      return allQuotedValues.join(" x ");
    }
  }

  if (normalizedLabel.includes("weight")) {
    const normalized = normalizeText(value);
    const lbMatches = Array.from(normalized.matchAll(/\d+(?:\.\d+)?\s*lbs?\b/gi)).map((match) => normalizeText(match[0]));
    if (lbMatches.length > 0) {
      return lbMatches.join(" / ");
    }
  }

  if (normalizedLabel === "warranty") {
    const matches = sortOptionValues(uniquePreserveOrder(
      Array.from(value.matchAll(/\d+(?:\.\d+)?/g)).map((match) => `${match[0]} Years`),
    ));
    return matches.join(" | ") || normalizeText(value);
  }

  if (normalizedLabel === "lifespan") {
    return normalizeLifespanValue(value);
  }

  if (normalizedLabel.includes("operating temp")) {
    return normalizeOperatingTemperatureClean(value);
  }

  return normalizeText(value);
}

function summarizeSensorTypeValue(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return "";

  const matches = uniquePreserveOrder([
    ...(/microwave/i.test(normalized) ? ["Microwave Sensor"] : []),
    ...(/pir|passive infrared/i.test(normalized) ? ["PIR Sensor"] : []),
    ...(/daylight/i.test(normalized) ? ["Daylight Sensor"] : []),
    ...(/occupancy|motion/i.test(normalized) ? ["Motion Sensor"] : []),
    ...(/bluetooth/i.test(normalized) ? ["Bluetooth Control"] : []),
    ...(/remote/i.test(normalized) ? ["Remote Control"] : []),
  ]);

  if (matches.length > 0) {
    return matches.slice(0, 3).join(", ");
  }

  return trimWords(normalized, 8);
}

function formatFahrenheitValue(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
}

function convertCelsiusToFahrenheit(value: number) {
  return (value * 9) / 5 + 32;
}

function normalizeOperatingTemperature(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return normalized;

  const fahrenheitRangeMatch = normalized.match(
    /\(?\s*(-?\d+(?:\.\d+)?)\s*°?\s*F\s*(?:to|TO|~|–|—|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*F\s*\)?/i,
  );

  if (fahrenheitRangeMatch) {
    return `${formatFahrenheitValue(Number(fahrenheitRangeMatch[1]))}°F ~ ${formatFahrenheitValue(Number(fahrenheitRangeMatch[2]))}°F`;
  }

  if (/°?\s*f\b|fahrenheit/i.test(normalized) && !/°?\s*c\b|celsius/i.test(normalized)) {
    return normalized.replace(/\s+/g, " ").trim();
  }

  const rangeMatch = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*C?\s*(?:to|TO|~|–|—|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*C\b/i,
  );

  if (rangeMatch) {
    const minimum = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rangeMatch[1])));
    const maximum = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rangeMatch[2])));
    return `${minimum}°F ~ ${maximum}°F`;
  }

  const converted = normalized.replace(/(-?\d+(?:\.\d+)?)\s*°?\s*C\b/gi, (_, rawValue: string) => {
    const fahrenheitValue = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rawValue)));
    return `${fahrenheitValue}°F`;
  });

  const convertedFahrenheitRangeMatch = converted.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*F\s*(?:to|TO|~|–|—|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*F/i,
  );

  if (convertedFahrenheitRangeMatch) {
    return `${formatFahrenheitValue(Number(convertedFahrenheitRangeMatch[1]))}°F ~ ${formatFahrenheitValue(Number(convertedFahrenheitRangeMatch[2]))}°F`;
  }

  return converted.replace(/\s+/g, " ").trim();
}

function normalizeOperatingTemperatureClean(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return normalized;

  const fahrenheitRangeMatch = normalized.match(
    /\(?\s*(-?\d+(?:\.\d+)?)\s*°?\s*F\s*(?:to|TO|~|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*F\s*\)?/i,
  );

  if (fahrenheitRangeMatch) {
    return `${formatFahrenheitValue(Number(fahrenheitRangeMatch[1]))}°F ~ ${formatFahrenheitValue(Number(fahrenheitRangeMatch[2]))}°F`;
  }

  if (/°?\s*f\b|fahrenheit/i.test(normalized) && !/°?\s*c\b|celsius/i.test(normalized)) {
    return normalized.replace(/\s+/g, " ").trim();
  }

  const rangeMatch = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*C?\s*(?:to|TO|~|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*C\b/i,
  );

  if (rangeMatch) {
    const minimum = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rangeMatch[1])));
    const maximum = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rangeMatch[2])));
    return `${minimum}°F ~ ${maximum}°F`;
  }

  const converted = normalized.replace(/(-?\d+(?:\.\d+)?)\s*°?\s*C\b/gi, (_, rawValue: string) => {
    const fahrenheitValue = formatFahrenheitValue(convertCelsiusToFahrenheit(Number(rawValue)));
    return `${fahrenheitValue}°F`;
  });

  const convertedFahrenheitRangeMatch = converted.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*F\s*(?:to|TO|~|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*F/i,
  );

  if (convertedFahrenheitRangeMatch) {
    return `${formatFahrenheitValue(Number(convertedFahrenheitRangeMatch[1]))}°F ~ ${formatFahrenheitValue(Number(convertedFahrenheitRangeMatch[2]))}°F`;
  }

  return converted.replace(/\s+/g, " ").trim();
}

function normalizeLifespanValue(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return normalized;

  const hourMatches = uniquePreserveOrder(
    Array.from(normalized.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi))
      .map((match) => normalizeText(match[1]).replace(/,/g, ""))
      .filter(Boolean),
  );

  if (hourMatches.length > 0) {
    return sortOptionValues(hourMatches.map((match) => `${match} Hours`)).join(" | ");
  }

  const largeNumberMatches = uniquePreserveOrder(
    Array.from(normalized.matchAll(/\d[\d,]*(?:\.\d+)?/g))
      .map((match) => normalizeText(match[0]).replace(/,/g, ""))
      .filter((match) => Number(match) >= 1000),
  );

  if (largeNumberMatches.length > 0) {
    return sortOptionValues(largeNumberMatches.map((match) => `${match} Hours`)).join(" | ");
  }

  return normalized;
}

function getSpecValue(specs: TechnicalSpec[], keys: string[]) {
  const normalizedKeys = new Set(keys.map((key) => normalizeSpecKey(key)));
  const matches = specs.filter((spec) =>
    normalizedKeys.has(normalizeSpecKey(spec.parameter)),
  );

  if (matches.length === 0) return "";

  const rawValues = uniquePreserveOrder(matches
    .map((match) => normalizeText(match.specification))
    .filter((value) => value && value !== "Not Specified"));

  const values =
    rawValues.length > 1
      ? rawValues.filter((value) => !isSelectableMarker(value))
      : rawValues;

  return values.join(" | ");
}

function getAllSpecs(spec: ExtendedExtractedSpec) {
  return [...spec.technicalSpecs, ...(spec.categorySpecificSpecs ?? [])];
}

function getVariantOverviewValue(spec: ExtendedExtractedSpec, keys: string[]) {
  const parameters = spec.variantOverview?.parameters ?? [];
  const matrix = spec.variantOverview?.matrix ?? [];
  if (parameters.length === 0 || matrix.length === 0) return "";

  const normalizedKeys = new Set(keys.map((key) => normalizeSpecKey(key)));
  const matchingIndexes = parameters.reduce<number[]>((indexes, parameter, index) => {
    if (normalizedKeys.has(normalizeSpecKey(parameter))) {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (matchingIndexes.length === 0) return "";

  const values = uniquePreserveOrder(
    matrix.flatMap((row) =>
      matchingIndexes.map((index) => normalizeText(row[index] ?? "")).filter((value) => value && value !== "Not Specified"),
    ),
  );

  return values.join(" | ");
}

function getSpecValueFromSpec(spec: ExtendedExtractedSpec, keys: string[]) {
  return getSpecValue(getAllSpecs(spec), keys);
}

function getOverviewValue(spec: ExtendedExtractedSpec, keys: string[]) {
  return getVariantOverviewValue(spec, keys) || getSpecValueFromSpec(spec, keys);
}

function extractNumericValues(value: string, pattern: RegExp) {
  return uniquePreserveOrder(
    Array.from(value.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`)))
      .map((match) => match[1] ?? match[0])
      .map((match) => normalizeText(match).replace(/,/g, "")),
  )
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function formatEstimatedNumber(value: number, decimals = 2) {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

function parseWattages(spec: ExtendedExtractedSpec) {
  return extractNumericValues(
    getOverviewValue(spec, ["Wattage", "Power"]),
    /(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b/gi,
  );
}

function parseLumens(spec: ExtendedExtractedSpec) {
  return extractNumericValues(
    getOverviewValue(spec, ["Lumen Output", "Lumens"]),
    /(\d[\d,]*(?:\.\d+)?)\s*lm\b/gi,
  );
}

function parseEfficacies(spec: ExtendedExtractedSpec) {
  return extractNumericValues(
    getOverviewValue(spec, ["Efficacy", "Efficacy (lm/W)"]),
    /(\d[\d,]*(?:\.\d+)?)\s*(?:lm\/w|lm\s*\/\s*w)\b/gi,
  );
}

function parseVoltages(spec: ExtendedExtractedSpec) {
  return extractNumericValues(
    getOverviewValue(spec, ["Input Voltage", "Voltage"]),
    /(\d+(?:\.\d+)?)\s*(?:v|vac|vdc)\b/gi,
  );
}

function formatEstimatedSeries(values: number[], unit: string, decimals = 2) {
  if (values.length === 0) return "";
  return values.map((value) => `${formatEstimatedNumber(value, decimals)} ${unit}`).join(" | ");
}

function deriveEstimatedOverviewValue(spec: ExtendedExtractedSpec, label: string) {
  const normalizedLabel = normalizeSpecKey(label);
  const wattages = parseWattages(spec);
  const lumens = parseLumens(spec);
  const efficacies = parseEfficacies(spec);
  const voltages = parseVoltages(spec);

  if (normalizedLabel === "current" && wattages.length > 0 && voltages.length > 0) {
    const estimatedCurrents = uniquePreserveOrder(
      wattages.flatMap((wattage) =>
        voltages.map((voltage) => formatEstimatedNumber(wattage / voltage, 2)),
      ),
    )
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    return formatEstimatedSeries(estimatedCurrents, "A", 2)
      ? `${formatEstimatedSeries(estimatedCurrents, "A", 2)} (Estimated)`
      : "";
  }

  if (normalizedLabel === "efficacy" && lumens.length > 0 && wattages.length > 0 && lumens.length === wattages.length) {
    const estimatedEfficacies = lumens.map((lumen, index) => lumen / wattages[index]);
    return `${formatEstimatedSeries(estimatedEfficacies, "lm/W", 2)} (Estimated)`;
  }

  if (normalizedLabel === "lumen output" && wattages.length > 0 && efficacies.length > 0) {
    const pairedLength = Math.min(wattages.length, efficacies.length);
    if (pairedLength > 0) {
      const estimatedLumens = Array.from({ length: pairedLength }, (_, index) => wattages[index] * efficacies[index]);
      return `${formatEstimatedSeries(estimatedLumens, "lm", 0)} (Estimated)`;
    }
  }

  if (normalizedLabel === "power" && lumens.length > 0 && efficacies.length > 0) {
    const pairedLength = Math.min(lumens.length, efficacies.length);
    if (pairedLength > 0) {
      const estimatedWattages = Array.from({ length: pairedLength }, (_, index) => lumens[index] / efficacies[index]);
      return `${formatEstimatedSeries(estimatedWattages, "W", 0)} (Estimated)`;
    }
  }

  return "";
}

/** Efficacy computed directly from the fixture's own Power and Lumen lists (Efficacy = Lumens / Power,
 *  whole lm/W). Requires the two lists to be aligned (equal length) so each power pairs with its own
 *  lumen. Returns a dash-joined list of the distinct efficacies (selectable style), or a "min - max
 *  lm/W" range when there are many. Empty when the lists aren't aligned. */
/** Efficacy = lumens / power for each aligned pair (NEVER the vendor's stated value), formatted
 *  as a hyphen list. Works from two raw strings so it can run off the draft's own Power/Lumen rows. */
function efficacyFromWattsLumens(powerText: string, lumenText: string) {
  const wattages = extractNumericValues(powerText, /(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b/gi);
  const lumens = extractNumericValues(lumenText, /(\d[\d,]*(?:\.\d+)?)\s*lm\b/gi);
  const pairCount = Math.min(wattages.length, lumens.length);
  if (pairCount < 1) return "";

  const allValues = uniquePreserveOrder(
    Array.from({ length: pairCount }, (_, index) =>
      wattages[index] > 0 ? Math.round(lumens[index] / wattages[index]) : NaN,
    )
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => String(value)),
  ).map(Number);
  // Keep only PHYSICALLY POSSIBLE efficacies (real LEDs are ~40-220 lm/W). A value outside this
  // band means the power/lumen pair was misaligned by the extraction, not a true efficacy — drop it
  // so the sheet never shows an impossible figure like "228 lm/W". Fall back to the raw set only if
  // filtering would leave nothing.
  const plausible = allValues.filter((value) => value >= 40 && value <= 220);
  const values = plausible.length > 0 ? plausible : allValues;
  if (values.length === 0) return "";
  if (values.length === 1) return `${values[0]} lm/W`;
  if (values.length <= 8) return `${values.join(" - ")} lm/W`;
  return `${Math.min(...values)} - ${Math.max(...values)} lm/W`;
}

function deriveEfficacyFromPowerLumen(spec: ExtendedExtractedSpec) {
  return efficacyFromWattsLumens(
    getOverviewValue(spec, ["Wattage", "Power"]),
    getOverviewValue(spec, ["Lumen Output", "Lumens"]),
  );
}

function getCategoryLabel(spec: ExtendedExtractedSpec) {
  return normalizeText(spec.productCategory) || normalizeText(getSpecValueFromSpec(spec, ["Product Type"]));
}

function normalizeSpecKey(value: string) {
  return normalizeText(canonicalizeSpecLabel(value)).toLowerCase();
}

function getOverviewTemplateRows(spec: ExtendedExtractedSpec) {
  const source = `${getCategoryLabel(spec)} ${spec.productName} ${String(spec.subCategory ?? "")}`.toLowerCase();

  // The Indoor / Outdoor master lists are the primary overview taxonomy. Resolve the broad
  // category from the recognised fixture type first, then fall back to direct keyword hints.
  const broad = (
    predictFixtureProfile(spec.productName, String(spec.subCategory ?? ""), getCategoryLabel(spec))?.category ?? ""
  ).toLowerCase();
  // Three master lists only: Hazardous Location, Outdoor, Indoor.
  if (
    broad.includes("hazard") || broad.includes("explosion") ||
    source.includes("hazard") || source.includes("explosion")
  ) {
    return CATEGORY_OVERVIEW_TEMPLATES.hazardous;
  }
  if (broad.includes("outdoor") || source.includes("outdoor")) return CATEGORY_OVERVIEW_TEMPLATES.outdoor;
  if (broad.includes("indoor") || source.includes("indoor")) return CATEGORY_OVERVIEW_TEMPLATES.indoor;

  // Default to the Indoor master list (the most common case).
  return CATEGORY_OVERVIEW_TEMPLATES.indoor;
}

function buildOverviewRows(spec: ExtendedExtractedSpec): OverviewRow[] {
  const allSpecs = getAllSpecs(spec);
  const template = getOverviewTemplateRows(spec).filter(
    (row) => !isExcludedOverviewLabel(row.label),
  );
  const variantRows = buildPreviewVariantRows(spec);
  const buildVariantOverviewValue = (label: string) => {
    const normalizedLabel = normalizeSpecKey(label);
    if (variantRows.length < 2) return "";

    const isPowerSelectableLabel =
      normalizedLabel === "power"
      || normalizedLabel === "power selectable"
      || normalizedLabel === "max power";
    const isLumenLabel = normalizedLabel === "lumens" || normalizedLabel === "lumen output";
    const isCctLabel =
      normalizedLabel === "cct"
      || normalizedLabel === "color temperature"
      || normalizedLabel === "color temperature (selectable)"
      || normalizedLabel === "color temp (selectable)";

    const pickValue = (row: (typeof variantRows)[number]) => {
      if (isPowerSelectableLabel) return row.power;
      if (isLumenLabel) return row.lumens;
      if (isCctLabel) return row.cct;
      return "";
    };

    if (isPowerSelectableLabel) {
      // Power shows PER VARIANT/SIZE: one selectable fixture -> a single hyphen-joined line; genuine
      // size/attribute variants -> one labelled line each (never every wattage merged into one line).
      return buildVariantPowerValue(spec, label);
    }

    if (isCctLabel) {
      const grouped = new Map<string, string[]>();

      variantRows.forEach((row) => {
        const cctValue = compactSelectableValue(label, normalizeText(row.cct));
        if (!isSpecified(cctValue)) return;
        const fixturePower = [normalizeText(row.fixture), normalizeText(row.power)]
          .filter((value) => isSpecified(value))
          .join(" - ");
        const existing = grouped.get(cctValue) ?? [];
        if (fixturePower) existing.push(fixturePower);
        grouped.set(cctValue, existing);
      });

      return Array.from(grouped.entries())
        .map(([cctValue, fixturePowers]) => {
          const uniqueFixturePowers = uniquePreserveOrder(fixturePowers);
          if (uniqueFixturePowers.length === 0 || uniqueFixturePowers.length === variantRows.length) {
            return cctValue;
          }
          return `${uniqueFixturePowers.join(" | ")}: ${cctValue}`;
        })
        .join("\n");
    }

    const values = variantRows
      .map((row) => {
        const itemValue = compactSelectableValue(label, normalizeText(pickValue(row)));
        if (!isSpecified(itemValue)) return "";
        return isSpecified(row.fixture) ? `${row.fixture}: ${itemValue}` : itemValue;
      })
      .filter(Boolean);

    return values.join("\n");
  };

  const templateRows = template.map((row, index) => {
    // Efficacy is ALWAYS computed from this fixture's own Power & Lumen (lumens / power) — never
    // copied from the vendor's stated efficacy. If power/lumen aren't available it stays blank.
    const isEfficacyRow = normalizeSpecKey(row.label) === "efficacy";
    return {
      id: `template-${index}-${normalizeSpecKey(row.label)}`,
      label: row.label,
      included: true,
      value: isEfficacyRow
        ? deriveEfficacyFromPowerLumen(spec)
        : buildVariantOverviewValue(row.label) ||
          formatOverviewValue(row.label, getOverviewValue(spec, row.keys)) ||
          deriveEstimatedOverviewValue(spec, row.label),
    };
  });

  const templateKeys = new Set(
    template.flatMap((row) => row.keys.map((key) => normalizeSpecKey(key))),
  );

  const appendedRows = allSpecs
    .map((specRow) => ({
      label: canonicalizeSpecLabel(specRow.parameter),
      value: normalizeText(specRow.specification),
    }))
    .filter((row) => row.label)
    .filter((row) => isSpecified(row.value))
    .filter((row) => !isExcludedOverviewLabel(row.label))
    .filter((row) => !templateKeys.has(normalizeSpecKey(row.label)))
    .filter((row, index, rows) => rows.findIndex((candidate) => normalizeSpecKey(candidate.label) === normalizeSpecKey(row.label)) === index)
    .map((row, index) => ({
      id: `spec-${index}-${normalizeSpecKey(row.label)}`,
      label: row.label,
      // Only the category's PREDEFINED overview heads show by default; every EXTRA vendor spec that
      // isn't one of those heads starts in the optional pool (included:false) so the sheet stays
      // clean. The user can Include any of them from the optional section when they want it shown.
      included: false,
      value: normalizeSpecKey(row.label) === "sensor type"
        ? summarizeSensorTypeValue(row.value)
        : formatOverviewValue(row.label, row.value),
    }));

  return [...templateRows, ...appendedRows]
    .filter(
      (row, index, rows) =>
        isSpecified(row.label) &&
        // Keep the category's master heads even when the vendor PDF had no value, so the editor
        // lists every necessary head to fill; the sheet still only renders heads that have a value.
        (isSpecified(row.value) || row.included === true) &&
        rows.findIndex((candidate) => normalizeSpecKey(candidate.label) === normalizeSpecKey(row.label)) === index,
    )
    .map((row) =>
      ({ ...row, value: normalizeOverviewRowValue(row.label, row.value) }),
    );
}

function buildCertifications(spec: ExtendedExtractedSpec) {
  const values = new Set<string>();
  const certifications = getSpecValueFromSpec(spec, ["Certifications"]);
  const ipRating = getSpecValueFromSpec(spec, ["IP Rating"]);
  const ikRating = getSpecValueFromSpec(spec, ["IK Rating"]);
  const warranty = getSpecValueFromSpec(spec, ["Warranty (Years)", "Warranty"]);

  certifications
    .split(/[,/|]/)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .forEach((item) => values.add(item));

  if (ipRating && ipRating !== "Not Specified") values.add(ipRating);
  if (ikRating && ikRating !== "Not Specified") values.add(ikRating);
  if (warranty && warranty !== "Not Specified") values.add(warranty.replace(/\s+Years?/i, "YR"));

  return Array.from(values).slice(0, 4).join(", ");
}

function buildWarrantyCopy(spec: ExtendedExtractedSpec) {
  const rawWarranty = getSpecValueFromSpec(spec, ["Warranty (Years)", "Warranty"]);
  if (!isSpecified(rawWarranty)) {
    return "";
  }
  if (rawWarranty.includes("10")) return WARRANTY_COPY_10_YEARS;
  if (rawWarranty.includes("7")) return WARRANTY_COPY_7_YEARS;
  return WARRANTY_COPY_5_YEARS;
}

function normalizeWarrantyLabel(value: string) {
  const normalized = normalizeText(value);
  if (normalized.includes("10")) return "10 Years";
  if (normalized.includes("7")) return "7 Years";
  if (normalized.includes("5")) return "5 Years";
  return "";
}

function toTitleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .replace(/(\d+)w\b/g, "$1W");
}

function deriveTypeCore(spec: ExtendedExtractedSpec) {
  // Read the recognised fixture profile from the PRODUCT NAME first. The backend's coarse category
  // enum (panel/flood/street/…) has no "area" value, so it mislabels area lights as "flood" — which
  // used to turn an "Area Light" into a "Stadium Flood Light". The profile's own sub-category/group
  // is the reliable signal; only fall back to the raw category label when nothing matched.
  const profile = predictFixtureProfile(spec.productName, String(spec.subCategory ?? ""), getCategoryLabel(spec));
  const source = (
    profile
      ? `${profile.subCategory} ${profile.group} ${spec.productName}`
      : `${getCategoryLabel(spec)} ${spec.productName}`
  ).toLowerCase();

  if (source.includes("back-lit") || source.includes("back lit")) return "Back-Lit Panel";
  if (source.includes("panel")) return "Panel Light";
  // Area / High Mast BEFORE flood/stadium so they're never mistaken for a flood light.
  if (source.includes("area")) return "Area Light";
  if (source.includes("high mast")) return "High Mast Light";
  if (source.includes("stadium") || source.includes("flood")) return "Stadium Flood Light";
  if (source.includes("high bay")) return "High Bay Light";
  if (source.includes("post top")) return "Post Top Light";
  if (source.includes("wall pack")) return "Wall Pack";
  if (source.includes("street")) return "Street Light";
  if (source.includes("canopy")) return "Canopy Light";
  if (source.includes("troffer")) return "Troffer";
  if (source.includes("downlight")) return "Downlight";
  if (source.includes("bollard")) return "Bollard";
  if (source.includes("retrofit")) return "Retrofit Lamp";

  const fallback = getCategoryLabel(spec);
  return toTitleCase(fallback.split(/[(),/]/)[0] ?? fallback);
}

function deriveNameDescriptor(spec: ExtendedExtractedSpec) {
  const keywordSource = [
    spec.productName,
    spec.alternateName,
    ...spec.productFeatures,
    getSpecValueFromSpec(spec, ["Dimming"]),
  ]
    .join(" ")
    .toLowerCase();

  if (keywordSource.includes("sensor")) return "Sensor";
  if (keywordSource.includes("emergency")) return "Emergency Ready";
  if (keywordSource.includes("dimm")) return "Dimmable";
  if (getSpecValueFromSpec(spec, ["Power", "Wattage"]).includes("|")) return "Selectable";
  return "Performance";
}

function deriveWattageName(spec: ExtendedExtractedSpec) {
  const wattage = getSpecValueFromSpec(spec, ["Power", "Wattage"]);
  const matches = [...wattage.matchAll(/(\d+(?:\.\d+)?)\s*W/gi)].map((match) => Number(match[1]));
  if (matches.length === 0) return "";
  return `${Math.max(...matches)}W`;
}

function deriveProductNameFeatureToken(spec: ExtendedExtractedSpec) {
  const keywordSource = [
    spec.productName,
    spec.alternateName,
    ...spec.productFeatures,
    ...spec.notes,
    getSpecValueFromSpec(spec, ["Dimming"]),
    getSpecValueFromSpec(spec, ["Sensor Type", "Sensor Compatibility"]),
  ]
    .join(" ")
    .toLowerCase();

  if (keywordSource.includes("sensor")) return "Sense";
  if (keywordSource.includes("emergency")) return "Guard";
  if (keywordSource.includes("dimm")) return "Flux";
  if (keywordSource.includes("selectable")) return "Shift";
  if (keywordSource.includes("wireless") || keywordSource.includes("bluetooth") || keywordSource.includes("mesh")) return "Mesh";
  if (keywordSource.includes("back-lit") || keywordSource.includes("back lit")) return "Halo";
  if (keywordSource.includes("high bay")) return "Forge";
  return "Prime";
}

function buildProductNameRegistryKey(spec: ExtendedExtractedSpec) {
  return [
    deriveTypeCore(spec),
    spec.productName,
    spec.alternateName,
    getSpecValueFromSpec(spec, ["Power", "Wattage"]),
    getSpecValueFromSpec(spec, ["Voltage", "Input Voltage"]),
    getSpecValueFromSpec(spec, ["Lumen Output", "Lumens"]),
    getSpecValueFromSpec(spec, ["Color Temperature (Selectable)", "CCT"]),
  ]
    .map((item) => normalizeText(item))
    .join("|");
}

function readProductNameRegistry(): ProductNameRegistry {
  if (typeof window === "undefined") {
    return { assigned: {}, used: [] };
  }

  try {
    const raw = window.localStorage.getItem(PRODUCT_NAME_REGISTRY_KEY);
    if (!raw) return { assigned: {}, used: [] };
    const parsed = JSON.parse(raw) as Partial<ProductNameRegistry>;
    return {
      assigned: parsed.assigned && typeof parsed.assigned === "object" ? parsed.assigned : {},
      used: Array.isArray(parsed.used) ? parsed.used.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { assigned: {}, used: [] };
  }
}

function writeProductNameRegistry(registry: ProductNameRegistry) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PRODUCT_NAME_REGISTRY_KEY, JSON.stringify(registry));
}

// Single-word, lighting-brand-style name pools, keyed to where the fixture is used, so each suggested
// product name is ONE evocative word that sounds like a premium lighting range fitting the space
// (office -> "Meridian", hotel -> "Aura", retail -> "Lumina", warehouse -> "Ignis"). No fixture-type
// suffix is appended — the name is just the word. Application areas (plus category) pick the pool.
const APPLICATION_NAME_POOLS: Array<{ keys: string[]; names: string[] }> = [
  {
    keys: ["hospitality", "hotel", "restaurant", "lounge", "cafe", "bar", "resort", "leisure", "spa", "banquet"],
    names: ["Aura", "Halo", "Lumen", "Aria", "Solace", "Ember", "Verano", "Sol"],
  },
  {
    keys: ["retail", "store", "boutique", "showroom", "mall", "shop", "display", "merchandis", "fashion"],
    names: ["Lumina", "Allure", "Vivid", "Prism", "Radia", "Muse", "Eclat", "Marquee"],
  },
  {
    keys: ["office", "commercial", "corporate", "workspace", "workplace", "conference", "meeting", "coworking"],
    names: ["Meridian", "Zenith", "Lucent", "Lumio", "Vero", "Nova", "Vantage", "Axion"],
  },
  {
    keys: ["health", "hospital", "clinic", "medical", "care", "dental", "lab", "pharma", "wellness"],
    names: ["Clarity", "Lucent", "Pure", "Vita", "Serene", "Nimbus", "Aegis", "Halo"],
  },
  {
    keys: ["educat", "school", "campus", "classroom", "university", "college", "library", "academ"],
    names: ["Beacon", "Insight", "Sage", "Aspire", "Vega", "Nova", "Lumen", "Focal"],
  },
  {
    keys: ["warehouse", "industrial", "factory", "manufactur", "logistic", "distribution", "plant", "workshop"],
    names: ["Ignis", "Flare", "Blaze", "Volt", "Apex", "Titan", "Forge", "Halo"],
  },
  {
    keys: ["parking", "garage", "outdoor", "street", "roadway", "area", "facade", "landscape", "yard", "perimeter", "canopy", "stadium", "sports"],
    names: ["Horizon", "Aurora", "Beacon", "Sentinel", "Solaris", "Lumos", "Astra", "Vega"],
  },
  {
    keys: ["residential", "home", "apartment", "living", "villa", "condo"],
    names: ["Haven", "Aura", "Glow", "Ember", "Cove", "Sol", "Lumen", "Halcyon"],
  },
];

// General lighting-brand words used to top up any pool so there is always a large, on-brand supply.
const GENERAL_LIGHTING_NAMES = [
  "Lumen", "Lumina", "Lumio", "Luxor", "Aura", "Halo", "Nova", "Aurora", "Beacon", "Lucent",
  "Radia", "Vivid", "Prism", "Sol", "Solaris", "Photon", "Gleam", "Ray", "Spark", "Ember",
  "Flare", "Illume", "Ignis", "Vega", "Lyra", "Astra", "Zenith", "Eclipse", "Halcyon", "Elara",
  "Nimbus", "Lumos", "Vero", "Solace", "Meridian", "Horizon", "Aria", "Muse", "Allure", "Vantage",
];

/** Ordered pool of single-word names for this fixture: the lighting-brand pools that match its
 *  application areas (and category), topped up with the general lighting words and constellation
 *  codenames so a family with many variants never runs dry. */
function deriveApplicationNamePool(spec: ExtendedExtractedSpec): string[] {
  const src = [
    ...(Array.isArray(spec.applicationAreas) ? spec.applicationAreas : []),
    getCategoryLabel(spec),
    String(spec.subCategory ?? ""),
    spec.productName,
  ]
    .join(" ")
    .toLowerCase();
  const pool: string[] = [];
  const add = (name: string) => { if (name && !pool.includes(name)) pool.push(name); };
  for (const group of APPLICATION_NAME_POOLS) {
    if (group.keys.some((key) => src.includes(key))) group.names.forEach(add);
  }
  GENERAL_LIGHTING_NAMES.forEach(add);
  CONSTELLATION_CODENAMES.forEach(add);
  return pool;
}

// Deterministically coin a fresh single-word lighting-brand name (root + suffix) so we can keep
// generating UNIQUE one-word names without ever falling back to numbered variants.
const LIGHTING_NAME_ROOTS = [
  "Lum", "Lumi", "Lux", "Nov", "Sol", "Astr", "Veg", "Hal", "Aur", "Phot",
  "Lume", "Ray", "Orb", "Elar", "Ver", "Cel", "Zeph", "Lyr", "Ign", "Nyx",
];
const LIGHTING_NAME_SUFFIXES = ["a", "o", "os", "ia", "is", "ix", "on", "ara", "ora", "ex", "us", "en"];
function coinLightingName(index: number): string {
  const root = LIGHTING_NAME_ROOTS[index % LIGHTING_NAME_ROOTS.length];
  const suffix = LIGHTING_NAME_SUFFIXES[Math.floor(index / LIGHTING_NAME_ROOTS.length) % LIGHTING_NAME_SUFFIXES.length];
  const word = (root + suffix).toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The ordered pool of SINGLE-WORD candidate names sent to the backend registry, which reserves the
 *  first ones not already used by another product. Extended with many coined lighting words so the
 *  registry practically always has a unique one-word option and never numbers a name. */
function buildProductNameCandidates(spec: ExtendedExtractedSpec): string[] {
  const pool = deriveApplicationNamePool(spec);
  const registryKey = buildProductNameRegistryKey(spec);
  const baseIndex = pool.length ? hashString(registryKey) % pool.length : 0;
  const rotated = Array.from({ length: pool.length }, (_, offset) =>
    toTitleCase(normalizeText(pool[(baseIndex + offset) % pool.length])).replace(/\s+/g, " ").trim(),
  );
  const coined = Array.from({ length: 200 }, (_, i) => coinLightingName(i));
  return [...rotated, ...coined].filter(Boolean);
}

function buildProductNameRecommendations(spec: ExtendedExtractedSpec) {
  const typeCore = deriveTypeCore(spec);
  const descriptor = deriveNameDescriptor(spec);
  const wattage = deriveWattageName(spec);
  const featureToken = deriveProductNameFeatureToken(spec);
  const namePool = deriveApplicationNamePool(spec);
  const registryKey = buildProductNameRegistryKey(spec);
  const registry = readProductNameRegistry();
  const existing = uniquePreserveOrder(registry.assigned[registryKey]?.filter(Boolean) ?? []);

  if (existing.length >= 3) {
    return existing.slice(0, 3);
  }

  const usedNames = new Set(registry.used.map((item) => item.toLowerCase()));
  existing.forEach((name) => usedNames.add(name.toLowerCase()));
  // One SINGLE-WORD name per pool entry, rotated by the fixture so the three suggestions are
  // distinct, on-brand lighting words (e.g. "Meridian", "Zenith", "Lucent") — no fixture-type suffix.
  const baseIndex = namePool.length ? hashString(registryKey) % namePool.length : 0;
  const recommendations = Array.from({ length: namePool.length }, (_, offset) =>
    toTitleCase(normalizeText(namePool[(baseIndex + offset) % namePool.length])).replace(/\s+/g, " ").trim(),
  ).filter(Boolean);
  void typeCore;
  void descriptor;
  void wattage;
  void featureToken;

  const uniqueRecommendations: string[] = [];
  const localSeen = new Set<string>();

  for (const recommendation of recommendations) {
    const normalized = recommendation.toLowerCase();
    if (localSeen.has(normalized) || usedNames.has(normalized)) {
      continue;
    }
    localSeen.add(normalized);
    uniqueRecommendations.push(recommendation);
    if (uniqueRecommendations.length >= 3) {
      break;
    }
  }

  // Still short? Coin a fresh single-word lighting name — never a numbered variant.
  let coinIdx = 0;
  while (uniqueRecommendations.length < 3 && coinIdx < 500) {
    const coined = coinLightingName(coinIdx);
    coinIdx += 1;
    const normalized = coined.toLowerCase();
    if (!usedNames.has(normalized) && !localSeen.has(normalized)) {
      localSeen.add(normalized);
      uniqueRecommendations.push(coined);
    }
  }

  const assigned = uniquePreserveOrder([...existing, ...uniqueRecommendations]).slice(0, 3);
  registry.assigned[registryKey] = assigned;
  registry.used = Array.from(new Set([...registry.used, ...assigned]));
  writeProductNameRegistry(registry);

  return assigned;
}

function inferQualificationBadgeIds(spec: ExtendedExtractedSpec) {
  const keywordSource = [
    buildCertifications(spec),
    getSpecValueFromSpec(spec, ["Dimming"]),
    getSpecValueFromSpec(spec, ["IP Rating"]),
    getSpecValueFromSpec(spec, ["Certifications"]),
    spec.productName,
    spec.alternateName,
    ...spec.productFeatures,
    ...spec.notes,
  ]
    .join(" ")
    .toLowerCase();

  const selected = QUALIFICATION_BADGES.filter((badge) =>
    badge.keywords.some((keyword) => keywordSource.includes(keyword)),
  ).map((badge) => badge.id);

  const wattage = getSpecValueFromSpec(spec, ["Power", "Wattage"]);
  const cct = getSpecValueFromSpec(spec, ["Color Temperature (Selectable)", "CCT"]);

  if (wattage.includes("|") && !selected.includes("power_selectable")) {
    selected.push("power_selectable");
  }

  if (cct.includes("|") && !selected.includes("cct_selectable")) {
    selected.push("cct_selectable");
  }

  return selected;
}

/** Canonical lighting-fixture profiles: for each fixture type we know its broad category,
 *  a recommended sub-category name, and the application areas that fixture is typically used
 *  for. Used to auto-predict application areas (and fill an empty category / sub-category) from
 *  the product's title / category / sub-category text. Ordered most-specific first so a compound
 *  match ("linear high bay", "explosion proof") wins over a generic one ("high bay", "flood"). */
type FixtureProfile = {
  id: string;
  keywords: string[];
  category: string;
  subCategory: string;
  group: string;
  applications: string[];
};

const FIXTURE_PROFILES: FixtureProfile[] = [
  {
    id: "explosion_proof",
    keywords: ["explosion proof", "explosion-proof", "hazardous location", "hazloc", "class i div"],
    category: "Hazardous Location Lighting",
    subCategory: "Explosion Proof Luminaire",
    group: "Hazardous Location",
    applications: ["Oil & Gas Facilities", "Refineries", "Chemical Plants", "Mining Operations", "Paint Booths"],
  },
  {
    id: "jelly_jar",
    keywords: ["jelly jar", "jelly-jar", "jelly jar light", "jam jar"],
    category: "Hazardous Location Lighting",
    subCategory: "Jelly Jar Light",
    group: "Hazardous Location",
    applications: ["Wet Locations", "Utility Rooms", "Stairwells", "Walk-in Coolers", "Parking Structures", "Marine Areas"],
  },
  {
    id: "drop_light",
    keywords: ["drop light", "drop-light", "droplight", "hand lamp", "portable work light"],
    category: "Hazardous Location Lighting",
    subCategory: "Drop Light",
    group: "Hazardous Location",
    applications: ["Maintenance Bays", "Inspection Areas", "Workshops", "Industrial Facilities", "Utility Work"],
  },
  {
    id: "vapor_tight",
    keywords: ["vapor tight", "vapor-tight", "vaportight", "tri-proof", "tri proof", "triproof", "waterproof linear"],
    category: "Indoor / Outdoor Lighting",
    subCategory: "Vapor Tight Linear",
    group: "Vapor Tight",
    applications: ["Parking Garages", "Car Washes", "Food Processing Plants", "Cold Storage", "Warehouses", "Loading Docks"],
  },
  {
    id: "linear_high_bay",
    keywords: ["linear high bay", "linear highbay"],
    category: "Indoor Lighting",
    subCategory: "Linear High Bay",
    group: "High Bays",
    applications: ["Warehouses", "Manufacturing Facilities", "Distribution Centers", "Assembly Lines", "Big-Box Retail"],
  },
  {
    id: "high_bay",
    keywords: ["high bay", "highbay", "ufo", "high-bay"],
    category: "Indoor Lighting",
    subCategory: "UFO High Bay",
    group: "High Bays",
    applications: ["Warehouses", "Manufacturing Facilities", "Gymnasiums", "Distribution Centers", "Workshops", "Big-Box Retail"],
  },
  {
    id: "low_bay",
    keywords: ["low bay", "lowbay", "low-bay"],
    category: "Indoor Lighting",
    subCategory: "Low Bay",
    group: "Low Bays",
    applications: ["Retail Stores", "Workshops", "Storage Areas", "Auto Service Bays", "Warehouses"],
  },
  {
    id: "troffer",
    keywords: ["troffer", "2x2", "2x4", "1x4", "2'x4'", "recessed panel"],
    category: "Indoor Lighting",
    subCategory: "Recessed Troffer",
    group: "Troffers",
    applications: ["Offices", "Classrooms", "Healthcare Facilities", "Corridors", "Conference Rooms"],
  },
  {
    id: "panel",
    keywords: ["flat panel", "back-lit panel", "backlit panel", "edge-lit", "edge lit", "panel light", "panel"],
    category: "Indoor Lighting",
    subCategory: "Flat Panel",
    group: "Panels",
    applications: ["Offices", "Schools", "Hospitals", "Clinics", "Retail Stores", "Conference Rooms"],
  },
  {
    id: "wrap",
    keywords: ["wraparound", "wrap around", "wrap-around", "wrap light"],
    category: "Indoor Lighting",
    subCategory: "LED Wraparound",
    group: "Wraparounds",
    applications: ["Corridors", "Stairwells", "Basements", "Utility Rooms", "Garages", "Storage Areas"],
  },
  {
    id: "strip",
    keywords: ["strip light", "linear strip", "industrial strip", "shop light"],
    category: "Indoor Lighting",
    subCategory: "Linear Strip",
    group: "Strip Lights",
    applications: ["Warehouses", "Garages", "Utility Rooms", "Retail Stockrooms", "Cove Lighting"],
  },
  {
    id: "linear_pendant",
    keywords: [
      "architectural linear pendant", "linear pendant", "pendant linear", "suspended linear",
      "linear suspension", "suspension linear", "linear pendant light", "led pendant",
    ],
    category: "Indoor Lighting",
    subCategory: "Linear Pendant",
    group: "Linear Lighting",
    applications: ["Offices", "Conference Rooms", "Reception Areas", "Retail Environments", "Educational Institutions", "Commercial Spaces"],
  },
  {
    id: "recessed_linear",
    keywords: ["recessed architectural linear", "recessed linear", "linear recessed", "recessed linear light"],
    category: "Indoor Lighting",
    subCategory: "Recessed Linear",
    group: "Linear Lighting",
    applications: ["Offices", "Conference Rooms", "Corridors", "Retail Stores", "Healthcare Facilities", "Educational Institutions"],
  },
  {
    id: "architectural_linear",
    keywords: ["architectural linear", "linear architectural", "surface linear", "surface mount linear", "linear surface"],
    category: "Indoor Lighting",
    subCategory: "Architectural Linear",
    group: "Linear Lighting",
    applications: ["Offices", "Conference Rooms", "Reception Areas", "Retail Environments", "Commercial Spaces", "Hospitality Venues"],
  },
  {
    id: "linear_general",
    keywords: [
      "linear light", "linear lighting", "linear luminaire", "linear fixture", "led linear",
      "linear led", "pendant light", "pendant", "linear",
    ],
    category: "Indoor Lighting",
    subCategory: "Linear Light",
    group: "Linear Lighting",
    applications: ["Offices", "Conference Rooms", "Retail Stores", "Educational Institutions", "Commercial Spaces", "Hospitality Venues"],
  },
  {
    id: "downlight",
    keywords: ["downlight", "down light", "recessed can", "can light", "recessed downlight"],
    category: "Indoor Lighting",
    subCategory: "Recessed Downlight",
    group: "Downlights",
    applications: ["Offices", "Hotels", "Corridors", "Retail Stores", "Lobbies", "Residential Spaces"],
  },
  {
    id: "track",
    keywords: ["track light", "track head", "track spot", "track"],
    category: "Indoor Lighting",
    subCategory: "Track Light",
    group: "Track Lighting",
    applications: ["Retail Showrooms", "Galleries", "Museums", "Restaurants", "Boutiques"],
  },
  {
    id: "tube",
    keywords: ["t8", "t5", "led tube", "tube light", "linear tube"],
    category: "Indoor Lighting",
    subCategory: "LED Tube",
    group: "Tube Lights",
    applications: ["Offices", "Schools", "Retail Stores", "Hospitals", "Corridors"],
  },
  {
    id: "refrigeration",
    keywords: ["refrigeration", "cooler light", "freezer light", "cooler & freezer", "refrigerated case", "walk-in cooler"],
    category: "Indoor Lighting",
    subCategory: "Refrigeration Light",
    group: "Refrigeration Lighting",
    applications: ["Walk-in Coolers", "Freezers", "Refrigerated Display Cases", "Grocery Stores", "Cold Storage"],
  },
  {
    id: "wall_pack",
    keywords: ["wall pack", "wallpack", "wall-pack"],
    category: "Outdoor Lighting",
    subCategory: "Wall Pack",
    group: "Wall Packs",
    applications: ["Building Perimeters", "Entrances", "Walkways", "Loading Docks", "Security Lighting"],
  },
  {
    id: "high_mast",
    keywords: ["high mast", "high-mast", "highmast", "high mast light", "high mast luminaire", "mast light"],
    category: "Outdoor Lighting",
    subCategory: "High Mast Light",
    group: "High Mast Lights",
    applications: ["Airports", "Seaports", "Highways & Interchanges", "Rail Yards", "Container Yards", "Large Open Areas"],
  },
  {
    id: "yard_light",
    keywords: ["yard light", "yard-light", "barn light", "security barn"],
    category: "Outdoor Lighting",
    subCategory: "Yard Light",
    group: "Yard Lights",
    applications: ["Farms", "Barns", "Driveways", "Rural Properties", "Storage Yards", "Security Areas"],
  },
  {
    id: "flood",
    keywords: ["flood light", "floodlight", "flood-light", "flood"],
    category: "Outdoor Lighting",
    subCategory: "Flood Light",
    group: "Flood Lights",
    applications: ["Sports Fields", "Building Facades", "Parking Lots", "Signage", "Security Lighting", "Landscapes"],
  },
  {
    id: "area_light",
    keywords: ["area light", "shoebox", "parking lot light", "pole light", "site light", "area"],
    category: "Outdoor Lighting",
    subCategory: "Area Luminaire",
    group: "Area Lights",
    applications: ["Parking Lots", "Roadways", "Campuses", "Car Dealerships", "Pathways"],
  },
  {
    id: "post_top",
    keywords: ["post top", "post-top", "posttop", "post top light", "post-top luminaire"],
    category: "Outdoor Lighting",
    subCategory: "Post Top Light",
    group: "Post Top Lights",
    applications: ["Walkways", "Parks", "Campuses", "Plazas", "Streetscapes", "Parking Lots"],
  },
  {
    id: "street",
    keywords: ["street light", "streetlight", "roadway light", "cobra head", "cobrahead"],
    category: "Outdoor Lighting",
    subCategory: "Street Light",
    group: "Street Lights",
    applications: ["Roadways", "Highways", "Streets", "Pathways", "Public Areas"],
  },
  {
    id: "canopy",
    keywords: ["canopy light", "canopy", "gas station light"],
    category: "Outdoor Lighting",
    subCategory: "Canopy Light",
    group: "Canopy Lights",
    applications: ["Gas Stations", "Parking Garages", "Building Entrances", "Drive-Throughs", "Loading Docks"],
  },
  {
    id: "stadium",
    keywords: ["stadium", "sports light", "sport light", "arena light"],
    category: "Outdoor Lighting",
    subCategory: "Stadium / Sports Light",
    group: "Sports Lighting",
    applications: ["Stadiums", "Sports Fields", "Arenas", "Tennis Courts", "Athletic Facilities"],
  },
  {
    id: "corn",
    keywords: ["corn bulb", "corn lamp", "corn light", "retrofit lamp", "hid retrofit"],
    category: "Indoor / Outdoor Lighting",
    subCategory: "Corn Retrofit Lamp",
    group: "Retrofit Lamps",
    applications: ["Warehouses", "Parking Lots", "Street Lights", "High Bays", "Post-Top Fixtures"],
  },
  {
    id: "bollard",
    keywords: ["bollard"],
    category: "Outdoor Lighting",
    subCategory: "Bollard Light",
    group: "Bollards",
    applications: ["Walkways", "Landscapes", "Parks", "Building Entrances", "Pathways"],
  },
  {
    id: "grow",
    keywords: ["grow light", "horticulture", "grow lamp"],
    category: "Horticultural Lighting",
    subCategory: "Grow Light",
    group: "Grow Lights",
    applications: ["Greenhouses", "Indoor Farms", "Vertical Farms", "Nurseries", "Cultivation Rooms"],
  },
  {
    id: "exit",
    keywords: ["exit sign", "emergency light", "egress", "exit combo"],
    category: "Life Safety Lighting",
    subCategory: "Exit / Emergency",
    group: "Emergency & Exit",
    applications: ["Egress Paths", "Corridors", "Stairwells", "Exits", "Public Buildings"],
  },
];

/** Find the fixture profile that best matches a product's naming text. Longer keyword matches
 *  win (so "linear high bay" beats "high bay"); ties break toward the earlier, more-specific
 *  profile in the ordered list. Returns null when nothing matches. */
function predictFixtureProfile(...sources: Array<string | undefined>): FixtureProfile | null {
  // Check each source IN ORDER (the product name/title is passed first, then subtitle, category,
  // sub-category). The first source that matches any fixture wins — so the IKIO product name
  // ("Pegasus Track") decides the fixture type before incidental words in the messy vendor text
  // ("...Surface Mount Down Light") can mislead it. Within one source, the longest keyword wins.
  for (const source of sources) {
    const haystack = (source ?? "").toLowerCase();
    if (!haystack.trim()) continue;
    let best: { profile: FixtureProfile; score: number } | null = null;
    for (const profile of FIXTURE_PROFILES) {
      for (const keyword of profile.keywords) {
        if (haystack.includes(keyword)) {
          const score = keyword.length;
          if (!best || score > best.score) best = { profile, score };
          break;
        }
      }
    }
    if (best) return best.profile;
  }
  return null;
}

function countWords(value: string) {
  return normalizeText(value).split(/\s+/).filter(Boolean).length;
}

function trimWords(value: string, limit: number) {
  return normalizeText(value).split(/\s+/).filter(Boolean).slice(0, limit).join(" ");
}

function compactInlineValue(value: string, fallback: string, maxWords: number) {
  const summarized = summarizeOptionText(value, fallback)
    .replace(/\s*\|\s*/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  const clipped = trimWords(summarized, maxWords);
  return clipped || fallback;
}

function joinNatural(items: string[]) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function summarizeOptionText(value: string, fallbackLabel: string) {
  const cleaned = normalizeText(value);
  if (!isSpecified(cleaned)) return "";

  const parts = cleaned.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 3) {
    return `multiple ${fallbackLabel}`;
  }

  return cleaned;
}

function buildNormalizedDescription(spec: ExtendedExtractedSpec) {
  const original = normalizeText(spec.productDescription);
  // Prefer the vendor's own extracted description whenever it exists (any length);
  // only synthesise one when the source truly has none.
  if (isSpecified(original)) {
    return trimWords(original, 95);
  }

  const productType = getCategoryLabel(spec) || "lighting fixture";
  const recommendedName = buildProductNameRecommendations(spec)[0] ?? deriveTypeCore(spec);
  const applications = spec.applicationAreas.map((area) => normalizeText(area)).filter(isSpecified);
  const wattage = summarizeOptionText(getSpecValueFromSpec(spec, ["Power", "Wattage"]), "power options");
  const lumens = summarizeOptionText(getSpecValueFromSpec(spec, ["Lumens", "Lumen Output"]), "lumen packages");
  const cct = summarizeOptionText(getSpecValueFromSpec(spec, ["Color Temperature (Selectable)", "CCT"]), "CCT options");
  const voltage = normalizeText(getSpecValueFromSpec(spec, ["Voltage", "Input Voltage"]));
  const efficacy = normalizeText(getSpecValueFromSpec(spec, ["Efficacy (lm/W)", "Efficacy"]));
  const driver = normalizeText(getSpecValueFromSpec(spec, ["Driver"]));
  const housing = normalizeText(getSpecValueFromSpec(spec, ["Housing Material", "Housing"]));
  const mounting = normalizeText(getSpecValueFromSpec(spec, ["Mounting Type", "Mounting"]));

  const performanceBits = [
    wattage ? (wattage.toLowerCase().includes("option") ? wattage : `${wattage} power options`) : "",
    lumens ? (lumens.toLowerCase().includes("lumen") || lumens.toLowerCase().includes("output") ? lumens : `${lumens} luminous output`) : "",
    cct ? (cct.toLowerCase().includes("option") ? cct : `${cct} CCT options`) : "",
  ].filter(Boolean);

  const electricalBits = [
    isSpecified(voltage) ? `${voltage} input` : "",
    isSpecified(efficacy) ? `${efficacy} efficacy` : "",
  ].filter(Boolean);

  const constructionBits = [
    isSpecified(driver) ? `${driver} driver support` : "",
    isSpecified(housing) ? `${housing} construction` : "",
    isSpecified(mounting) ? `${mounting} mounting flexibility` : "",
  ].filter(Boolean);

  let description = `${recommendedName} is a ${productType.toLowerCase()} developed for ${joinNatural(applications.slice(0, 3)) || "commercial and industrial lighting projects"}.`;
  if (performanceBits.length > 0) {
    description += ` It combines ${joinNatural(performanceBits)} to deliver balanced, specification-ready illumination across demanding projects.`;
  }
  if (electricalBits.length > 0) {
    description += ` The fixture operates with ${joinNatural(electricalBits)} for efficient, dependable day-to-day lighting performance.`;
  }
  if (constructionBits.length > 0) {
    description += ` Its design uses ${joinNatural(constructionBits)} to support clean installation, durable field use, and reliable project integration.`;
  }
  description += " It fits retrofit and new-construction applications that need dependable output, practical coverage, and straightforward specification selection.";

  while (countWords(description) < 70) {
    description += " It offers dependable long-term value for professional lighting upgrades and new builds.";
  }

  return trimWords(description, 80);
}

// Return the vendor's own extracted features (cleaned + de-duplicated). No fabricated fallback —
// if the source PDF lists no features, the section simply stays empty for the user to fill.
function buildNormalizedFeatures(spec: ExtendedExtractedSpec) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of spec.productFeatures) {
    const feature = normalizeText(raw).replace(/^[-*•]\s*/, "").replace(/\.$/, "");
    if (!isSpecified(feature)) continue;
    const key = feature.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(feature);
  }
  return deduped;
}

function buildCompactFeatures(spec: ExtendedExtractedSpec) {
  const applicationLabel =
    spec.applicationAreas
      .map((area) => trimWords(normalizeText(area).toLowerCase(), 1))
      .filter(Boolean)
      .slice(0, 2)
      .join("/") || "commercial spaces";

  const wattage = compactInlineValue(getSpecValueFromSpec(spec, ["Power", "Wattage"]), "flexible wattages", 2);
  const lumens = compactInlineValue(getSpecValueFromSpec(spec, ["Lumens", "Lumen Output"]), "steady lumen packages", 2);
  const cct = compactInlineValue(getSpecValueFromSpec(spec, ["Color Temperature (Selectable)", "CCT"]), "multiple CCT options", 3);
  const voltage = compactInlineValue(getSpecValueFromSpec(spec, ["Voltage", "Input Voltage"]), "standard voltage", 2);
  const warranty = normalizeWarrantyLabel(getSpecValueFromSpec(spec, ["Warranty (Years)", "Warranty"]));

  return [
    `Support ${wattage} configurations for flexible project lighting selection`,
    `Deliver ${lumens} performance with efficient, even light output`,
    `Offer ${cct} settings for adaptable visual comfort and control`,
    `Operate on ${voltage} input with reliable driver control`,
    !isSpecified(warranty)
      ? `Cover ${applicationLabel} applications with reliable project support`
      : `Cover ${applicationLabel} applications with ${warranty.toLowerCase()} limited warranty`,
  ].map((feature) => trimWords(feature.replace(/\s+/g, " ").trim(), 10));
}

// Build the page-2 "Product Specifications" table straight from the extracted variant matrix
// (fixture types + selectable power/lumen packages) and the shared technical specs.
/** Remove a leaked vendor part-number / model-code prefix per line, so an electrical value never
 *  shows a SKU fragment. "PT02-60W" -> "60W", "02-120W" -> "120W"; "20-60W" (a real range) is kept. */
function stripCatalogCode(value: string): string {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[A-Za-z][A-Za-z0-9]*|0\d+)\s*[-–]\s*/, "").trim())
    .join("\n");
}

function buildSpecGroups(spec: ExtendedExtractedSpec): SpecGroup[] {
  const variants = buildPreviewVariantRows(spec);
  if (variants.length === 0) return [];

  const shared = (keys: string[]) => {
    const value = getSpecValueFromSpec(spec, keys);
    return isSpecified(value) ? normalizeText(value) : "";
  };
  const voltage = shared(["Voltage", "Input Voltage"]);
  const cri = shared(["Color Rendering (CRI)", "CRI"]);
  const current = shared(["Current"]);
  const thd = shared(["THD"]);
  const lightDistribution = shared(["Light Distribution"]);

  // Split selectable power/lumen packages on "/", "|", dashes or newlines — but NOT commas
  // (commas are thousands separators, e.g. "13,000lm" must stay intact). A hyphen only splits
  // when it sits between a unit letter and the next number, e.g. "70W-100W" or "13000lm-16000lm".
  const splitOptions = (value: string) =>
    value
      .replace(/([A-Za-z])\s*-\s*(?=\d)/g, "$1|")
      .split(/\s*[/|–—]\s*|\n/)
      .map((item) => normalizeText(item))
      .filter(Boolean);

  return variants
    .map((variant, index) => {
      // Strip any leaked part-number code (e.g. "PT02-60W" -> "60W") before splitting power.
      const powers = splitOptions(stripCatalogCode(variant.power));
      const lumens = splitOptions(variant.lumens);
      const count = Math.max(powers.length, lumens.length, 1);
      const options: SpecOption[] = Array.from({ length: count }, (_, k) => ({
        power: powers[k] ?? (powers.length === 1 ? powers[0] : ""),
        lumen: lumens[k] ?? (lumens.length === 1 ? lumens[0] : ""),
      }));
      return {
        id: `spec-extracted-${index}`,
        partNumber: variant.fixtureDetail || variant.fixture || `Variant ${index + 1}`,
        sku: "",
        options,
        voltage,
        efficacy: variant.efficacy,
        cri,
        current,
        cct: variant.cct,
        thd,
        lightDistribution,
      } satisfies SpecGroup;
    })
    .filter(specGroupHasContent);
}

// Sample accessory rows used to demo the Accessories Ordering table layout.
function buildSampleAccessoryRows(): AccessoryRow[] {
  return [
    { id: "acc-sample-1", code: "IK-ACC-ARC", description: "Suspension Cable Kit", imageId: null, downloadUrl: "" },
    { id: "acc-sample-2", code: "IK-OCCS", description: "Microwave Smart Controller (Black Sensor)", imageId: null, downloadUrl: "" },
    { id: "acc-sample-3", code: "IK-HD05R-Digital", description: "Microwave Motion Sensor Remote", imageId: null, downloadUrl: "" },
    { id: "acc-sample-4", code: "IK-EMH-18170-HY", description: "Emergency Pack for LED Fixture 18W / 90 Min / Split Type / L (On Field)", imageId: null, downloadUrl: "" },
    { id: "acc-sample-5", code: "IK-10W-ED", description: "Emergency Pack for LED Fixture 10W / 90 Min / Split Type / L (Factory Installed)", imageId: null, downloadUrl: "" },
    { id: "acc-sample-6", code: "IK-ACC-HD07VR", description: "3-Pin Microwave Motion Sensor", imageId: null, downloadUrl: "" },
  ];
}

// Map the extracted decoder (keyed by column header) onto the fixed ordering columns.
function buildOrderingColumns(spec: ExtendedExtractedSpec): OrderingColumn[] {
  const info = spec.orderingInfo ?? {};
  return createDefaultOrderingColumns().map((column) => {
    // Accept a vendor "Wattage" decoder for the US-standard "Power" column.
    const entries = info[column.header] ?? (column.header === "Power" ? info["Wattage"] ?? info["Watts"] : undefined);
    if (!Array.isArray(entries)) return column;
    const mapped = entries
      .map((entry) => ({
        code: (entry?.code ?? "").trim(),
        description: (entry?.description ?? "").trim(),
      }))
      .filter((entry) => entry.code || entry.description);
    return mapped.length > 0 ? { ...column, entries: mapped } : column;
  });
}

function buildAccessoryRowsFromSpec(spec: ExtendedExtractedSpec): AccessoryRow[] {
  const list = Array.isArray(spec.accessories) ? spec.accessories : [];
  return list
    .map((entry) => ({
      code: (entry?.code ?? "").trim(),
      description: (entry?.description ?? "").trim(),
    }))
    .filter((entry) => entry.code || entry.description)
    .map((entry, index) => ({
      id: `acc-init-${index}`,
      code: entry.code,
      description: entry.description,
      imageId: null,
      downloadUrl: "",
    }));
}

/** US convention: the electrical column is "Power" (in W), never "Wattage". Rename a header that is
 *  essentially "Wattage"/"Watts" (optionally with a unit in parentheses) to "Power". Compound headers
 *  (e.g. "Wattage Package") are left alone. */
function normalizeUsColumnHeader(header: string) {
  const h = String(header ?? "").trim();
  if (/^watt(age|s|)\s*(\([^)]*\))?$/i.test(h)) return "Power";
  return h;
}

function buildExtraTablesFromSpec(spec: ExtendedExtractedSpec): ExtraTable[] {
  const list = Array.isArray(spec.extraTables) ? spec.extraTables : [];
  return list
    .map((table, index) => {
      const headers = (Array.isArray(table?.headers) ? table.headers : []).map((h) => normalizeUsColumnHeader(String(h ?? "").trim()));
      const rows = (Array.isArray(table?.rows) ? table.rows : [])
        .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : []))
        .filter((row) => row.some((cell) => cell));
      return {
        id: `extratable-${index}`,
        title: String(table?.title ?? "").trim() || "Additional Data",
        headers,
        rows,
      };
    })
    .filter((table) => table.headers.length > 0 && table.rows.length > 0);
}

function buildDimensionItemsFromSpec(spec: ExtendedExtractedSpec): DimensionItem[] {
  const list = Array.isArray(spec.dimensions) ? spec.dimensions : [];
  const clean = (value: string) => (isSpecified(value) ? value.trim() : "");
  return list
    .map((entry) => ({
      label: clean(entry?.label ?? ""),
      width: clean(entry?.width ?? ""),
      height: clean(entry?.height ?? ""),
      depth: clean(entry?.depth ?? ""),
    }))
    .filter((entry) => entry.label || entry.width || entry.height || entry.depth)
    .map((entry, index) => ({
      id: `dim-init-${index}`,
      label: entry.label,
      imageId: null,
      width: entry.width,
      height: entry.height,
      depth: entry.depth,
    }));
}

// Raw backend category-enum values (lowercase) that should be replaced with the canonical fixture
// category ("Indoor Lighting", …) — used to auto-clean older saved drafts that stored the enum.
const RAW_CATEGORY_ENUMS = new Set([
  "panel", "downlight", "track", "flood", "area", "high_mast", "high mast", "street",
  "high_bay", "high bay", "low_bay", "low bay", "linear", "wall_pack", "wall pack",
  "canopy", "post_top", "post top", "stadium", "bollard", "unknown", "tube", "troffer",
  "strip", "wrap", "corn", "grow", "exit", "vapor_tight", "vapor tight", "yard",
]);

function isRawCategoryEnum(value: string) {
  const normalized = normalizeText(value).toLowerCase();
  // Raw enum, or any short value that isn't a proper "… Lighting" category.
  return RAW_CATEGORY_ENUMS.has(normalized) || (!!normalized && !/lighting/i.test(normalized) && !normalized.includes(" "));
}

function buildEditorDraft(spec: ExtendedExtractedSpec, productNameRecommendations = buildProductNameRecommendations(spec)): EditorDraft {
  const productType = getCategoryLabel(spec);
  const warrantyLabel = normalizeWarrantyLabel(getSpecValueFromSpec(spec, ["Warranty (Years)", "Warranty"]));
  const recommendedNames = productNameRecommendations;
  // Canonical fixture profile from the product name — gives a clean "Indoor Lighting" /
  // "Recessed Downlight" from the start instead of the raw backend enum (e.g. lowercase "downlight"),
  // which the user otherwise had to clear before the auto-predict would correct it.
  const fixtureProfile = predictFixtureProfile(spec.productName, String(spec.subCategory ?? ""), productType);

  return {
    headerProjectName: "",
    headerCatNumber: "",
    headerFixtureSchedule: "",
    headerNote: "",
    footerNote: "",
    title: recommendedNames[0] ?? deriveTypeCore(spec),
    subtitle: spec.alternateName || productType || "Technical Data Sheet",
    categoryLabel: fixtureProfile?.category ?? (isSpecified(productType) ? productType : ""),
    subCategory: fixtureProfile?.subCategory ?? (isSpecified(spec.subCategory) ? String(spec.subCategory).trim() : ""),
    skuNumber: getSpecValueFromSpec(spec, ["Part Number", "SKU", "Catalog Number", "Cat Number", "Model"]) || "",
    overviewRows: buildOverviewRows(spec),
    overviewFontPx: null,
    description: buildNormalizedDescription(spec),
    featuresText: buildNormalizedFeatures(spec).join("\n"),
    applicationAreasText: spec.applicationAreas.join(", "),
    certificationsText: buildCertifications(spec),
    warrantyLabel,
    warrantyCopy: buildWarrantyCopy(spec),
    manualSourceImages: [],
    selectedImageId: null,
    editedImageDataUrls: {},
    imageOwners: {},
    selectedQualificationIds: inferQualificationBadgeIds(spec as ExtendedExtractedSpec),
    specGroups: buildSpecGroups(spec),
    specColumns: DEFAULT_SPEC_COLUMNS,
    specsNote:
      "Custom manufacturing options in CCT, wattage, voltage, light distribution, finish, and more are available upon request, subject to MOQ and lead time considerations.",
    orderingExample: isSpecified(spec.orderingExample) ? String(spec.orderingExample).trim() : "",
    orderingColumns: buildOrderingColumns(spec),
    orderingSelection: {},
    orderingNote: "Please ensure power compatibility with this specific fixture size when selecting this option.",
    accessoryRows: buildAccessoryRowsFromSpec(spec),
    dimensionItems: buildDimensionItemsFromSpec(spec),
    // Custom sections start empty — the sheet is NOT auto-populated with vendor "Photometric Diagram"
    // sections (they cluttered the sheet and auto-picked wrong images). Add one manually if needed.
    customSections: [],
    extraTables: buildExtraTablesFromSpec(spec),
    imagePlacements: {},
  };
}

function ImageEditorDialog({
  image,
  open,
  onOpenChange,
  onSave,
  onReset,
}: {
  image: SourceImage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (dataUrl: string) => void;
  onReset: () => void;
}) {
  // State-based ref so the draw effect re-runs as soon as the canvas mounts (Dialog portal timing).
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [editor, setEditor] = useState<ImageEditorState>(createImageEditorState);
  const [mode, setMode] = useState<ImageEditorMode>("text");
  const [textValue, setTextValue] = useState("");
  const [textColor, setTextColor] = useState("#111827");
  const [textSize, setTextSize] = useState(30);
  const [eraseColor, setEraseColor] = useState("#ffffff");
  const [eraseWidth, setEraseWidth] = useState(180);
  const [eraseHeight, setEraseHeight] = useState(56);
  const [penSize, setPenSize] = useState(16);
  // The current base image drawn on the canvas. Starts as the source image and is replaced by the
  // result of an "AI Edit" so further manual tools apply on top of the AI-edited image.
  const [baseDataUrl, setBaseDataUrl] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const isPaintingRef = useRef(false);
  const lastPaintRef = useRef<{ x: number; y: number } | null>(null);
  // Accurate crop: a separate overlay canvas draws the guides so they never bake into the result.
  const [overlayEl, setOverlayEl] = useState<HTMLCanvasElement | null>(null);
  const [crop, setCrop] = useState<CropSelection | null>(null);
  const [cropAspect, setCropAspect] = useState<number | null>(null); // null = free
  const cropDragRef = useRef<{ handle: CropHandle; startX: number; startY: number; orig: CropSelection } | null>(null);
  // Move/edit placed text (Illustrator-style): the selected layer + the active drag offset.
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const textDragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  // Draw lines / arrows (to redraw dimension leaders erased while editing units).
  const [shapeColor, setShapeColor] = useState("#111827");
  const [shapeWidth, setShapeWidth] = useState(3);
  const shapeDragRef = useRef<{ x1: number; y1: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<ImageShapeLayer | null>(null);

  useEffect(() => {
    if (!open) return;

    setEditor(createImageEditorState());
    setMode("text");
    setCrop(null);
    setCropAspect(null);
    cropDragRef.current = null;
    setSelectedTextId(null);
    textDragRef.current = null;
    setTextValue("");
    setTextColor("#111827");
    setTextSize(30);
    setEraseColor("#ffffff");
    setEraseWidth(180);
    setEraseHeight(56);
    setPenSize(16);
    setBaseDataUrl(image?.dataUrl ?? null);
    setAiPrompt("");
    setAiBusy(false);
    setAiError(null);
    isPaintingRef.current = false;
    lastPaintRef.current = null;
  }, [image?.id, open]);

  useEffect(() => {
    if (!open || !image || !canvasEl) return undefined;

    const canvas = canvasEl;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    let cancelled = false;
    const source = new window.Image();
    source.crossOrigin = "anonymous";

    const draw = () => {
      if (cancelled) return;

      // Rotation swaps the canvas dimensions for 90°/270° so the rotated image isn't cropped.
      const rotation = (((editor.rotation ?? 0) % 360) + 360) % 360;
      const swap = rotation === 90 || rotation === 270;
      const imageWidth = source.naturalWidth || source.width || 600;
      const imageHeight = source.naturalHeight || source.height || 400;
      canvas.width = swap ? imageHeight : imageWidth;
      canvas.height = swap ? imageWidth : imageHeight;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = editor.backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);

      // Scale the product up/down inside the frame (centered): <100% pads with background,
      // >100% zooms in. Rotation + flip are applied around the canvas centre; grayscale via filter.
      const imageScale = (editor.imageScale ?? 100) / 100;
      const drawWidth = imageWidth * imageScale;
      const drawHeight = imageHeight * imageScale;
      context.save();
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((rotation * Math.PI) / 180);
      context.scale(editor.flipH ? -1 : 1, editor.flipV ? -1 : 1);
      context.filter = `brightness(${editor.brightness}%) contrast(${editor.contrast}%) saturate(${editor.saturation}%)${editor.grayscale ? " grayscale(1)" : ""}`;
      context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      context.filter = "none";
      context.restore();

      if (editor.removeBackground) {
        whitenConnectedBackground(canvas, context);
      }

      editor.eraseLayers.forEach((layer) => {
        context.save();
        context.fillStyle = layer.color;
        if (layer.rotation) {
          // Rotate a tight cover around the label's centre so it hugs vertical text, not the lines.
          const cx = layer.x + layer.width / 2;
          const cy = layer.y + layer.height / 2;
          context.translate(cx, cy);
          context.rotate((layer.rotation * Math.PI) / 180);
          context.translate(-cx, -cy);
        }
        if (layer.shape === "circle") {
          context.beginPath();
          context.arc(layer.x + layer.width / 2, layer.y + layer.height / 2, layer.width / 2, 0, Math.PI * 2);
          context.fill();
        } else {
          context.fillRect(layer.x, layer.y, layer.width, layer.height);
        }
        context.restore();
      });

      editor.shapeLayers.forEach((layer) => {
        drawShapeOnContext(context, layer);
      });

      editor.textLayers.forEach((layer) => {
        context.save();
        context.fillStyle = layer.color;
        context.font = `700 ${layer.size}px Arial`;
        context.textBaseline = "top";
        if (layer.rotation) {
          context.translate(layer.x, layer.y);
          context.rotate((layer.rotation * Math.PI) / 180);
          context.fillText(layer.text, 0, 0);
        } else {
          context.fillText(layer.text, layer.x, layer.y);
        }
        context.restore();
      });
    };

    source.onload = draw;
    source.onerror = () => {
      if (cancelled) return;
      // Still show a usable (blank, editor-background) canvas if the image fails to load.
      canvas.width = 600;
      canvas.height = 400;
      context.fillStyle = editor.backgroundColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    source.src = baseDataUrl ?? image.dataUrl;
    // If the image is already cached/decoded, onload may not fire — draw immediately.
    if (source.complete && source.naturalWidth > 0) {
      draw();
    }

    return () => {
      cancelled = true;
    };
  }, [editor, image, open, canvasEl, baseDataUrl]);

  const updateEditor = <K extends keyof ImageEditorState>(key: K, value: ImageEditorState[K]) => {
    setEditor((current) => ({ ...current, [key]: value }));
  };

  const getCanvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasEl;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;
    return {
      canvas,
      x: (event.clientX - bounds.left) * scaleX,
      y: (event.clientY - bounds.top) * scaleY,
    };
  };

  const paintPenDot = (x: number, y: number, canvas: HTMLCanvasElement) => {
    setEditor((current) => ({
      ...current,
      eraseLayers: [
        ...current.eraseLayers,
        {
          id: `pen-${Date.now()}-${current.eraseLayers.length}-${Math.round(x)}-${Math.round(y)}`,
          x: clamp(x - penSize / 2, 0, Math.max(0, canvas.width - penSize)),
          y: clamp(y - penSize / 2, 0, Math.max(0, canvas.height - penSize)),
          width: penSize,
          height: penSize,
          color: eraseColor,
          shape: "circle",
        },
      ],
    }));
  };

  const handlePenDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "pen") return;
    const point = getCanvasPoint(event);
    if (!point) return;
    isPaintingRef.current = true;
    lastPaintRef.current = { x: point.x, y: point.y };
    paintPenDot(point.x, point.y, point.canvas);
  };

  const handlePenMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "pen" || !isPaintingRef.current) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    const last = lastPaintRef.current;
    const step = Math.max(4, penSize * 0.45);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < step) return;
    lastPaintRef.current = { x: point.x, y: point.y };
    paintPenDot(point.x, point.y, point.canvas);
  };

  const handlePenUp = () => {
    isPaintingRef.current = false;
    lastPaintRef.current = null;
  };

  // ---- Accurate crop ------------------------------------------------------
  const clampCrop = (c: CropSelection, cw: number, ch: number): CropSelection => {
    let { x, y, width: w, height: h } = c;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    w = Math.max(8, w); h = Math.max(8, h);
    x = clamp(x, 0, Math.max(0, cw - 8));
    y = clamp(y, 0, Math.max(0, ch - 8));
    w = Math.min(w, cw - x); h = Math.min(h, ch - y);
    return { x, y, width: w, height: h };
  };
  const cropHandlePositions = (c: CropSelection): Array<[CropHandle, number, number]> => {
    const { x, y, width: w, height: h } = c;
    return [
      ["nw", x, y], ["n", x + w / 2, y], ["ne", x + w, y],
      ["e", x + w, y + h / 2], ["se", x + w, y + h], ["s", x + w / 2, y + h],
      ["sw", x, y + h], ["w", x, y + h / 2],
    ];
  };
  const handleCropDown = (point: { canvas: HTMLCanvasElement; x: number; y: number }) => {
    const cw = point.canvas.width;
    const thr = Math.max(12, cw * 0.02);
    let handle: CropHandle = "new";
    if (crop) {
      for (const [name, hx, hy] of cropHandlePositions(crop)) {
        if (Math.abs(point.x - hx) <= thr && Math.abs(point.y - hy) <= thr) { handle = name; break; }
      }
      if (handle === "new"
        && point.x >= crop.x && point.x <= crop.x + crop.width
        && point.y >= crop.y && point.y <= crop.y + crop.height) {
        handle = "move";
      }
    }
    cropDragRef.current = { handle, startX: point.x, startY: point.y, orig: crop ?? { x: point.x, y: point.y, width: 0, height: 0 } };
    if (handle === "new") setCrop({ x: point.x, y: point.y, width: 0, height: 0 });
  };
  const handleCropMove = (point: { canvas: HTMLCanvasElement; x: number; y: number }) => {
    const drag = cropDragRef.current;
    if (!drag) return;
    const cw = point.canvas.width, ch = point.canvas.height;
    const o = drag.orig;
    const anchors: Partial<Record<CropHandle, { x: number; y: number }>> = {
      new: { x: drag.startX, y: drag.startY },
      se: { x: o.x, y: o.y },
      ne: { x: o.x, y: o.y + o.height },
      sw: { x: o.x + o.width, y: o.y },
      nw: { x: o.x + o.width, y: o.y + o.height },
    };
    const anchor = anchors[drag.handle];
    let next: CropSelection;
    if (anchor) {
      let w = point.x - anchor.x;
      let h = point.y - anchor.y;
      if (cropAspect) h = (h < 0 ? -1 : 1) * (Math.abs(w) / cropAspect);
      next = { x: anchor.x, y: anchor.y, width: w, height: h };
    } else if (drag.handle === "move") {
      next = {
        x: clamp(o.x + (point.x - drag.startX), 0, cw - o.width),
        y: clamp(o.y + (point.y - drag.startY), 0, ch - o.height),
        width: o.width, height: o.height,
      };
    } else {
      next = { ...o };
      const dx = point.x - drag.startX, dy = point.y - drag.startY;
      if (drag.handle === "e") next.width = o.width + dx;
      else if (drag.handle === "w") { next.x = o.x + dx; next.width = o.width - dx; }
      else if (drag.handle === "s") next.height = o.height + dy;
      else if (drag.handle === "n") { next.y = o.y + dy; next.height = o.height - dy; }
    }
    setCrop(clampCrop(next, cw, ch));
  };
  const setCropField = (key: keyof CropSelection, value: number) => {
    const canvas = canvasEl;
    if (!canvas || !crop || Number.isNaN(value)) return;
    setCrop(clampCrop({ ...crop, [key]: value }, canvas.width, canvas.height));
  };
  const applyCrop = () => {
    const canvas = canvasEl;
    if (!canvas || !crop) return;
    const c = clampCrop(crop, canvas.width, canvas.height);
    const sx = Math.round(c.x), sy = Math.round(c.y);
    const sw = Math.max(1, Math.round(c.width)), sh = Math.max(1, Math.round(c.height));
    const out = document.createElement("canvas");
    out.width = sw; out.height = sh;
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    setBaseDataUrl(out.toDataURL("image/png")); // cropped image becomes the new base for further edits
    setEditor(createImageEditorState());
    setCrop(null);
    setMode("crop"); // stay in crop so a re-crop initialises on the smaller image
  };

  // ---- Move / edit placed text -------------------------------------------
  const textLayerBounds = (layer: ImageTextLayer) => {
    const ctx = canvasEl?.getContext("2d");
    let textW = layer.size * Math.max(1, layer.text.length) * 0.5;
    if (ctx) {
      ctx.save();
      ctx.font = `700 ${layer.size}px Arial`;
      textW = ctx.measureText(layer.text).width;
      ctx.restore();
    }
    // For a -90° (vertical) label anchored at (x, y), the visible box is `size` wide and `textW`
    // tall, extending UPWARD from the anchor. Horizontal text keeps the simple top-left box.
    if (layer.rotation === -90) {
      return { x: layer.x, y: layer.y - textW, width: layer.size, height: textW };
    }
    if (layer.rotation === 90) {
      return { x: layer.x - layer.size, y: layer.y, width: layer.size, height: textW };
    }
    return { x: layer.x, y: layer.y, width: textW, height: layer.size };
  };
  const selectedTextLayer = editor.textLayers.find((layer) => layer.id === selectedTextId) ?? null;
  const handleTextDown = (point: { x: number; y: number }) => {
    // Topmost text under the pointer (last drawn = on top).
    for (let i = editor.textLayers.length - 1; i >= 0; i -= 1) {
      const layer = editor.textLayers[i];
      const b = textLayerBounds(layer);
      if (
        point.x >= b.x - b.height * 0.15 && point.x <= b.x + b.width + b.height * 0.15 &&
        point.y >= b.y - b.height * 0.25 && point.y <= b.y + b.height * 1.25
      ) {
        setSelectedTextId(layer.id);
        textDragRef.current = { id: layer.id, dx: point.x - layer.x, dy: point.y - layer.y };
        return;
      }
    }
    setSelectedTextId(null);
  };
  const handleTextMove = (point: { x: number; y: number }) => {
    const drag = textDragRef.current;
    if (!drag) return;
    setEditor((current) => ({
      ...current,
      textLayers: current.textLayers.map((layer) =>
        layer.id === drag.id ? { ...layer, x: point.x - drag.dx, y: point.y - drag.dy } : layer,
      ),
    }));
  };
  const updateSelectedText = (patch: Partial<ImageTextLayer>) => {
    if (!selectedTextId) return;
    setEditor((current) => ({
      ...current,
      textLayers: current.textLayers.map((layer) =>
        layer.id === selectedTextId ? { ...layer, ...patch } : layer,
      ),
    }));
  };
  const deleteSelectedText = () => {
    if (!selectedTextId) return;
    setEditor((current) => ({
      ...current,
      textLayers: current.textLayers.filter((layer) => layer.id !== selectedTextId),
    }));
    setSelectedTextId(null);
  };

  // ---- Draw line / arrow (redraw erased dimension leaders) ----
  const handleShapeDown = (point: { x: number; y: number }) => {
    shapeDragRef.current = { x1: point.x, y1: point.y };
    setShapePreview({
      id: "preview", type: mode === "arrow" ? "arrow" : "line",
      x1: point.x, y1: point.y, x2: point.x, y2: point.y, color: shapeColor, width: shapeWidth,
    });
  };
  const handleShapeMove = (point: { x: number; y: number }) => {
    const start = shapeDragRef.current;
    if (!start) return;
    setShapePreview({
      id: "preview", type: mode === "arrow" ? "arrow" : "line",
      x1: start.x1, y1: start.y1, x2: point.x, y2: point.y, color: shapeColor, width: shapeWidth,
    });
  };
  const handleShapeUp = () => {
    const start = shapeDragRef.current;
    const preview = shapePreview;
    shapeDragRef.current = null;
    setShapePreview(null);
    if (start && preview && (Math.abs(preview.x2 - preview.x1) > 2 || Math.abs(preview.y2 - preview.y1) > 2)) {
      setEditor((current) => ({
        ...current,
        shapeLayers: [...current.shapeLayers, { ...preview, id: `shape-${Date.now()}-${current.shapeLayers.length}` }],
      }));
    }
  };

  // Initialise a centred crop box when entering crop mode with none set.
  useEffect(() => {
    if (mode === "crop" && !crop && canvasEl && canvasEl.width > 0) {
      const w = canvasEl.width, h = canvasEl.height;
      setCrop({ x: w * 0.12, y: h * 0.12, width: w * 0.76, height: h * 0.76 });
    }
  }, [mode, crop, canvasEl]);

  // Draw the crop guides on the SEPARATE overlay canvas so they never bake into the saved image.
  useEffect(() => {
    const main = canvasEl, ov = overlayEl;
    if (!ov || !main) return;
    ov.width = main.width; ov.height = main.height;
    const ctx = ov.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (mode === "movetext") {
      // Dashed outline around the selected text so the user can see what they're moving/resizing.
      if (selectedTextLayer) {
        const b = textLayerBounds(selectedTextLayer);
        const m = Math.max(3, b.height * 0.2);
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = Math.max(1.5, ov.width * 0.0025);
        ctx.setLineDash([Math.max(4, ov.width * 0.01), Math.max(3, ov.width * 0.007)]);
        ctx.strokeRect(b.x - m, b.y - m, b.width + m * 2, b.height + m * 2);
        ctx.setLineDash([]);
      }
      return;
    }
    if (mode === "line" || mode === "arrow") {
      // Live preview of the line/arrow being dragged (committed shapes are on the main canvas).
      if (shapePreview) drawShapeOnContext(ctx, shapePreview);
      return;
    }
    if (mode !== "crop" || !crop) return;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, ov.width, ov.height);
    ctx.clearRect(crop.x, crop.y, crop.width, crop.height);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = Math.max(2, ov.width * 0.003);
    ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, ov.width * 0.0015);
    for (let i = 1; i < 3; i++) {
      const gx = crop.x + (crop.width * i) / 3;
      ctx.beginPath(); ctx.moveTo(gx, crop.y); ctx.lineTo(gx, crop.y + crop.height); ctx.stroke();
      const gy = crop.y + (crop.height * i) / 3;
      ctx.beginPath(); ctx.moveTo(crop.x, gy); ctx.lineTo(crop.x + crop.width, gy); ctx.stroke();
    }
    const r = Math.max(5, ov.width * 0.008);
    ctx.fillStyle = "#3b82f6";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, ov.width * 0.002);
    for (const [, hx, hy] of cropHandlePositions(crop)) {
      ctx.beginPath(); ctx.rect(hx - r, hy - r, r * 2, r * 2); ctx.fill(); ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, crop, canvasEl, overlayEl, editor, baseDataUrl, selectedTextId, shapePreview]);

  const handleCanvasPointerDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === "crop") {
      const point = getCanvasPoint(event);
      if (point) handleCropDown(point);
      return;
    }
    if (mode === "movetext") {
      const point = getCanvasPoint(event);
      if (point) handleTextDown(point);
      return;
    }
    if (mode === "line" || mode === "arrow") {
      const point = getCanvasPoint(event);
      if (point) handleShapeDown(point);
      return;
    }
    handlePenDown(event);
  };
  const handleCanvasPointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === "crop") {
      if (!cropDragRef.current) return;
      const point = getCanvasPoint(event);
      if (point) handleCropMove(point);
      return;
    }
    if (mode === "movetext") {
      if (!textDragRef.current) return;
      const point = getCanvasPoint(event);
      if (point) handleTextMove(point);
      return;
    }
    if (mode === "line" || mode === "arrow") {
      if (!shapeDragRef.current) return;
      const point = getCanvasPoint(event);
      if (point) handleShapeMove(point);
      return;
    }
    handlePenMove(event);
  };
  const handleCanvasPointerUp = () => {
    if (mode === "crop") {
      cropDragRef.current = null;
      return;
    }
    if (mode === "movetext") {
      textDragRef.current = null;
      return;
    }
    if (mode === "line" || mode === "arrow") {
      handleShapeUp();
      return;
    }
    handlePenUp();
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!image) return;
    if (mode === "pen" || mode === "crop" || mode === "movetext" || mode === "line" || mode === "arrow") return; // handled by drag (down/move)

    const canvas = canvasEl;
    if (!canvas) return;

    const bounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;
    const clickX = (event.clientX - bounds.left) * scaleX;
    const clickY = (event.clientY - bounds.top) * scaleY;

    if (mode === "text") {
      const trimmed = normalizeText(textValue);
      if (!trimmed) return;

      setEditor((current) => ({
        ...current,
        textLayers: [
          ...current.textLayers,
          {
            id: `text-${Date.now()}-${current.textLayers.length}`,
            x: clickX,
            y: clickY,
            text: trimmed,
            color: textColor,
            size: textSize,
          },
        ],
      }));
      return;
    }

    setEditor((current) => ({
      ...current,
      eraseLayers: [
        ...current.eraseLayers,
        {
          id: `erase-${Date.now()}-${current.eraseLayers.length}`,
          x: clamp(clickX - eraseWidth / 2, 0, Math.max(0, canvas.width - eraseWidth)),
          y: clamp(clickY - eraseHeight / 2, 0, Math.max(0, canvas.height - eraseHeight)),
          width: eraseWidth,
          height: eraseHeight,
          color: eraseColor,
        },
      ],
    }));
  };

  const handleSave = () => {
    const canvas = canvasEl;
    if (!canvas) return;
    onSave(canvas.toDataURL("image/png"));
  };

  const runAiImageEdit = async (promptOverride?: string) => {
    const canvas = canvasEl;
    const prompt = normalizeText(promptOverride ?? aiPrompt);
    if (!canvas || !image || !prompt || aiBusy) return;
    if (promptOverride) setAiPrompt(promptOverride);
    setAiBusy(true);
    setAiError(null);
    const toastId = toast.loading("AI reading the image…");
    try {
      // Uses the vision TEXT model (no image-generation quota): it returns the labels to change,
      // their replacement text, and bounding boxes. We overlay each change as an erase box + text
      // layer on the canvas, so it's applied locally and stays fully editable.
      const input = canvas.toDataURL("image/png");
      const response = await fetch(apiUrl("/api/ai-image-annotate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageDataUrl: input, prompt }),
      });
      const data = (await response.json().catch(() => null)) as
        | { edits?: Array<{ original?: string; replacement?: string; box?: number[] }>; error?: string; detail?: string }
        | null;
      if (!response.ok) {
        throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
      }
      const edits = Array.isArray(data?.edits) ? data!.edits! : [];
      const usable = edits.filter(
        (e) => e && Array.isArray(e.box) && e.box.length === 4 && isSpecified(String(e.replacement ?? "")),
      );
      if (usable.length === 0) {
        toast.error("The AI found nothing matching that instruction in this image.", { id: toastId });
        return;
      }
      const W = canvas.width;
      const H = canvas.height;
      const stamp = Date.now();
      setEditor((current) => {
        const eraseLayers = [...current.eraseLayers];
        const textLayers = [...current.textLayers];
        usable.forEach((edit, i) => {
          const [ymin, xmin, ymax, xmax] = edit.box as number[];
          const x = (Math.min(xmin, xmax) / 1000) * W;
          const y = (Math.min(ymin, ymax) / 1000) * H;
          const w = Math.max(10, (Math.abs(xmax - xmin) / 1000) * W);
          const h = Math.max(10, (Math.abs(ymax - ymin) / 1000) * H);
          const text = String(edit.replacement);
          const approx = (s: number) => text.length * s * 0.55; // Arial mean glyph width
          // A tall, narrow label is VERTICAL text (e.g. a mm dimension on a side). Convert it to a
          // VERTICAL inch label in the same orientation, and keep the cover box tight so it hugs the
          // text column instead of painting over the dimension lines beside it.
          const vertical = h > w * 1.3;
          // Tight cover: hug the detected text box, not the surrounding leader lines.
          const pad = Math.max(1.5, Math.min(w, h) * 0.12);
          eraseLayers.push({ id: `ai-erase-${stamp}-${i}`, x: x - pad, y: y - pad, width: w + pad * 2, height: h + pad * 2, color: "#ffffff" });
          if (vertical) {
            // Size to the box read sideways: font height fits the WIDTH, text length fits the HEIGHT.
            const size = Math.max(9, Math.round(Math.min(w * 0.82, (h * 0.94) / Math.max(1, text.length * 0.55))));
            // Rotate -90° (reads bottom-to-top). Anchor so the rotated text stays centred in the box.
            const tx = x + (w - size) / 2;
            const ty = y + h / 2 + approx(size) / 2;
            textLayers.push({ id: `ai-text-${stamp}-${i}`, x: tx, y: ty, text, color: "#111827", size, rotation: -90 });
          } else {
            const size = Math.max(9, Math.round(Math.min(h * 0.82, (w * 0.94) / Math.max(1, text.length * 0.55))));
            textLayers.push({ id: `ai-text-${stamp}-${i}`, x, y: y + Math.max(0, (h - size) / 2), text, color: "#111827", size });
          }
        });
        return { ...current, eraseLayers, textLayers };
      });
      toast.success(`Applied ${usable.length} change(s). Review/adjust, then Use In TDS.`, { id: toastId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI image edit failed";
      setAiError(message);
      toast.error(`AI image edit failed: ${message}`, { id: toastId });
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1200px)] max-w-none overflow-hidden p-0">
        <div className="flex max-h-[92vh] min-h-0 flex-col overflow-y-auto lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden">
          <div className="shrink-0 border-b border-border/60 p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <DialogHeader>
              <DialogTitle>Vendor Image Editor</DialogTitle>
              <DialogDescription>
                Click the image to place text or cover old text before using it in the TDS preview.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-5 space-y-5">
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  AI Edit
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "mm → inches", prompt: "Convert every dimension shown in millimeters (mm) to inches (1 in = 25.4 mm), rounded to 2 decimals, and replace each mm label with the inch value followed by \"in\". Do not change any value already in inches. Keep the same position and format." },
                    { label: "cm → inches", prompt: "Convert every dimension shown in centimeters (cm) to inches (1 in = 2.54 cm), rounded to 2 decimals, and replace each cm label with the inch value followed by \"in\". Do not change any value already in inches. Keep the same position and format." },
                    { label: "mm & cm → inches", prompt: "Convert every dimension shown in millimeters (mm) or centimeters (cm) to inches (1 in = 25.4 mm, 1 in = 2.54 cm), rounded to 2 decimals, and replace each with the inch value followed by \"in\". Leave values already in inches unchanged. Keep the same position and format." },
                  ].map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      variant="outline"
                      onClick={() => runAiImageEdit(preset.prompt)}
                      disabled={!image || aiBusy}
                      className="h-8 rounded-lg border-primary/40 bg-primary/5 px-2.5 text-[12px] text-primary hover:border-primary hover:bg-primary/10"
                      title={preset.prompt}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  placeholder="Or type your own — e.g. “Convert every dimension shown in mm to inches (1 in = 25.4 mm), keep the same format and 2 decimals”."
                  className="min-h-[76px] text-[13px]"
                  disabled={aiBusy}
                />
                <Button
                  type="button"
                  onClick={runAiImageEdit}
                  disabled={!image || aiBusy || !normalizeText(aiPrompt)}
                  className="w-full"
                >
                  {aiBusy ? "Editing…" : "AI Edit Image"}
                </Button>
                {aiError ? (
                  <p className="text-[11px] leading-snug text-red-500">{aiError}</p>
                ) : (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Finds text/dimension labels (e.g. convert units, fix a value) and applies each as an
                    editable erase+text layer — no image-generation quota needed. Adjust or remove any via
                    Layers, then click <span className="font-semibold">Use In TDS</span>.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Adjustments
                </div>
                <label className="block space-y-1 text-sm">
                  <span>Background</span>
                  <input
                    type="color"
                    value={editor.backgroundColor}
                    onChange={(event) => updateEditor("backgroundColor", event.target.value)}
                    className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                  />
                </label>
                <Button
                  type="button"
                  variant={editor.removeBackground ? "default" : "outline"}
                  onClick={() => updateEditor("removeBackground", !editor.removeBackground)}
                  className="w-full"
                >
                  {editor.removeBackground ? "Background Removed ✓" : "Remove Background"}
                </Button>
                {editor.removeBackground && (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Whitens the background around the product. If it clips the product (light-on-light),
                    toggle it off.
                  </p>
                )}
                <label className="block space-y-1 text-sm">
                  <span>Brightness: {editor.brightness}%</span>
                  <input
                    type="range"
                    min="40"
                    max="180"
                    value={editor.brightness}
                    onChange={(event) => updateEditor("brightness", Number(event.target.value))}
                    className="w-full"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Contrast: {editor.contrast}%</span>
                  <input
                    type="range"
                    min="40"
                    max="180"
                    value={editor.contrast}
                    onChange={(event) => updateEditor("contrast", Number(event.target.value))}
                    className="w-full"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Saturation: {editor.saturation}%</span>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    value={editor.saturation}
                    onChange={(event) => updateEditor("saturation", Number(event.target.value))}
                    className="w-full"
                  />
                </label>
                <div className="block space-y-1 text-sm">
                  <span>Size: {editor.imageScale}%</span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 w-8 shrink-0 p-0 text-lg leading-none"
                      onClick={() => updateEditor("imageScale", Math.max(20, editor.imageScale - 10))}
                      aria-label="Make image smaller"
                      title="Make smaller"
                    >
                      −
                    </Button>
                    <input
                      type="range"
                      min="20"
                      max="300"
                      value={editor.imageScale}
                      onChange={(event) => updateEditor("imageScale", Number(event.target.value))}
                      className="w-full"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 w-8 shrink-0 p-0 text-lg leading-none"
                      onClick={() => updateEditor("imageScale", Math.min(300, editor.imageScale + 10))}
                      aria-label="Make image larger"
                      title="Make larger"
                    >
                      +
                    </Button>
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Resize the product inside the frame — smaller adds background padding, larger zooms in.
                    Reset to 100% for the original size.
                  </p>
                </div>
                <div className="space-y-1 text-sm">
                  <span>Rotate &amp; flip</span>
                  <div className="grid grid-cols-4 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 px-0 text-base leading-none"
                      onClick={() => updateEditor("rotation", ((((editor.rotation ?? 0) - 90) % 360) + 360) % 360)}
                      title="Rotate left 90°"
                      aria-label="Rotate left"
                    >
                      ⟲
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 px-0 text-base leading-none"
                      onClick={() => updateEditor("rotation", ((editor.rotation ?? 0) + 90) % 360)}
                      title="Rotate right 90°"
                      aria-label="Rotate right"
                    >
                      ⟳
                    </Button>
                    <Button
                      type="button"
                      variant={editor.flipH ? "default" : "outline"}
                      className="h-9 px-0 text-xs"
                      onClick={() => updateEditor("flipH", !editor.flipH)}
                      title="Flip horizontal"
                    >
                      Flip H
                    </Button>
                    <Button
                      type="button"
                      variant={editor.flipV ? "default" : "outline"}
                      className="h-9 px-0 text-xs"
                      onClick={() => updateEditor("flipV", !editor.flipV)}
                      title="Flip vertical"
                    >
                      Flip V
                    </Button>
                  </div>
                </div>
                <Button
                  type="button"
                  variant={editor.grayscale ? "default" : "outline"}
                  className="w-full"
                  onClick={() => updateEditor("grayscale", !editor.grayscale)}
                >
                  {editor.grayscale ? "Grayscale ✓" : "Grayscale"}
                </Button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Tools
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant={mode === "crop" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("crop")}>
                    ✂ Crop
                  </Button>
                  <Button type="button" variant={mode === "text" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("text")}>
                    Add Text
                  </Button>
                  <Button type="button" variant={mode === "movetext" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("movetext")}>
                    Move / Edit Text
                  </Button>
                  <Button type="button" variant={mode === "erase" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("erase")}>
                    Erase Box
                  </Button>
                  <Button type="button" variant={mode === "pen" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("pen")}>
                    Erase Pen
                  </Button>
                  <Button type="button" variant={mode === "line" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("line")}>
                    ╱ Line
                  </Button>
                  <Button type="button" variant={mode === "arrow" ? "default" : "outline"} className="px-2 text-[12px]" onClick={() => setMode("arrow")}>
                    ➤ Arrow
                  </Button>
                </div>
                {mode === "line" || mode === "arrow" ? (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                    <div className="text-xs text-muted-foreground">
                      Drag on the image to draw a {mode}. Use this to redraw a dimension leader or arrow
                      that got covered while editing units.
                    </div>
                    <label className="block space-y-1 text-sm">
                      <span>Colour</span>
                      <input
                        type="color"
                        value={shapeColor}
                        onChange={(event) => setShapeColor(event.target.value)}
                        className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>Thickness: {shapeWidth}px</span>
                      <input
                        type="range"
                        min="1"
                        max="12"
                        value={shapeWidth}
                        onChange={(event) => setShapeWidth(Number(event.target.value))}
                        className="w-full"
                      />
                    </label>
                  </div>
                ) : mode === "movetext" ? (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                    {selectedTextLayer ? (
                      <>
                        <label className="block space-y-1 text-sm">
                          <span>Text</span>
                          <Input
                            value={selectedTextLayer.text}
                            onChange={(event) => updateSelectedText({ text: event.target.value })}
                          />
                        </label>
                        <label className="block space-y-1 text-sm">
                          <span>Size: {selectedTextLayer.size}px</span>
                          <input
                            type="range"
                            min="8"
                            max="140"
                            value={selectedTextLayer.size}
                            onChange={(event) => updateSelectedText({ size: Number(event.target.value) })}
                            className="w-full"
                          />
                        </label>
                        <label className="block space-y-1 text-sm">
                          <span>Colour</span>
                          <input
                            type="color"
                            value={selectedTextLayer.color}
                            onChange={(event) => updateSelectedText({ color: event.target.value })}
                            className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                          />
                        </label>
                        <Button type="button" variant="outline" className="w-full border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636]" onClick={deleteSelectedText}>
                          Delete this text
                        </Button>
                      </>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        Click a text label on the image to select it, then drag to move it or use the
                        controls here to resize, recolour, retype, or delete it.
                      </div>
                    )}
                  </div>
                ) : mode === "crop" ? (
                  <div className="space-y-3 rounded-2xl border border-border/70 bg-card/40 p-3">
                    <div className="text-xs text-muted-foreground">
                      Drag on the image to draw a crop, or drag the handles/box to adjust. Fine-tune with the
                      exact pixel boxes below, then Apply.
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(["x", "y", "width", "height"] as Array<keyof CropSelection>).map((field) => (
                        <label key={field} className="block space-y-1 text-xs">
                          <span className="uppercase tracking-wide text-muted-foreground">
                            {field === "width" ? "W" : field === "height" ? "H" : field.toUpperCase()} (px)
                          </span>
                          <Input
                            type="number"
                            value={crop ? Math.round(crop[field]) : 0}
                            onChange={(event) => setCropField(field, Number(event.target.value))}
                            disabled={!crop}
                            className="h-9"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">Aspect ratio</span>
                      <div className="grid grid-cols-5 gap-1.5">
                        {([["Free", null], ["1:1", 1], ["4:3", 4 / 3], ["3:2", 3 / 2], ["16:9", 16 / 9]] as Array<[string, number | null]>).map(([label, value]) => (
                          <Button
                            key={label}
                            type="button"
                            variant={cropAspect === value ? "default" : "outline"}
                            className="h-8 px-0 text-[11px]"
                            onClick={() => setCropAspect(value)}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant="outline" className="h-9" onClick={() => setCrop(null)}>
                        Reset box
                      </Button>
                      <Button type="button" className="h-9" onClick={applyCrop} disabled={!crop}>
                        Apply Crop
                      </Button>
                    </div>
                  </div>
                ) : mode === "text" ? (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                    <Input
                      value={textValue}
                      onChange={(event) => setTextValue(event.target.value)}
                      placeholder="Text to place"
                    />
                    <label className="block space-y-1 text-sm">
                      <span>Text color</span>
                      <input
                        type="color"
                        value={textColor}
                        onChange={(event) => setTextColor(event.target.value)}
                        className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>Text size: {textSize}px</span>
                      <input
                        type="range"
                        min="12"
                        max="96"
                        value={textSize}
                        onChange={(event) => setTextSize(Number(event.target.value))}
                        className="w-full"
                      />
                    </label>
                    <div className="text-xs text-muted-foreground">
                      Click on the image to place this text.
                    </div>
                  </div>
                ) : mode === "erase" ? (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                    <label className="block space-y-1 text-sm">
                      <span>Fill color</span>
                      <input
                        type="color"
                        value={eraseColor}
                        onChange={(event) => setEraseColor(event.target.value)}
                        className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>Box width: {eraseWidth}px</span>
                      <input
                        type="range"
                        min="40"
                        max="500"
                        value={eraseWidth}
                        onChange={(event) => setEraseWidth(Number(event.target.value))}
                        className="w-full"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>Box height: {eraseHeight}px</span>
                      <input
                        type="range"
                        min="20"
                        max="240"
                        value={eraseHeight}
                        onChange={(event) => setEraseHeight(Number(event.target.value))}
                        className="w-full"
                      />
                    </label>
                    <div className="text-xs text-muted-foreground">
                      Click on the image to cover old text or marks.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                    <label className="block space-y-1 text-sm">
                      <span>Pen color</span>
                      <input
                        type="color"
                        value={eraseColor}
                        onChange={(event) => setEraseColor(event.target.value)}
                        className="h-10 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>Brush size: {penSize}px</span>
                      <input
                        type="range"
                        min="4"
                        max="60"
                        value={penSize}
                        onChange={(event) => setPenSize(Number(event.target.value))}
                        className="w-full"
                      />
                    </label>
                    <div className="text-xs text-muted-foreground">
                      Press and drag across the image to erase along fine edges. Use a small brush
                      for detail; toggle off Remove Background first if it clipped the product.
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Layers
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditor((current) => ({ ...current, textLayers: current.textLayers.slice(0, -1) }))}
                    disabled={editor.textLayers.length === 0}
                  >
                    Remove Last Text
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditor((current) => ({ ...current, eraseLayers: current.eraseLayers.slice(0, -1) }))}
                    disabled={editor.eraseLayers.length === 0}
                  >
                    Remove Last Erase
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditor((current) => ({ ...current, shapeLayers: current.shapeLayers.slice(0, -1) }))}
                    disabled={editor.shapeLayers.length === 0}
                  >
                    Remove Last Line/Arrow
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditor((current) => ({ ...current, textLayers: [], eraseLayers: [], shapeLayers: [] }))}
                    disabled={editor.textLayers.length === 0 && editor.eraseLayers.length === 0 && editor.shapeLayers.length === 0}
                  >
                    Clear All Layers
                  </Button>
                  <Button type="button" variant="outline" onClick={onReset}>
                    Revert To Extracted Image
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[52vh] flex-col bg-slate-950/90 lg:min-h-0">
            <div className="shrink-0 border-b border-white/10 px-4 py-3 text-sm text-slate-300 sm:px-5 sm:py-4">
              Page {image?.page ?? "-"} image. Click inside the preview to place the active tool.
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
              <div className="flex min-h-full items-start justify-center">
                {image ? (
                  <div className="relative inline-block">
                    <canvas
                      ref={setCanvasEl}
                      onClick={handleCanvasClick}
                      onMouseDown={handleCanvasPointerDown}
                      onMouseMove={handleCanvasPointerMove}
                      onMouseUp={handleCanvasPointerUp}
                      onMouseLeave={handleCanvasPointerUp}
                      className="block max-h-[60vh] max-w-full cursor-crosshair rounded-2xl border border-white/10 bg-white shadow-2xl lg:max-h-[72vh]"
                    />
                    <canvas
                      ref={setOverlayEl}
                      className="pointer-events-none absolute left-0 top-0 h-full w-full rounded-2xl"
                    />
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 px-6 py-10 text-sm text-slate-400">
                    Select a vendor image to edit.
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="border-t border-white/10 px-5 py-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={!image}>
                Use In TDS
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourcePageCropDialog({
  page,
  pages,
  onSelectPage,
  open,
  onOpenChange,
  onSave,
}: {
  page: SourcePage | null;
  pages: SourcePage[];
  onSelectPage: (pageId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (image: SourceImage) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [selection, setSelection] = useState<CropSelection | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelection(null);
    setDragStart(null);
  }, [open, page?.id]);

  const getLocalPoint = (clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    const x = clamp(clientX - bounds.left, 0, bounds.width);
    const y = clamp(clientY - bounds.top, 0, bounds.height);
    return { bounds, x, y };
  };

  const handlePointerDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const point = getLocalPoint(event.clientX, event.clientY);
    if (!point) return;
    setDragStart({ x: point.x, y: point.y });
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const handlePointerMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    const point = getLocalPoint(event.clientX, event.clientY);
    if (!point) return;

    const nextX = Math.min(dragStart.x, point.x);
    const nextY = Math.min(dragStart.y, point.y);
    const nextWidth = Math.abs(point.x - dragStart.x);
    const nextHeight = Math.abs(point.y - dragStart.y);
    setSelection({ x: nextX, y: nextY, width: nextWidth, height: nextHeight });
  };

  const handlePointerUp = () => {
    setDragStart(null);
  };

  const handleSave = () => {
    if (!page || !selection) return;

    const image = imageRef.current;
    if (!image) return;

    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height || selection.width < 24 || selection.height < 24) return;

    const scaleX = image.naturalWidth / bounds.width;
    const scaleY = image.naturalHeight / bounds.height;
    const sourceX = Math.round(selection.x * scaleX);
    const sourceY = Math.round(selection.y * scaleY);
    const sourceWidth = Math.round(selection.width * scaleX);
    const sourceHeight = Math.round(selection.height * scaleY);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sourceWidth);
    canvas.height = Math.max(1, sourceHeight);

    const context = canvas.getContext("2d");
    if (!context) return;

    // Keep the crop at the source page's full native resolution with high-quality sampling.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    // Fill an opaque white background first so any transparent areas of the crop
    // become clean white (product visuals sit on white, matching the sheet).
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    onSave({
      id: `crop-${page.page}-${Date.now()}`,
      page: page.page,
      width: canvas.width,
      height: canvas.height,
      dataUrl: canvas.toDataURL("image/png"),
    });
  };

  const isValidSelection = Boolean(selection && selection.width >= 24 && selection.height >= 24);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1180px)] max-w-none overflow-hidden p-0">
        <div className="flex max-h-[92vh] min-h-0 flex-col overflow-y-auto lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden">
          <div className="shrink-0 border-b border-border/60 p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <DialogHeader>
              <DialogTitle>Crop Vendor PDF</DialogTitle>
              <DialogDescription>
                Drag over the rendered vendor page to capture the product image. The crop will appear in the extracted image section for further editing.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-5 space-y-4 text-sm text-muted-foreground">
              {pages.length > 1 && (
                <div>
                  <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    PDF Page
                  </div>
                  <select
                    value={page?.id ?? ""}
                    onChange={(event) => onSelectPage(event.target.value)}
                    className="h-10 w-full rounded-xl border border-border/70 bg-background px-3 text-sm text-foreground"
                  >
                    {pages.map((sourcePage) => (
                      <option key={sourcePage.id} value={sourcePage.id}>
                        Page {sourcePage.page}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <p>Select only the product visual. Tables, logos, and page backgrounds should stay out of the crop.</p>
              <p>Minimum crop size is 24 x 24 pixels in the preview.</p>
              <div className="rounded-2xl border border-border/70 bg-card/40 p-3">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Current Selection
                </div>
                <div className="mt-2 text-sm text-foreground">
                  {selection
                    ? `${Math.round(selection.width)} x ${Math.round(selection.height)}`
                    : "No crop selected"}
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[52vh] flex-col bg-slate-950/90 lg:min-h-0">
            <div className="shrink-0 border-b border-white/10 px-4 py-3 text-sm text-slate-300 sm:px-5 sm:py-4">
              Page {page?.page ?? "-"} preview. Click and drag to define the crop area.
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
              <div className="flex min-h-full items-start justify-center">
                {page ? (
                  <div
                    className="relative inline-block cursor-crosshair overflow-hidden rounded-2xl border border-white/10"
                    onMouseDown={handlePointerDown}
                    onMouseMove={handlePointerMove}
                    onMouseUp={handlePointerUp}
                    onMouseLeave={handlePointerUp}
                  >
                    <img
                      ref={imageRef}
                      src={page.dataUrl}
                      alt={`Vendor PDF page ${page.page}`}
                      className="block max-h-[72vh] max-w-full select-none"
                      draggable={false}
                    />
                    {selection ? (
                      <div
                        className="pointer-events-none absolute border-2 border-cyan-400 bg-cyan-400/15 shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]"
                        style={{
                          left: selection.x,
                          top: selection.y,
                          width: selection.width,
                          height: selection.height,
                        }}
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 px-6 py-10 text-sm text-slate-400">
                    Select a vendor page to crop.
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="border-t border-white/10 px-5 py-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={!page || !isValidSelection}>
                Add Cropped Image
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function splitLineList(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePreviewDescription(value: string) {
  return trimWords(value, 80);
}

function normalizePreviewFeatures(value: string) {
  // Show only the real (extracted/edited) features, at close to full length. No fabricated filler.
  return splitLineList(value)
    .map((feature) => normalizeText(feature).replace(/^[*•-]\s*/, "").replace(/\.$/, ""))
    .filter(isSpecified)
    .map((feature) => trimWords(feature, 22));
}

function buildPreviewVariantRows(spec: ExtendedExtractedSpec) {
  const parameters = spec.variantOverview?.parameters ?? [];
  const matrix = spec.variantOverview?.matrix ?? [];
  if (parameters.length === 0 || matrix.length === 0) return [];

  const fixtureTypeIndex = parameters.findIndex((item) => normalizeSpecKey(item) === "fixture type");
  const labelIndex = parameters.findIndex((item) => normalizeSpecKey(item) === "label");
  const powerIndex = parameters.findIndex((item) => normalizeSpecKey(item) === "power");
  const lumenIndex = parameters.findIndex((item) => normalizeSpecKey(item) === "lumen output");
  const cctIndex = parameters.findIndex((item) => {
    const normalized = normalizeSpecKey(item);
    return normalized === "color temperature" || normalized === "cct";
  });
  const efficacyIndex = parameters.findIndex((item) => normalizeSpecKey(item) === "efficacy");

  return matrix
    .map((row, index) => {
      const fullLabel = normalizeText(row[labelIndex] ?? `Variant ${index + 1}`);
      const fixtureType = normalizeText(row[fixtureTypeIndex] ?? "");
      const displaySource = fixtureType || fullLabel;
      const sizeMatch = fullLabel.match(/\(([^)]+)\)/);
      const compactLabel = normalizeText(sizeMatch?.[1] ?? displaySource);
      const fixtureDisplay = compactLabel
        .replace(/\b(\d)\s*x\s*(\d)\s*feet?\b/i, "$1'x$2'")
        .replace(/\b(\d)\s*x\s*(\d)\b/i, "$1'x$2'")
        .replace(/\s+/g, " ")
        .trim();
      const safeFixtureLabel = /^variant\s+\d+$/i.test(fixtureDisplay)
        ? ""
        : fixtureDisplay;

      return {
        id: `variant-preview-${index}`,
        fixture: safeFixtureLabel,
        fixtureDetail: fullLabel,
        power: normalizeText(row[powerIndex] ?? ""),
        lumens: normalizeText(row[lumenIndex] ?? ""),
        cct: normalizeText(row[cctIndex] ?? ""),
        efficacy: normalizeText(row[efficacyIndex] ?? ""),
      };
    })
    .filter((row) => isSpecified(row.fixture) || isSpecified(row.power) || isSpecified(row.lumens));
}

/** Power overview value grouped BY VARIANT/SIZE:
 *  - ONE selectable fixture, or variants that don't differ by size/label -> a single hyphen-joined
 *    ascending wattage line (e.g. "22W-30W-38W");
 *  - GENUINE size/attribute variants (each row has its own size/label) -> one line per variant,
 *    prefixed with the size/label (e.g. "11 inch: 20W-24W" / "14 inch: 30W-36W"), so power is shown
 *    per variant instead of every wattage merged into one line. */
function buildVariantPowerValue(spec: ExtendedExtractedSpec, label: string) {
  const variantRows = buildPreviewVariantRows(spec);
  if (variantRows.length === 0) return "";
  const groups = variantRows
    .map((row, index) => ({
      fixture: normalizeText(row.fixture),
      detail: normalizeText(row.fixtureDetail) || `Variant ${index + 1}`,
      watts: formatSelectableWatts(compactSelectableValue(label, normalizeText(row.power))),
    }))
    .filter((entry) => isSpecified(entry.watts));
  if (groups.length === 0) return "";
  // ONE variant/fixture (a single selectable product) -> one hyphen-joined ascending line.
  if (groups.length === 1) return groups[0].watts;
  // MULTIPLE variants -> one line PER variant so each variant's own selectable powers stay together
  // (never every wattage merged into one line). Prefer the size/fixture label; otherwise fall back
  // to the variant label ("Variant 1") so power-selectable variants without a size are still split.
  return groups
    .map((group) => {
      const lbl = isSpecified(group.fixture) ? group.fixture : group.detail;
      return isSpecified(lbl) ? `${lbl}: ${group.watts}` : group.watts;
    })
    .join("\n");
}

type VariantOption = { key: string; power: string; lumen: string; efficacy: string };
type VariantGroup = {
  id: string;
  fixture: string;
  cct: string;
  selectable: boolean;
  options: VariantOption[];
};

/** Group the fixture's variants: each buildPreviewVariantRows row becomes a group. A group whose
 *  power splits into >1 value is "selectable" (one fixture offering multiple wattages); a single
 *  value is a distinct (non-selectable) variant. Each option carries its own lumen/efficacy. */
function enumerateVariantGroups(spec: ExtendedExtractedSpec): VariantGroup[] {
  const variants = buildPreviewVariantRows(spec);
  const split = (value: string) =>
    String(value ?? "")
      .replace(/([A-Za-z])\s*-\s*(?=\d)/g, "$1|")
      .split(/\s*[/|–—]\s*|\n/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
  return variants
    .map((variant, vi) => {
      const powers = split(stripCatalogCode(variant.power));
      const lumens = split(variant.lumens);
      const count = Math.max(powers.length, lumens.length, 1);
      const options: VariantOption[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < count; i += 1) {
        const power = powers[i] ?? (powers.length === 1 ? powers[0] : "");
        const lumen = lumens[i] ?? (lumens.length === 1 ? lumens[0] : "");
        if (!isSpecified(power) && !isSpecified(lumen)) continue;
        const dedupeKey = `${power}|${lumen}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const w = Number((power.match(/[\d.]+/) ?? [])[0]);
        const lm = Number((lumen.replace(/,/g, "").match(/[\d.]+/) ?? [])[0]);
        const efficacy =
          Number.isFinite(w) && w > 0 && Number.isFinite(lm) && lm > 0
            ? `${Math.round(lm / w)} lm/W`
            : normalizeText(variant.efficacy);
        options.push({ key: `grp-${vi}-${i}`, power, lumen, efficacy });
      }
      return {
        id: `grp-${vi}`,
        fixture: variant.fixture,
        cct: variant.cct,
        selectable: options.length > 1,
        options,
      };
    })
    .filter((group) => group.options.length > 0);
}

/** Narrow a draft to a chosen set of powers (one = single, many = a selectable subset). The Power /
 *  Lumen / Efficacy / CCT overview rows and the spec table reflect only those; the rest is kept. */
function makeVariantDraft(draft: EditorDraft, group: VariantGroup, options: VariantOption[]): EditorDraft {
  const powerValue = options.map((o) => o.power).filter(isSpecified).join(" - ");
  const lumenValue = options.map((o) => o.lumen).filter(isSpecified).join(" - ");
  const effs = [...new Set(options.map((o) => o.efficacy).filter(isSpecified))];
  const efficacyValue = effs.length <= 1 ? effs[0] ?? "" : effs.join(" - ");
  const overviewRows = draft.overviewRows.map((row) => {
    const key = normalizeSpecKey(row.label);
    if (key === "power" || key === "power selectable" || key === "max power") return { ...row, value: powerValue };
    if (key === "lumen output" || key === "lumens") return { ...row, value: lumenValue };
    if (key === "efficacy") return { ...row, value: efficacyValue };
    if (isCctLabel(row.label)) {
      const cct = extractCctValue(group.cct);
      return isSpecified(cct) ? { ...row, value: cct } : row;
    }
    return row;
  });
  const base = draft.specGroups[0];
  const specGroups: SpecGroup[] = [
    {
      id: "variant",
      partNumber: group.fixture || draft.title,
      sku: draft.skuNumber,
      options: options.map((o) => ({ power: o.power, lumen: o.lumen })),
      voltage: base?.voltage ?? "",
      efficacy: efficacyValue,
      cri: base?.cri ?? "",
      current: base?.current ?? "",
      cct: group.cct,
      thd: base?.thd ?? "",
      lightDistribution: base?.lightDistribution ?? "",
    },
  ];
  return { ...draft, overviewRows, specGroups };
}

const OVERVIEW_LABEL_ACRONYMS = new Set([
  "AC",
  "BUG",
  "CCT",
  "CRI",
  "DC",
  "EPA",
  "IK",
  "IP",
  "LED",
  "THD",
  "UGR",
  "UV",
]);

const canonicalOverviewLabelKey = (label: string) => label.replace(/\s+/g, " ").trim().toLowerCase();

/** Ensure the first letter is capitalized and any known acronym stays uppercase, while otherwise
 *  preserving the supplied wording (used for the canonical Indoor/Outdoor overview heads). */
function capitalizeOverviewHead(label: string) {
  const withAcronyms = label.replace(/[A-Za-z]+/g, (word) =>
    OVERVIEW_LABEL_ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word,
  );
  return withAcronyms.replace(/[A-Za-z]/, (char) => char.toUpperCase());
}

// Exact canonical overview heads (from the Indoor/Outdoor master lists) keyed by a normalized form,
// so formatOverviewLabel renders them VERBATIM — preserving the supplied caps/lowercase exactly
// (e.g. "Total Harmonic Distortion (THD)", "Ingress Protection Rating (IP)", lowercase "voltage").
const CANONICAL_OVERVIEW_LABELS = new Map<string, string>(
  [...CATEGORY_OVERVIEW_TEMPLATES.indoor, ...CATEGORY_OVERVIEW_TEMPLATES.outdoor].map(
    (row) => [canonicalOverviewLabelKey(row.label), row.label] as const,
  ),
);


function formatOverviewLabel(value: string) {
  const normalized = normalizeText(value);
  // Canonical category heads: keep the supplied wording but capitalize the first letter and any
  // known acronym (e.g. "voltage" -> "Voltage", "led light source" -> "LED light source").
  const canonicalExact = CANONICAL_OVERVIEW_LABELS.get(canonicalOverviewLabelKey(normalized));
  if (canonicalExact) return capitalizeOverviewHead(canonicalExact);
  // EPA head — vendors glue/lowercase it ("EPA(Effective Protected Area)", "epa"); always render
  // the acronym fully uppercase.
  const epaProbe = normalized.replace(/[()]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (epaProbe === "epa" || epaProbe.startsWith("epa ") || epaProbe.includes("effective protected area") || epaProbe.includes("effective projected area")) {
    return "EPA (Effective Protected Area)";
  }
  // If the user wrote it in ALL CAPS, that's intentional — keep their casing as-is.
  if (normalized && /[A-Za-z]/.test(normalized) && normalized === normalized.toUpperCase()) {
    return normalized;
  }

  const canonical = canonicalizeSpecLabel(value);
  if (canonical && canonical !== normalized) {
    return canonical;
  }

  // Vendor rows that aren't a canonical head: Title Case every word (so "sensor type" ->
  // "Sensor Type"), keeping known acronyms and pure numbers uppercase. Small connector words
  // stay lowercase unless they lead the label.
  const TITLE_CASE_MINOR_WORDS = new Set(["and", "or", "of", "the", "for", "to", "in", "with", "a", "an"]);
  return normalizeText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const uppercasePart = part.toUpperCase();
      if (OVERVIEW_LABEL_ACRONYMS.has(uppercasePart) || /^\d+$/.test(part)) {
        return uppercasePart;
      }

      const lowerPart = part.toLowerCase();
      if (index > 0 && TITLE_CASE_MINOR_WORDS.has(lowerPart)) {
        return lowerPart;
      }
      return lowerPart.charAt(0).toUpperCase() + lowerPart.slice(1);
    })
    .join(" ");
}

/** For Power / CCT heads, append "(Selectable)" ONLY when the value is a multi-option list (dash-
 *  joined, e.g. "40W - 60W" or "3000K - 4000K"); a single value gets no "(Selectable)". Any pre-baked
 *  "(Selectable)" on the head is stripped first so it's driven purely by the value.
 *  For CCT the "(Selectable)" REPLACES the "(CCT)" acronym bracket when selectable — so it reads
 *  "Color Temperature (Selectable)" (selectable) or "Color Temperature (CCT)" (fixed), never both. */
function overviewHeadWithSelectable(head: string, label: string, value: string) {
  // Strip any pre-baked "(Selectable)" so the suffix is driven purely by the value.
  const base = head.replace(/\s*\(selectable\)\s*$/i, "").trim();
  const isPower = /^(power|max power)$/i.test(base);
  const isCct = isCctLabel(label) || /\bcct\b/i.test(base) || /color\s*temp/i.test(base);
  if (!isPower && !isCct) return head;
  // Multi-option when the value has 2+ tokens, whether dash-joined with spaces ("40W - 60W") or
  // without ("10W-12W-15W"), or slash/pipe/newline separated.
  const selectable =
    String(value ?? "")
      .split(/\s*[-–—/|]\s*|\n/)
      .map((token) => token.trim())
      .filter(Boolean).length > 1;
  if (isCct) {
    // Drop the "(CCT)" acronym bracket; show "(Selectable)" only when selectable, else keep "(CCT)".
    const withoutAcronym = base.replace(/\s*\(\s*cct\s*\)\s*/i, " ").replace(/\s+/g, " ").trim();
    return selectable ? `${withoutAcronym} (Selectable)` : base;
  }
  return selectable ? `${base} (Selectable)` : base;
}

/** Render an overview head with the bracketed portion in normal (non-bold) weight — the head cell
 *  is bold, so the "(THD)", "(Selectable)", "(EPA)" etc. parts get font-normal to stand apart. */
function renderOverviewHead(label: string) {
  return label.split(/(\([^)]*\))/g).map((part, index) =>
    part.startsWith("(") ? (
      <span key={index} className="font-normal">{part}</span>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function isSpecified(value: string | null | undefined) {
  const normalized = normalizeText(value ?? "");
  return normalized !== "" && normalized.toLowerCase() !== "not specified";
}

// ---- Source grounding: verify an extracted value against the vendor PDF text ----
type GroundLevel = "high" | "low" | "none";

function groundingSnippet(source: string, needle: string): string {
  const idx = source.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return "";
  const start = Math.max(0, idx - 24);
  const end = Math.min(source.length, idx + needle.length + 24);
  const text = source.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < source.length ? "…" : ""}`;
}

/** How well an extracted value is supported by the vendor source text.
 *  Splits selectable values (e.g. "3000K/4000K"), and for each part checks whether
 *  its numbers (exact) or key words appear in the source. */
function groundValue(value: string, sourceText: string): { level: GroundLevel; evidence: string } {
  const v = normalizeText(value ?? "");
  if (!isSpecified(v)) return { level: "none", evidence: "" };
  if (!sourceText) return { level: "none", evidence: "" };

  const srcLower = sourceText.toLowerCase();
  const srcNumbers = new Set(sourceText.match(/\d+(?:\.\d+)?/g) ?? []);
  const parts = v.split(/[/|,]/).map((part) => part.trim()).filter(Boolean);

  let hits = 0;
  let total = 0;
  let evidence = "";
  for (const part of parts) {
    total += 1;
    const digits = part.match(/\d+(?:\.\d+)?/g) ?? [];
    let found = false;
    if (digits.length > 0) {
      for (const digit of digits) {
        if (srcNumbers.has(digit)) {
          found = true;
          if (!evidence) evidence = groundingSnippet(sourceText, digit);
          break;
        }
      }
    } else {
      const words = part.toLowerCase().match(/[a-z]{3,}/g) ?? [];
      for (const word of words) {
        if (srcLower.includes(word)) {
          found = true;
          if (!evidence) evidence = groundingSnippet(sourceText, word);
          break;
        }
      }
    }
    if (found) hits += 1;
  }

  if (total === 0 || hits === 0) return { level: "none", evidence: "" };
  if (hits === total) return { level: "high", evidence };
  return { level: "low", evidence };
}

const CONFIDENCE_STYLE: Record<GroundLevel, { color: string; label: string }> = {
  high: { color: "bg-emerald-500", label: "Found in vendor PDF" },
  low: { color: "bg-amber-500", label: "Partly matched in vendor PDF" },
  none: { color: "bg-rose-500", label: "Not found in vendor PDF — verify" },
};

/** Small dot flag showing whether a field's value is grounded in the source PDF. */
function ConfidenceBadge({ value, sourceText }: { value: string; sourceText?: string }) {
  if (!isSpecified(value)) return null;
  const { level, evidence } = groundValue(value, sourceText ?? "");
  const style = CONFIDENCE_STYLE[level];
  const title = evidence ? `${style.label}\nsource: ${evidence}` : style.label;
  return (
    <span
      title={title}
      aria-label={style.label}
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", style.color)}
    />
  );
}

function extractWarrantyNumber(value: string) {
  const match = value.match(/\d+/);
  return match?.[0] ?? "5";
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

function SheetSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <h3 className="text-[13px] font-bold tracking-[0.01em] text-[#00a651]" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
        {children}
      </h3>
    </div>
  );
}

function QualificationBadge({
  id,
  selected: _selected = false,
  className,
  style,
}: {
  id: QualificationBadgeId;
  selected?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const badge = QUALIFICATION_BADGES.find((item) => item.id === id);
  if (!badge) return null;

  return (
    <img
      src={`${import.meta.env.BASE_URL}images/badges/${badge.imageFile}`}
      alt={badge.label}
      className={cn("block h-[60px] w-auto max-w-[82px] object-contain", className)}
      style={style}
    />
  );
}

function WarrantySeal({ label }: { label: string }) {
  const imageFile = label.includes("10")
    ? "10-Year-Warranty.png"
    : label.includes("5")
      ? "5-Year-Warranty.png"
      : null;

  if (!imageFile) {
    const years = label.match(/\d+/)?.[0] ?? "";
    return (
      <div
        className="flex h-[64px] w-[64px] flex-col items-center justify-center rounded-full border-2 border-[#b3272d] text-center text-[#b3272d]"
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      >
        <span className="text-[22px] font-extrabold leading-none">{years}</span>
        <span className="text-[7px] font-bold uppercase leading-[1.1] tracking-wide">Year Warranty</span>
      </div>
    );
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}images/badges/${imageFile}`}
      alt={label}
      className="block h-[64px] w-auto object-contain"
    />
  );
}

/**
 * Any sheet image, wrapped in a drag-to-position frame. When `editable` is set (only in the live
 * preview), the user can drag the image around its box and pull the corner handle to resize it; the
 * frame outline + handle carry `data-export-hide` so they are stripped from the PDF/print output
 * while the image's transform is kept. When not editable it renders as a plain object-contain image
 * (unchanged behaviour). Sizing is controlled by the caller via `className`/`imgClassName` so the
 * same component fits the product box, dimension slots, accessory thumbnails and custom sections.
 */
const IMAGE_ALIGN_OPTIONS = [
  { value: "left" as const, Icon: AlignLeft },
  { value: "center" as const, Icon: AlignCenter },
  { value: "right" as const, Icon: AlignRight },
];

const IMAGE_VALIGN_OPTIONS = [
  { value: "top" as const, Icon: AlignStartHorizontal },
  { value: "middle" as const, Icon: AlignCenterHorizontal },
  { value: "bottom" as const, Icon: AlignEndHorizontal },
];

function DraggableSheetImage({
  image,
  placement,
  editable,
  onChange,
  className,
  imgClassName,
  alt,
}: {
  image: SourceImage;
  placement: ImagePlacement;
  editable: boolean;
  onChange?: (next: ImagePlacement) => void;
  className?: string;
  imgClassName?: string;
  alt?: string;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; start: ImagePlacement } | null>(null);

  const begin = (mode: "move" | "resize") => (event: ReactPointerEvent) => {
    if (!editable || !onChange) return;
    event.preventDefault();
    event.stopPropagation();
    cellRef.current?.setPointerCapture(event.pointerId);
    drag.current = { mode, startX: event.clientX, startY: event.clientY, start: placement };
  };

  const move = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (!state || !onChange) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (state.mode === "move") {
      onChange({ ...state.start, x: state.start.x + dx, y: state.start.y + dy });
    } else {
      // Corner handle: dragging out (right/down) grows, in (left/up) shrinks. Clamp to a sane range.
      const nextScale = Math.min(3, Math.max(0.2, state.start.scale + (dx + dy) / 220));
      onChange({ ...state.start, scale: nextScale });
    }
  };

  const end = (event: ReactPointerEvent) => {
    if (!drag.current) return;
    cellRef.current?.releasePointerCapture?.(event.pointerId);
    drag.current = null;
  };

  return (
    <div
      ref={cellRef}
      className={cn("relative", className ?? "flex h-full min-w-0 items-center justify-center overflow-visible")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img
        src={image.dataUrl}
        alt={alt ?? "Sheet image"}
        className={imgClassName ?? "h-full w-full object-contain"}
        draggable={false}
        onPointerDown={begin("move")}
        onDoubleClick={() => editable && onChange?.(DEFAULT_IMAGE_PLACEMENT)}
        style={{
          transform: `translate(${placement.x}px, ${placement.y}px) scale(${placement.scale})`,
          transformOrigin: "center",
          // Snap the image within its slot on both axes (works whenever the contained image is
          // smaller than the box — e.g. after scaling down, wide dimension drawings leave vertical
          // slack, tall images leave horizontal slack).
          objectPosition: `${
            placement.align === "left" ? "left" : placement.align === "right" ? "right" : "center"
          } ${placement.valign === "top" ? "top" : placement.valign === "bottom" ? "bottom" : "center"}`,
          touchAction: "none",
          cursor: editable ? "move" : "default",
        }}
      />
      {editable && (
        <>
          {/* Dashed slot outline + corner resize handle — preview only, excluded from export. */}
          <div
            data-export-hide="true"
            className="pointer-events-none absolute inset-0 rounded-[2px] border border-dashed border-sky-500/70"
          />
          {/* Fit toolbar — horizontal (L/C/R) and vertical (T/M/B) — pinned inside the top of the
              frame (so it is never clipped by an overflow-hidden slot), preview only. */}
          {onChange && (
            <div
              data-export-hide="true"
              className="absolute left-1/2 top-1 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-slate-200 bg-white/95 px-1 py-0.5 shadow-sm"
            >
              {IMAGE_ALIGN_OPTIONS.map(({ value, Icon }) => {
                const active = (placement.align ?? "center") === value;
                return (
                  <button
                    key={value}
                    type="button"
                    title={`Fit ${value}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange({ ...placement, align: value });
                    }}
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded",
                      active ? "bg-sky-500 text-white" : "text-slate-500 hover:bg-slate-100",
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </button>
                );
              })}
              <span className="mx-0.5 h-4 w-px bg-slate-200" />
              {IMAGE_VALIGN_OPTIONS.map(({ value, Icon }) => {
                const active = (placement.valign ?? "middle") === value;
                return (
                  <button
                    key={value}
                    type="button"
                    title={`Fit ${value}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange({ ...placement, valign: value });
                    }}
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded",
                      active ? "bg-sky-500 text-white" : "text-slate-500 hover:bg-slate-100",
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </button>
                );
              })}
            </div>
          )}
          <div
            data-export-hide="true"
            onPointerDown={begin("resize")}
            title="Drag to resize — double-click the image to reset"
            className="absolute bottom-1 right-1 z-10 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-sky-500 shadow"
            style={{ touchAction: "none" }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Context-aware sheet image: looks up its placement + edit callback from SheetImageEditingContext,
 * so any render helper can drop in `<SheetImage image={...} />` and get drag/resize for free.
 */
function SheetImage({
  image,
  className,
  imgClassName,
  alt,
}: {
  image: SourceImage;
  className?: string;
  imgClassName?: string;
  alt?: string;
}) {
  const ctx = useContext(SheetImageEditingContext);
  const placement = ctx.placements[image.id] ?? DEFAULT_IMAGE_PLACEMENT;
  return (
    <DraggableSheetImage
      image={image}
      placement={placement}
      editable={ctx.editable && Boolean(ctx.onChange)}
      onChange={ctx.onChange ? (next) => ctx.onChange?.(image.id, next) : undefined}
      className={className}
      imgClassName={imgClassName}
      alt={alt}
    />
  );
}

function SheetPageOne({
  draft,
  selectedImage,
  spec,
  variantSelected,
}: {
  draft: EditorDraft;
  selectedImage: SourceImage | null;
  spec: ExtendedExtractedSpec;
  variantSelected?: boolean;
}) {
  const features = normalizePreviewFeatures(draft.featuresText);
  const applicationAreas = splitCommaList(draft.applicationAreasText);
  // Product images to show on the sheet: the selected hero first, then any other product-owned
  // images, capped at 2 so up to two product visuals appear (not always just one).
  const productOwnedImages = getDraftSourceImages(spec, draft).filter(
    (image) => (draft.imageOwners[image.id] ?? defaultImageOwner(image.id)) === "product",
  );
  const productDisplayImages = (
    selectedImage
      ? [selectedImage, ...productOwnedImages.filter((image) => image.id !== selectedImage.id)]
      : productOwnedImages
  ).slice(0, 2);
  // Efficacy is ALWAYS recomputed from THIS fixture's own Power & Lumen (lumens / power) at render
  // time — never the vendor's stated figure — so even drafts saved before this rule self-correct.
  // Compute it from the DRAFT's own Power/Lumen rows (the values actually on the sheet), because a
  // reconstructed spec may not carry variantOverview/technicalSpecs; fall back to the spec if the
  // draft rows are absent.
  const draftOverviewRowValue = (match: (label: string) => boolean) =>
    draft.overviewRows.find((row) => isSpecified(row.value) && match(row.label))?.value ?? "";
  const draftPowerText = draftOverviewRowValue(isPowerSelectableOverviewLabel);
  const draftLumenText = draftOverviewRowValue(
    (label) => normalizeSpecKey(label) === "lumen output" || normalizeSpecKey(label) === "lumens",
  );
  const computedEfficacy =
    efficacyFromWattsLumens(draftPowerText, draftLumenText) || deriveEfficacyFromPowerLumen(spec);
  // Power: when the fixture has MULTIPLE variants, recompute the row so each variant's selectable
  // powers show on their OWN line (never every wattage merged into one line) — this self-corrects
  // drafts saved before the per-variant rule. For a single selectable fixture we leave the stored
  // value alone so a manual edit still sticks. When a single variant is CHOSEN from the sheet-variant
  // selector, don't override: the narrowed draft already holds just that variant's powers.
  const computedPower =
    !variantSelected && buildPreviewVariantRows(spec).length > 1
      ? buildVariantPowerValue(spec, "Power")
      : "";
  const filteredOverviewRows = draft.overviewRows
    .filter((row) => row.included !== false)
    .filter((row) => isSpecified(row.label) && isSpecified(row.value))
    .filter((row) => !isExcludedOverviewLabel(row.label))
    .map((row) => {
      // A hand-edited value always wins — show EXACTLY what the user typed (no auto-compute AND no
      // reformatting). This is why an edit "wasn't reflecting": normalizeOverviewRowValue re-derived
      // the display value (e.g. formatVoltage turned "100-277 | 200-480V" into "100-277-200-480V").
      if (row.manual) {
        return row;
      }
      if (normalizeSpecKey(row.label) === "efficacy" && isSpecified(computedEfficacy)) {
        return { ...row, value: computedEfficacy };
      }
      if (isPowerSelectableOverviewLabel(row.label) && isSpecified(computedPower)) {
        return { ...row, value: computedPower };
      }
      return { ...row, value: normalizeOverviewRowValue(row.label, row.value) };
    });
  // Overview auto-fit: measure the rendered table against the fixed box and grow the font to fill
  // the space, or shrink it to fit — so EVERYTHING is shown (never clipped) while using as much of
  // the box as possible. Padding scales with the font so the column stays balanced top-to-bottom.
  // Manual override from the editor (Overview → Text size). null = auto-fit.
  const manualOverviewFontPx =
    typeof draft.overviewFontPx === "number" && draft.overviewFontPx > 0 ? draft.overviewFontPx : null;
  // Auto-fit the Overview to the fixed box by sizing the font to the total content height. We count
  // display lines INCLUDING multi-line values (Power/Lumen lists) and a rough wrap estimate for long
  // lines, so the whole column fills the box top-to-bottom without clipping. padY scales with font.
  const overviewRowCount = Math.max(1, filteredOverviewRows.length);
  const overviewValueColChars = 30; // ~chars that fit on one value line in the 313px column
  const overviewTotalLines = filteredOverviewRows.reduce((sum, row) => {
    const linesForRow = String(row.value ?? "")
      .split("\n")
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.trim().length / overviewValueColChars)), 0);
    return sum + Math.max(1, linesForRow);
  }, 0);
  // BUG rating (highest) and EPA (lowest) each carry their own clarifying footnote under the Overview.
  const overviewHasBug = filteredOverviewRows.some((row) => isBugRatingLabel(row.label));
  const overviewHasEpa = filteredOverviewRows.some((row) => isEpaLabel(row.label));
  const overviewShowNote = overviewHasBug || overviewHasEpa;
  const overviewNoteCount = (overviewHasBug ? 1 : 0) + (overviewHasEpa ? 1 : 0);
  // height ≈ font*(1.3*lines + rows)  [padY = font*0.5 per side => +font per row]. Solve for font.
  // Reserve ~18px per footnote so the auto-fit leaves room and nothing clips.
  const overviewUsableHeight = 508 - overviewNoteCount * 18;
  const overviewAutoFontPx = Math.max(
    6,
    Math.min(14.5, overviewUsableHeight / (1.3 * overviewTotalLines + overviewRowCount)),
  );
  const overviewFontPx = manualOverviewFontPx ?? overviewAutoFontPx;
  const overviewPadYpx = Math.max(1.5, overviewFontPx * 0.5);
  const normalizedDescription = normalizePreviewDescription(draft.description);
  // Page-1 sections the user removed via the "Sheet sections" controls drop entirely.
  const visibleDescription = isSpecified(normalizedDescription) && !isSectionHidden(draft, "page1:description");
  // Cap the sheet's Features list to 4 points so it never overflows behind the footer.
  const visibleFeatures = isSectionHidden(draft, "page1:features") ? [] : features.filter(isSpecified).slice(0, 4);
  const visibleApplications = isSectionHidden(draft, "page1:applications") ? [] : applicationAreas.filter(isSpecified);
  const warrantyHidden = isSectionHidden(draft, "page1:warranty");
  const visibleWarrantyLabel = isSpecified(draft.warrantyLabel) && !warrantyHidden;
  const visibleWarrantyCopy = isSpecified(draft.warrantyCopy) && !warrantyHidden;
  const showWarrantyBlock = visibleWarrantyLabel || visibleWarrantyCopy;
  const visibleQualificationIds = draft.selectedQualificationIds;
  const showDlcNote = visibleQualificationIds.some(
    (id) => id === "dlc_premium" || id === "dlc_listed",
  );
  // Fixture "group" for the header's category line (e.g. "High Bays"), derived from the recognised
  // fixture type. Sits after the category as: "Indoor Lighting | High Bays".
  const fixtureGroup =
    predictFixtureProfile(draft.title, draft.subtitle, draft.categoryLabel, draft.subCategory)?.group ?? "";

  return (
    <div
      className="sheet-print-root mx-auto h-[1056px] w-[816px] max-w-full overflow-hidden bg-white font-sans text-black shadow-[0_24px_60px_rgba(15,23,42,0.28)]"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      <div className="relative h-[1056px] overflow-hidden bg-white">
        {/* Breathing space above the header */}
        <div className="h-[20px] w-full" />
        <SheetHeader draft={draft} />
        {/* No gap: the content (Overview box) sits flush against the header rule. */}

        {/* Data area (727 x 884 px), filling between header and the footer */}
        <div className="mx-auto flex h-[884px] w-[727px] flex-col overflow-hidden">
          {/* Region A - product name/info + image + badges (left) and overview (right): 727 x 573 px */}
          <div className="flex h-[573px] w-[727px]">
            {/* Left column: 310 pt (413 px) */}
            <div className="flex h-[573px] w-[413px] flex-col overflow-hidden">
              {/* Breathing space after the header line, before the product name (left column only;
                  the Overview box on the right stays flush against the header rule). */}
              <div className="h-[12px] w-full shrink-0" />
              {/* Product header (3 lines): product name, the specific fixture type in bold
                  beneath it, then a divider, then "Category | Fixture Group" — all auto-filled
                  from the recognised fixture type. */}
              <div className="h-[110px] w-[413px] shrink-0 overflow-hidden" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
                {isSpecified(draft.skuNumber) && (
                  <div className="text-[9px] font-bold uppercase leading-[1.15] tracking-[0.04em] text-black">
                    ITEM SKU: {draft.skuNumber}
                  </div>
                )}
                <h1 className="text-[30px] font-bold uppercase leading-[1.02] tracking-[-0.01em] text-[#00a651]">
                  {draft.title}
                </h1>
                {isSpecified(draft.subCategory) && (
                  <div className="mt-0.5 text-[11px] font-bold uppercase leading-[1.2] text-black">
                    {draft.subCategory}
                  </div>
                )}
                <div className="my-1.5 h-px w-full bg-slate-300" />
                {(isSpecified(draft.categoryLabel) || isSpecified(fixtureGroup)) && (
                  <div className="text-[11px] font-normal leading-[1.3] text-black">
                    {isSpecified(draft.categoryLabel) && <span>{draft.categoryLabel}</span>}
                    {isSpecified(draft.categoryLabel) && isSpecified(fixtureGroup) && (
                      <span className="mx-1.5 font-normal text-slate-400">|</span>
                    )}
                    {isSpecified(fixtureGroup) && <span>{fixtureGroup}</span>}
                  </div>
                )}
              </div>

              {/* Image: up to 375 x 354 px. Uses flex-1 with a max height so it fills the space that
                  the badges + DLC note leave, and SHRINKS (never clips — object-contain) when the
                  note needs room. This keeps the qualification icons and note fully visible. */}
              <div className="mt-1.5 min-h-0 max-h-[354px] w-[375px] flex-1 bg-white">
                {productDisplayImages.length > 0 ? (
                  <div
                    className={cn(
                      "grid h-full w-full gap-2",
                      productDisplayImages.length > 1 ? "grid-cols-2" : "grid-cols-1",
                    )}
                  >
                    {productDisplayImages.map((image) => (
                      <SheetImage key={image.id} image={image} alt="Extracted vendor product visual" />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-slate-400">
                    <FileImage className="h-10 w-10" />
                    <p className="max-w-[240px] text-sm">
                      No vendor image has been selected yet. Use the crop action in the vendor PDF panel to add one.
                    </p>
                  </div>
                )}
              </div>

              {/* Product certification badges: left-aligned in the left column (up to the overview).
                  Boxes are sized so ~8 fit the column, and each icon is scaled up to look larger
                  and overlap its PNG padding, tightening the visible spacing. */}
              {visibleQualificationIds.length > 0 && (() => {
                // Size every badge so the whole selected set fits the 413px column — no clipping.
                // Cap at 56px when there are few; shrink evenly as more badges are added.
                const badgeGap = 5;
                const count = visibleQualificationIds.length;
                const badgeMaxWidth = Math.max(
                  22,
                  Math.min(56, Math.floor((413 - (count - 1) * badgeGap) / count)),
                );
                return (
                  <div className="mt-2 flex h-[58px] w-[413px] shrink-0 items-center overflow-hidden" style={{ gap: `${badgeGap}px` }}>
                    {visibleQualificationIds.map((badgeId) => (
                      <QualificationBadge
                        key={badgeId}
                        id={badgeId}
                        className="shrink-0 object-contain"
                        style={{ height: "52px", width: "auto", maxWidth: `${badgeMaxWidth}px`, maxHeight: "56px" }}
                      />
                    ))}
                  </div>
                );
              })()}

              {/* DLC qualification disclaimer: shown only when a DLC badge is selected. */}
              {showDlcNote && (
                <div className="mt-2 mb-2 w-[413px] shrink-0 text-[8px] font-normal italic leading-[1.35] text-black" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
                  <div>Not all product variations listed on the page are DLC qualified.</div>
                  <div>
                    Visit{" "}
                    <a
                      href="https://www.designlights.org/qpl"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline"
                    >
                      https://www.designlights.org/qpl
                    </a>{" "}
                    to confirm qualifications.
                  </div>
                </div>
              )}
            </div>

            {/* Right column - Overview: 313 x 573 px */}
            {filteredOverviewRows.length > 0 && (
              <div className="flex h-[573px] w-[313px] flex-col overflow-hidden bg-slate-50 px-4 pb-2.5 pt-3">
                <h3 className="mb-3 shrink-0 border-b border-slate-300 pb-1 text-[13px] font-bold uppercase tracking-[0.08em] text-[#00a651]" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
                  Overview
                </h3>
                <div className="min-h-0 flex-1 overflow-hidden">
                <table className="w-full border-collapse">
                  <tbody>
                    {filteredOverviewRows.map((row) => (
                      <tr key={row.id} className="border-b border-slate-200 align-middle last:border-b-0">
                        <td
                          className="w-[44%] pr-2 font-bold leading-[1.2] text-black"
                          style={{
                            fontFamily: "Arial, Helvetica, sans-serif",
                            fontSize: `${overviewFontPx}px`,
                            paddingTop: `${overviewPadYpx}px`,
                            paddingBottom: `${overviewPadYpx}px`,
                          }}
                        >
                          {renderOverviewHead(overviewHeadWithSelectable(formatOverviewLabel(row.label), row.label, row.value))}
                        </td>
                        <td
                          className={cn(
                            "text-left font-normal leading-[1.2] whitespace-pre-line",
                            isSpecified(row.value) ? "text-black" : "italic text-slate-400",
                          )}
                          style={{
                            fontSize: `${overviewFontPx}px`,
                            paddingTop: `${overviewPadYpx}px`,
                            paddingBottom: `${overviewPadYpx}px`,
                          }}
                        >
                          {row.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {overviewShowNote && (
                  <div className="shrink-0 space-y-0.5 pt-1 text-[6.5px] font-normal italic leading-[1.25] text-slate-600" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
                    {overviewHasBug && (
                      <div>BUG rating: highest shown; varies by variant, power & distribution — see the BUG chart.</div>
                    )}
                    {overviewHasEpa && (
                      <div>EPA: lowest shown; varies by variant & mounting — see the EPA chart.</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Divider between the image/overview region and the description region: line sits flush
              against the Overview box above, then a small gap before the description region. */}
          <div className="flex h-[16px] w-[727px] items-start">
            <div className="h-px w-full bg-slate-300" />
          </div>

          {/* Region B - description/features + application area/warranty (727 x 295 px) */}
          <div className="flex h-[295px] w-[727px]">
            {/* Description and features (383 x 295 px) */}
            <div className="flex h-[295px] w-[383px] flex-col gap-2 overflow-hidden">
              {visibleDescription && (
                <section>
                  <SheetSectionTitle>Product Description</SheetSectionTitle>
                  <p className="text-[11px] leading-[1.34] text-black">
                    {normalizedDescription}
                  </p>
                </section>
              )}

              {visibleFeatures.length > 0 && (
                <section>
                  <SheetSectionTitle>Features</SheetSectionTitle>
                  <ul className="space-y-0.5 text-[11px] leading-[1.28] text-black">
                    {visibleFeatures.map((feature, index) => (
                      <li key={`${feature}-${index}`} className="flex gap-2">
                        <span className="mt-[3px] h-1 w-1 rounded-full bg-[#00a651]" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            {/* Margin between description/features and application/warranty: 27 pt (36 px) */}
            <div className="w-[36px]" />

            {/* Application area and warranty (304 x 295 px) */}
            <div className="flex h-[295px] w-[304px] flex-col gap-2 overflow-hidden">
              {visibleApplications.length > 0 && (
                <section>
                  <SheetSectionTitle>Application Area</SheetSectionTitle>
                  <p className="text-[11px] leading-[1.28] text-black">
                    {visibleApplications.join(", ")}
                  </p>
                </section>
              )}

              {showWarrantyBlock && (
                <section className="mt-auto mb-6">
                  <SheetSectionTitle>Warranty</SheetSectionTitle>
                  <div className="bg-white py-1">
                    <div className="space-y-1">
                      {visibleWarrantyLabel && (
                        <div>
                          <WarrantySeal label={draft.warrantyLabel} />
                        </div>
                      )}
                      {visibleWarrantyCopy && (
                        <p className="whitespace-pre-line text-[10px] leading-[1.22] text-black">
                          {draft.warrantyCopy}
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>

        <SheetFooter pageNumber={1} note={draft.footerNote} />
      </div>
    </div>
  );
}

// ---- Page-content presence helpers ----
function specGroupHasContent(group: SpecGroup) {
  return (
    isSpecified(group.partNumber) ||
    isSpecified(group.sku) ||
    group.options.some((option) => isSpecified(option.power) || isSpecified(option.lumen)) ||
    [group.voltage, group.efficacy, group.cri, group.current, group.cct, group.thd, group.lightDistribution].some(
      isSpecified,
    )
  );
}
const accessoryRowHasContent = (row: AccessoryRow) =>
  isSpecified(row.code) || isSpecified(row.description) || Boolean(row.imageId) || isSpecified(row.downloadUrl);

const dimensionItemHasContent = (item: DimensionItem) =>
  isSpecified(item.label) ||
  Boolean(item.imageId) ||
  isSpecified(item.width) ||
  isSpecified(item.height) ||
  isSpecified(item.depth);

const IKIO_LOGO_SRC = `${import.meta.env.BASE_URL}images/ikio-logo.svg`;
const IKIO_LOGO_BLACK_SRC = `${import.meta.env.BASE_URL}images/ikio-logo-black.svg`;

/** Header built from real, editable/selectable text (not a baked image). Logo stays as the brand mark.
 *  `showFields` renders the Project Name / CAT.# / Note / Fixture Schedule block (page 1 only). */
function SheetHeader({ draft, showFields = true }: { draft: EditorDraft; showFields?: boolean }) {
  const field = (label: string, value: string) => (
    <div className="flex flex-1 items-end gap-1.5">
      <span className="whitespace-nowrap text-black">{label}</span>
      <span className="min-w-0 flex-1 truncate border-b border-slate-400 pb-[1px] font-medium text-black">
        {value}
      </span>
    </div>
  );
  return (
    <header className="relative h-[88px] w-full bg-white">
      {/* Inner content aligned to the 727px body width; the green rule starts/ends with the content. */}
      <div
        className="mx-auto flex h-full w-[727px] select-text items-center gap-6 border-b-[3px] border-[#00a651]"
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      >
        {showFields ? (
          <>
            {/* Logo left, TDS right; the two flexible spacers are equal so the field
                block is centered with the SAME gap on both sides. */}
            <img src={IKIO_LOGO_SRC} alt="IKIO LED Lighting" className="h-[62px] w-[135px] shrink-0 self-center object-contain" />
            <div className="flex-1" />
            <div className="flex w-[360px] shrink-0 flex-col gap-2 self-center text-[7.5px] text-black">
              <div className="flex items-end gap-5">
                {field("Project Name:", draft.headerProjectName)}
                {field("CAT.#", draft.headerCatNumber)}
              </div>
              <div className="flex items-end gap-5">
                {field("Note:", draft.headerNote)}
                {field("Fixture Schedule:", draft.headerFixtureSchedule)}
              </div>
            </div>
            <div className="flex-1" />
            {/* Mirror the block's two-row height (empty first row) so the label lands on
                the second-row underline while the block stays vertically centered. */}
            <div className="flex shrink-0 flex-col gap-2 self-center">
              <div className="h-[11px]" aria-hidden />
              <span className="flex h-[11px] items-end whitespace-nowrap text-[10px] leading-none text-black">
                Technical Data Sheet
              </span>
            </div>
          </>
        ) : (
          <>
            <img src={IKIO_LOGO_SRC} alt="IKIO LED Lighting" className="h-[62px] w-[135px] shrink-0 object-contain" />
            <div className="flex-1" />
            <span className="shrink-0 self-end pb-1.5 text-[10px] text-black">Technical Data Sheet</span>
          </>
        )}
      </div>
    </header>
  );
}

/** Revision label using the current date, formatted R1.0_MM/DD/YY. */
function currentRevisionLabel() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return `R1.0_${mm}/${dd}/${yy}`;
}

/** Footer built from real, selectable text (not a baked image). */
function SheetFooter({ pageNumber, note }: { pageNumber: number; note?: string }) {
  return (
    <footer className="absolute inset-x-0 bottom-0 h-[64px] w-full bg-[#414042]">
      {/* Grey bar spans the full page width; inner content stays aligned to the 727px body margins. */}
      <div
        className="mx-auto flex h-full w-[727px] select-text items-center gap-4"
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      >
        <img
          src={IKIO_LOGO_BLACK_SRC}
          alt="IKIO LED Lighting"
          className="h-[34px] w-auto shrink-0"
          style={{ filter: "brightness(0) invert(1)" }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[8.5px] font-semibold text-white">
            © 2026 IKIO LED LIGHTING. All Rights Reserved. &nbsp;|&nbsp; info@ikioled.com &nbsp;|&nbsp; +1&nbsp;844-533-4546 &nbsp;|&nbsp; www.ikioled.com
          </div>
          {/* Narrowed a touch so the legal text wraps into three near-equal lines, then
              justified (including the last line) for even edges with tight, uniform spacing. */}
          <div className="mt-1 [text-wrap:balance] text-[6.5px] leading-[1.34] text-slate-200">
            This document and its contents, including but not limited to product designs, specifications, images, and
            technical data, are the property of IKIO LED LIGHTING and may not be reproduced, distributed, or used without
            prior written consent. Products and technologies described herein may be covered by one or more U.S. and/or
            international patents, including patents pending. Product images are for illustration purposes only and may
            not represent the exact product. Specifications are subject to change without notice.
          </div>
          {isSpecified(note) && <div className="mt-0.5 text-[6.5px] leading-[1.3] text-slate-200">{note}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[8.5px] font-medium text-white">
            Page No.: {String(pageNumber).padStart(2, "0")}
          </div>
          <div className="mt-0.5 text-[7px] font-medium text-slate-200">{currentRevisionLabel()}</div>
        </div>
      </div>
    </footer>
  );
}

/** Continuation band shown on pages 2+ under the header: product name + category + qualification
 *  icons, all pulled automatically from the page-1 draft. */
function SheetPageBand({ draft }: { draft: EditorDraft }) {
  return (
    <div
      className="mx-auto flex h-[40px] w-[727px] items-center justify-between gap-4 rounded-sm bg-slate-100 px-3"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      <div className="flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[9.5px]">
        <span className="shrink-0 font-bold uppercase text-black">{draft.title}</span>
        {isSpecified(draft.categoryLabel) && (
          <>
            <span className="shrink-0 text-slate-300">|</span>
            <span className="shrink-0 font-normal text-black">{draft.categoryLabel}</span>
          </>
        )}
        {isSpecified(draft.subCategory) && (
          <>
            <span className="shrink-0 text-slate-300">|</span>
            <span className="shrink-0 font-normal text-black">{draft.subCategory}</span>
          </>
        )}
      </div>
      {draft.selectedQualificationIds.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5">
          {draft.selectedQualificationIds.map((id) => (
            <QualificationBadge key={id} id={id} className="h-[30px] w-auto max-w-[32px] shrink-0 object-contain" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared page chrome (header + continuation band + data area + footer) used by pages 2+. */
function SheetPageFrame({
  draft,
  pageNumber,
  children,
}: {
  draft: EditorDraft;
  pageNumber: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="sheet-print-root mx-auto h-[1056px] w-[816px] max-w-full overflow-hidden bg-white font-sans text-black shadow-[0_24px_60px_rgba(15,23,42,0.28)]"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      <div className="relative h-[1056px] overflow-hidden bg-white">
        {/* Breathing space above the header (matches page 1) */}
        <div className="h-[20px] w-full" />
        <SheetHeader draft={draft} showFields={false} />
        {/* Continuation band (product name + category + icons), auto from page 1 */}
        <SheetPageBand draft={draft} />

        <div className="mx-auto flex h-[844px] w-[727px] flex-col overflow-hidden pt-3">
          {children}
        </div>

        <SheetFooter pageNumber={pageNumber} note={draft.footerNote} />
      </div>
    </div>
  );
}

/** Large blue section heading with an accent underline (matches the IKIO template). */
function SheetPageHeading({ title, trailing }: { title: string; trailing?: string }) {
  return (
    <div className="mb-3 mt-1">
      <div className="flex items-end gap-2">
        <h2 className="text-[13px] font-bold leading-none tracking-[0.01em] text-[#00a651]" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
          {title}
        </h2>
        {isSpecified(trailing) && (
          <span className="pb-[1px] text-[8px] font-semibold text-slate-500">{trailing}</span>
        )}
      </div>
      <div className="mt-1.5 h-[2.5px] w-[99px] bg-[#00a651]" />
      <div className="h-px w-full bg-slate-200" />
    </div>
  );
}

function SheetNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-[8px] leading-[1.3] text-slate-500">
      <span className="font-bold text-[#00a651]">Note: </span>
      {children}
    </p>
  );
}

const SPEC_COLUMNS: Array<{ label: string; unit: string }> = [
  { label: "Part Number", unit: "" },
  { label: "Power Selectable", unit: "W" },
  { label: "Voltage", unit: "V" },
  { label: "Lumen Output", unit: "lm" },
  { label: "Efficacy", unit: "lm/W" },
  { label: "CRI", unit: "" },
  { label: "CCT", unit: "K" },
  { label: "THD", unit: "" },
  { label: "Light Distribution", unit: "" },
];

const SPEC_COL_WIDTHS = ["24%", "9%", "9%", "11%", "9%", "6%", "10%", "6%", "16%"];

/** Repair a variant's Power/Lumen pairs when one lumen is physically impossible for its wattage
 *  (efficacy > 220 lm/W — beyond any real LED, i.e. a mis-read/misaligned value). We keep the
 *  wattage and recompute ONLY the bad lumen from the variant's own consensus (median) efficacy of
 *  its plausible rows, so a single scrambled number (e.g. 40W paired with the 100W model's lumen)
 *  no longer shows an impossible figure. Rows with believable efficacy are never touched. */
function repairSpecOptions<T extends { power: string; lumen: string }>(options: T[]): T[] {
  const parsed = options.map((option) => {
    const w = Number((option.power.match(/[\d.]+/) ?? [])[0]);
    const lm = Number((option.lumen.replace(/,/g, "").match(/[\d.]+/) ?? [])[0]);
    const eff = Number.isFinite(w) && w > 0 && Number.isFinite(lm) && lm > 0 ? lm / w : NaN;
    return { option, w, eff };
  });
  const plausible = parsed
    .map((p) => p.eff)
    .filter((eff) => Number.isFinite(eff) && eff >= 40 && eff <= 220)
    .sort((a, b) => a - b);
  if (plausible.length < 2) return options; // no reliable consensus -> leave the data untouched
  const consensus = plausible[Math.floor(plausible.length / 2)];
  return parsed.map((p) => {
    if (Number.isFinite(p.w) && p.w > 0 && Number.isFinite(p.eff) && (p.eff > 220 || p.eff < 30)) {
      const unit = /lm/i.test(p.option.lumen) ? "lm" : "";
      return { ...p.option, lumen: `${Math.round(consensus * p.w)}${unit}` };
    }
    return p.option;
  });
}

// The 9 built-in spec columns, in order, with their data field + scope.
const DEFAULT_SPEC_COLUMNS: SpecColumn[] = [
  { id: "col-partnumber", label: "Part Number", unit: "", field: "partNumber", scope: "group" },
  { id: "col-power", label: "Power Selectable", unit: "W", field: "power", scope: "option" },
  { id: "col-voltage", label: "Voltage", unit: "V", field: "voltage", scope: "group" },
  { id: "col-lumen", label: "Lumen Output", unit: "lm", field: "lumen", scope: "option" },
  { id: "col-efficacy", label: "Efficacy", unit: "lm/W", field: "efficacy", scope: "option" },
  { id: "col-cri", label: "CRI", unit: "", field: "cri", scope: "group" },
  { id: "col-cct", label: "CCT", unit: "K", field: "cct", scope: "group" },
  { id: "col-thd", label: "THD", unit: "", field: "thd", scope: "group" },
  { id: "col-distribution", label: "Light Distribution", unit: "", field: "lightDistribution", scope: "group" },
];

/** Resolve the ordered spec columns from the draft. Handles the new format, the OLD positional
 *  {label,unit,hidden}[] format (migrated onto the defaults), and absence (defaults). */
function resolveSpecColumns(columns?: SpecColumn[] | { label: string; unit: string; hidden?: boolean }[]): SpecColumn[] {
  if (!Array.isArray(columns) || columns.length === 0) return DEFAULT_SPEC_COLUMNS;
  if (columns.every((column) => typeof (column as SpecColumn).field === "string")) {
    return columns as SpecColumn[];
  }
  // Legacy positional overrides.
  return DEFAULT_SPEC_COLUMNS.map((base, i) => ({
    ...base,
    label: columns[i]?.label ?? base.label,
    unit: columns[i]?.unit ?? base.unit,
    hidden: columns[i]?.hidden ?? false,
  }));
}

/** The display value for a column in a given variant row (built-in field or a custom column). */
function specColumnValue(
  column: SpecColumn,
  group: SpecGroup,
  option: SpecOption,
  cctDisplay: string,
  optionEfficacy: string,
): string {
  switch (column.field) {
    case "power": return option.power;
    case "lumen": return option.lumen;
    case "efficacy": return optionEfficacy;
    case "voltage": return group.voltage;
    case "cri": return group.cri;
    case "cct": return cctDisplay;
    case "thd": return group.thd;
    case "lightDistribution": return group.lightDistribution;
    case "partNumber": return group.partNumber;
    default: return group.extra?.[column.field] ?? "";
  }
}

function SpecificationsTable({ groups, columns }: { groups: SpecGroup[]; columns?: SpecColumn[] }) {
  const visible = resolveSpecColumns(columns).filter((column) => !column.hidden);
  const last = visible.length - 1;
  const edge = (i: number) => cn(i === 0 && "border-l-0", i === last && "border-r-0");
  const cell = "border border-slate-200 px-1 py-1.5 text-center text-[7px] leading-[1.2] text-black [overflow-wrap:anywhere]";
  return (
    <table className="w-full table-fixed border-collapse" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <colgroup>
        {visible.map((column, i) => (
          <col key={column.id} style={{ width: SPEC_COL_WIDTHS[DEFAULT_SPEC_COLUMNS.findIndex((d) => d.field === column.field)] ?? `${(100 / Math.max(1, visible.length)).toFixed(1)}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {visible.map((column, i) => (
            <th key={column.id} className={cn("border border-[#414042] bg-[#414042] px-1 py-1 text-center align-middle text-[8px] font-bold uppercase leading-[1.1] text-white", edge(i))}>{column.label}</th>
          ))}
        </tr>
        <tr>
          {visible.map((column, i) => (
            <th key={column.id} className={cn("border border-[#d6d6d8] bg-[#eeeeef] px-1 py-1.5 text-center align-middle text-[7px] font-bold leading-none text-black", edge(i))}>{column.unit}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const options = repairSpecOptions(group.options.length > 0 ? group.options : [{ power: "", lumen: "" }]);
          const span = options.length;
          const cctTokens = group.cct.match(/\d[\d.]*\s*K\b/gi);
          const cctDisplay = cctTokens && cctTokens.length > 0
            ? cctTokens.map((token) => token.replace(/\s+/g, "").toUpperCase()).join("-")
            : normalizeText(group.cct);
          return options.map((option, index) => {
            const w = Number((option.power.match(/[\d.]+/) ?? [])[0]);
            const lm = Number((option.lumen.replace(/,/g, "").match(/[\d.]+/) ?? [])[0]);
            const optionEfficacy =
              Number.isFinite(w) && w > 0 && Number.isFinite(lm) && lm > 0 ? `${Math.round(lm / w)} lm/W` : "";
            return (
              <tr key={`${group.id}-${index}`} className="align-middle">
                {visible.map((column, i) => {
                  // group-scoped cells render once with rowSpan (skip on later rows); option cells per row.
                  if (column.scope === "group" && index !== 0) return null;
                  const rowSpan = column.scope === "group" ? span : undefined;
                  if (column.field === "partNumber") {
                    return (
                      <td key={column.id} rowSpan={rowSpan} className={cn(cell, "font-bold", edge(i))}>
                        <div>{group.partNumber}</div>
                        {isSpecified(group.sku) && (
                          <div className="mt-0.5 font-normal text-slate-500">SKU: {group.sku}</div>
                        )}
                      </td>
                    );
                  }
                  return (
                    <td key={column.id} rowSpan={rowSpan} className={cn(cell, edge(i))}>
                      {hyphenateSelectable(specColumnValue(column, group, option, cctDisplay, optionEfficacy))}
                    </td>
                  );
                })}
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

function SheetSpecificationsPage({
  draft,
  pageNumber,
  resolveImage,
  dimensionItems,
  showDimensions,
}: {
  draft: EditorDraft;
  pageNumber: number;
  resolveImage: (id: string | null) => SourceImage | null;
  dimensionItems: DimensionItem[];
  showDimensions: boolean;
}) {
  const groups = draft.specGroups.filter(specGroupHasContent);
  return (
    <SheetPageFrame draft={draft} pageNumber={pageNumber}>
      <div className="flex h-full w-[727px] flex-col overflow-hidden">
        {/* Product Specifications — takes only the height it needs */}
        <section className="shrink-0 overflow-hidden">
          <SheetPageHeading title="Product Specifications" />
          <SpecificationsTable groups={groups} columns={draft.specColumns} />
          {isSpecified(draft.specsNote) && <SheetNote>{draft.specsNote}</SheetNote>}
        </section>

        {/* Dimensions — the first drawings; the rest flow onto continuation pages. Hidden
            here (moved entirely to its own page) when the specs table is too tall. */}
        {showDimensions && (
          <>
            <div className="h-[28px] shrink-0" />
            <section className="min-h-0 flex-1 overflow-hidden pb-3">
              <DimensionsSection items={dimensionItems} resolveImage={resolveImage} imageHeightClass="h-[190px]" />
            </section>
          </>
        )}
      </div>
    </SheetPageFrame>
  );
}

/** Continuation page holding dimension drawings that don't fit under the specs table. */
function SheetDimensionsPage({
  draft,
  pageNumber,
  resolveImage,
  items,
}: {
  draft: EditorDraft;
  pageNumber: number;
  resolveImage: (id: string | null) => SourceImage | null;
  items: DimensionItem[];
}) {
  return (
    <SheetPageFrame draft={draft} pageNumber={pageNumber}>
      <div className="flex h-full w-[727px] flex-col overflow-hidden">
        <DimensionsSection
          items={items}
          resolveImage={resolveImage}
          imageHeightClass="h-[210px]"
          title="Dimensions"
        />
      </div>
    </SheetPageFrame>
  );
}

/** US standard: selectable value lists use "-" not "/" (e.g. "20W/16W/10W" -> "20W-16W-10W",
 *  "3000K/4000K/5000K" -> "3000K-4000K-5000K"). Keeps "lm/W" and "N/A" intact. */
function hyphenateSelectable(text: string) {
  return String(text ?? "")
    .split(/(lm\s*\/\s*w|n\s*\/\s*a)/i)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s*\/\s*/g, "-")))
    .join("");
}

const ORDERING_GROUP_ORDER: OrderingGroupId[] = ["family", "performance", "construction"];

const ORDERING_COL_WIDTHS: Record<string, string> = {
  Brand: "6%",
  "Family/Version": "12%",
  Size: "5%",
  Power: "11%",
  Voltage: "9%",
  Dimming: "9%",
  CCT: "8%",
  Distribution: "11%",
  Driver: "8%",
  Finish: "8%",
  Manufacturer: "13%",
};

/** Options for a column = its entries that have a code. */
function orderingCodeOptions(column: OrderingColumn): OrderingEntry[] {
  return column.entries.filter((entry) => isSpecified(entry.code));
}

/** The chosen code for a column: single-option columns auto-resolve; multi-option
 *  columns stay blank until the user explicitly selects one (no auto-fallback). */
function selectedOrderingCode(column: OrderingColumn, selection: Record<string, string>): string {
  const options = orderingCodeOptions(column);
  if (options.length === 0) return "";
  if (options.length === 1) return options[0].code;
  const chosen = selection[column.id];
  return chosen && options.some((option) => option.code === chosen) ? chosen : "";
}

/** Assemble the full part number from each column's chosen code, in group order. */
function buildOrderingCode(columns: OrderingColumn[], selection: Record<string, string>): string {
  return ORDERING_GROUP_ORDER.flatMap((group) => columns.filter((column) => column.group === group))
    .map((column) => selectedOrderingCode(column, selection))
    .filter(Boolean)
    .join("-");
}

function OrderingDecoderTable({
  columns,
  selection,
  rowRange,
}: {
  columns: OrderingColumn[];
  selection: Record<string, string>;
  // When the decoder is taller than one page it is split into vertical slices: each slice renders
  // only the entries in [rowRange.start, rowRange.end) so a long POWER column CONTINUES onto the next
  // page instead of clipping. Undefined = render every entry (single-page tables).
  rowRange?: { start: number; end: number };
}) {
  const ordered = ORDERING_GROUP_ORDER.flatMap((group) => columns.filter((column) => column.group === group));
  const groupSpans = ORDERING_GROUP_ORDER.map((group) => ({
    group,
    span: columns.filter((column) => column.group === group).length,
  })).filter((entry) => entry.span > 0);

  return (
    <table className="w-full table-fixed border-collapse" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <colgroup>
        {ordered.map((column) => (
          <col
            key={column.id}
            style={{ width: ORDERING_COL_WIDTHS[column.header] ?? `${(100 / Math.max(1, ordered.length)).toFixed(1)}%` }}
          />
        ))}
      </colgroup>
      <thead>
        <tr>
          {groupSpans.map((entry, i, arr) => (
            <th
              key={entry.group}
              colSpan={entry.span}
              className={cn(
                "border border-[#414042] bg-[#414042] px-1 py-1 text-center text-[8px] font-bold uppercase leading-[1.1] text-white",
                i === 0 && "border-l-0",
                i === arr.length - 1 && "border-r-0",
              )}
            >
              {ORDERING_GROUP_LABELS[entry.group]}
            </th>
          ))}
        </tr>
        {/* Selection row (between the group heads and the column heads): single-option
            columns show their auto value; multi-option columns (highlighted) show the
            user's chosen option. */}
        <tr className="align-middle">
          {ordered.map((column, i, arr) => {
            const isMulti = orderingCodeOptions(column).length > 1;
            const code = selectedOrderingCode(column, selection);
            return (
              <td
                key={column.id}
                className={cn(
                  "border border-slate-200 px-1 py-[3px] text-center text-[7.5px] font-bold text-black [overflow-wrap:anywhere]",
                  isMulti ? "bg-[#e2e2e4]" : "bg-[#f6f6f7]",
                  i === 0 && "border-l-0",
                  i === arr.length - 1 && "border-r-0",
                )}
              >
                {hyphenateSelectable(code) || " "}
              </td>
            );
          })}
        </tr>
        <tr>
          {ordered.map((column, i, arr) => (
            <th
              key={column.id}
              className={cn(
                "border border-[#d6d6d8] bg-[#eeeeef] px-1 py-1 text-center align-middle text-[7px] font-bold uppercase leading-[1.1] text-black",
                i === 0 && "border-l-0",
                i === arr.length - 1 && "border-r-0",
              )}
            >
              {column.header}
              {isSpecified(column.unit) ? ` (${column.unit})` : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="align-top">
          {ordered.map((column, i, arr) => (
            <td
              key={column.id}
              className={cn(
                "border border-slate-200 px-1.5 py-3 align-top",
                i === 0 && "border-l-0",
                i === arr.length - 1 && "border-r-0",
              )}
            >
              <div className="flex flex-col gap-3">
                {column.entries
                  .filter((entry) => isSpecified(entry.code) || isSpecified(entry.description))
                  .slice(rowRange?.start ?? 0, rowRange?.end ?? undefined)
                  .map((entry, index) => (
                    <div key={index} className="leading-[1.3]">
                      <div className="text-[7px] font-bold text-black [overflow-wrap:anywhere]">
                        {hyphenateSelectable(entry.code)}
                      </div>
                      {isSpecified(entry.description) && (
                        <div className="text-[6.5px] text-black [overflow-wrap:anywhere]">
                          {hyphenateSelectable(entry.description)}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function AccessoriesTable({ rows, resolveImage }: { rows: AccessoryRow[]; resolveImage: (id: string | null) => SourceImage | null }) {
  return (
    <table className="w-full table-fixed border-collapse" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <colgroup>
        <col style={{ width: "27%" }} />
        <col style={{ width: "39%" }} />
        <col style={{ width: "17%" }} />
        <col style={{ width: "17%" }} />
      </colgroup>
      <thead>
        <tr>
          {["Product Code", "Description", "Image", "Download"].map((label, i, arr) => (
            <th
              key={label}
              className={cn(
                "border border-[#414042] bg-[#414042] px-1 py-1.5 text-center text-[7px] font-bold uppercase leading-[1.1] text-white",
                i === 0 && "border-l-0",
                i === arr.length - 1 && "border-r-0",
              )}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const image = resolveImage(row.imageId);
          return (
            <tr key={row.id} className="align-middle">
              <td className="whitespace-nowrap border border-l-0 border-slate-200 px-1.5 py-2.5 text-[7px] font-bold leading-[1.15] text-black">
                {row.code}
              </td>
              <td className="border border-slate-200 px-1.5 py-2.5 text-[7px] leading-[1.2] text-black">
                {row.description}
              </td>
              <td className="border border-slate-200 px-1.5 py-2.5">
                <div className="flex h-[34px] items-center justify-center overflow-hidden">
                  {image ? (
                    <SheetImage
                      image={image}
                      alt={row.code}
                      className="flex h-full w-full items-center justify-center"
                      imgClassName="h-full w-full object-contain"
                    />
                  ) : (
                    <FileImage className="h-5 w-5 text-slate-300" />
                  )}
                </div>
              </td>
              <td className="border border-r-0 border-slate-200 px-1.5 py-2.5 text-center text-[7px]">
                {isSpecified(row.downloadUrl) ? (
                  <a href={row.downloadUrl} className="font-semibold text-[#00a651] underline">
                    Download
                  </a>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SheetOrderingPage({
  draft,
  pageNumber,
  resolveImage,
}: {
  draft: EditorDraft;
  pageNumber: number;
  resolveImage: (id: string | null) => SourceImage | null;
}) {
  const accessories = draft.accessoryRows.filter(accessoryRowHasContent);
  const half = Math.max(1, Math.ceil(accessories.length / 2));
  const leftAccessories = accessories.slice(0, half);
  const rightAccessories = accessories.slice(half);

  return (
    <SheetPageFrame draft={draft} pageNumber={pageNumber}>
      <div className="flex h-full w-[727px] flex-col overflow-hidden">
        <section className="mb-5">
          <SheetPageHeading
            title="Product Ordering Information"
            trailing={isSpecified(draft.orderingExample) ? `Typical order example: ${draft.orderingExample}` : undefined}
          />
          <OrderingDecoderTable columns={draft.orderingColumns} selection={draft.orderingSelection} />
          {isSpecified(draft.orderingNote) && <SheetNote>{draft.orderingNote}</SheetNote>}
        </section>

        <section>
          <SheetPageHeading title="Accessories Ordering Information" />
          <div className="flex gap-4">
            <div className="flex-1">
              <AccessoriesTable rows={leftAccessories} resolveImage={resolveImage} />
            </div>
            <div className="flex-1">
              <AccessoriesTable rows={rightAccessories} resolveImage={resolveImage} />
            </div>
          </div>
        </section>
      </div>
    </SheetPageFrame>
  );
}

// Page 2 shows the specs table plus the first couple of drawings; the rest flow onto
// dedicated continuation pages so nothing is clipped.
const DIMS_ON_SPEC_PAGE = 2;
const DIMS_PER_CONTINUATION_PAGE = 4;

function getDimensionPagination(draft: EditorDraft) {
  const dims = draft.dimensionItems.filter(dimensionItemHasContent);
  // Estimate the specs-table height (in rows). A tall table leaves no room under it,
  // so push ALL drawings to their own continuation page instead of cramming them.
  const specRows = draft.specGroups
    .filter(specGroupHasContent)
    .reduce((sum, group) => sum + Math.max(1, group.options.length), 0);
  const roomOnSpecPage = specRows <= 16 ? DIMS_ON_SPEC_PAGE : 0;

  const onSpecPage = dims.slice(0, roomOnSpecPage);
  const overflow = dims.slice(roomOnSpecPage);
  const continuationPages: DimensionItem[][] = [];
  for (let i = 0; i < overflow.length; i += DIMS_PER_CONTINUATION_PAGE) {
    continuationPages.push(overflow.slice(i, i + DIMS_PER_CONTINUATION_PAGE));
  }
  // Show the Dimensions section on page 2 only when there's room, or when there are no
  // drawings at all (so the empty placeholder layout still appears). If a tall specs table
  // pushed every drawing to its own page, keep page 2 to just the specs table.
  const showOnSpecPage = dims.length === 0 || roomOnSpecPage > 0;
  return { onSpecPage, continuationPages, showOnSpecPage };
}

function DimensionsSection({
  items: providedItems,
  resolveImage,
  imageHeightClass,
  title = "Dimensions",
  showHeading = true,
}: {
  items: DimensionItem[];
  resolveImage: (id: string | null) => SourceImage | null;
  imageHeightClass: string;
  title?: string;
  showHeading?: boolean;
}) {
  // Show placeholder slots so the fixed layout is visible before any drawing is added.
  const items =
    providedItems.length > 0
      ? providedItems
      : [
          { id: "dim-placeholder-0", label: "", imageId: null, width: "", height: "", depth: "" },
          { id: "dim-placeholder-1", label: "", imageId: null, width: "", height: "", depth: "" },
        ];
  // A single dimension is centered on the page; two or more use the paired grid.
  const single = items.length === 1;
  return (
    <>
      {showHeading && <SheetPageHeading title={title} />}
      <div className={cn("grid gap-x-8 gap-y-4", single ? "grid-cols-1" : "grid-cols-2")}>
        {items.map((item) => {
          const image = resolveImage(item.imageId);
          const dims = [
            item.width && `W ${item.width}`,
            item.height && `H ${item.height}`,
            item.depth && `D ${item.depth}`,
          ].filter(Boolean);
          return (
            // Single dimension now uses the full page width so Fit Left/Right can span the page (the
            // drawing stays centred by default via object-position); 2+ use the paired grid.
            <div key={item.id} className={cn("flex w-full flex-col items-center")}>
              {isSpecified(item.label) && (
                <div className="mb-1 text-[10px] font-bold text-black">
                  {(() => {
                    const colon = item.label.indexOf(":");
                    if (colon < 0) return <span className="text-[#00a651]">{item.label}</span>;
                    // Size prefix (e.g. "4'") green; the code/description after the colon black.
                    return (
                      <>
                        <span className="text-[#00a651]">{item.label.slice(0, colon)}</span>
                        {item.label.slice(colon)}
                      </>
                    );
                  })()}
                </div>
              )}
              <div className={cn("flex w-full items-center justify-center overflow-hidden bg-white", imageHeightClass)}>
                {image ? (
                  <SheetImage
                    image={image}
                    alt={item.label}
                    className="flex h-full w-full items-center justify-center"
                    imgClassName="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-1 text-slate-400">
                    <FileImage className="h-8 w-8" />
                    <p className="text-[9px]">Dimension drawing</p>
                  </div>
                )}
              </div>
              {dims.length > 0 && (
                <div className="mt-1 text-[9px] font-semibold text-black">{dims.join("  ×  ")}</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** True when there is at least one custom section with a heading, text, or image. */
function hasCustomSectionContent(draft: EditorDraft) {
  return draft.customSections.some(
    (section) => isSpecified(section.heading) || isSpecified(section.bodyText) || Boolean(section.imageId),
  );
}

/** Extra page(s) for user-added custom sections: each heading with text points and/or an image. */
function SheetCustomSectionsPage({
  draft,
  pageNumber,
  resolveImage,
}: {
  draft: EditorDraft;
  pageNumber: number;
  resolveImage: (id: string | null) => SourceImage | null;
}) {
  const sections = draft.customSections.filter(
    (section) => isSpecified(section.heading) || isSpecified(section.bodyText) || Boolean(section.imageId),
  );
  return (
    <SheetPageFrame draft={draft} pageNumber={pageNumber}>
      <div className="flex h-full w-[727px] flex-col gap-5 overflow-hidden">
        {sections.map((section) => {
          const image = resolveImage(section.imageId);
          const points = splitLineList(section.bodyText);
          return (
            <section key={section.id} className="overflow-hidden">
              {isSpecified(section.heading) && <SheetSectionTitle>{section.heading}</SheetSectionTitle>}
              <div className="flex gap-5">
                {points.length > 0 && (
                  <ul className="flex-1 space-y-1.5 text-[11px] leading-[1.35] text-black">
                    {points.map((point, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[#00a651]" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {image && (
                  <div className={cn("flex shrink-0 items-start justify-center", points.length > 0 ? "w-[300px]" : "w-full")}>
                    <SheetImage
                      image={image}
                      alt={section.heading || "Custom section image"}
                      className="flex w-full items-start justify-center"
                      imgClassName="max-h-[340px] w-full object-contain"
                    />
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </SheetPageFrame>
  );
}

// ---------------------------------------------------------------------------
// Page packing. After the fixed page 1, every remaining section (specs, dimensions,
// ordering, accessories, custom) flows into as FEW pages as possible: each section is
// estimated in pixels and greedily packed into the usable content height, so a short
// specs table pulls the ordering / accessories up beside it instead of leaving page 2
// half-empty. Estimates are biased slightly high so nothing overflows a page.
// ---------------------------------------------------------------------------
const PAGE_CONTENT_BUDGET = 812; // usable px per page 2+ (844 content area minus pt-3 + safety)
const SHEET_BLOCK_GAP = 20; // gap-5 between stacked blocks
const DIM_ROW_HEIGHT = 250; // one row of up to two dimension drawings (h-[190px] image + labels)
const SINGLE_DIM_HEIGHT = 360; // tall slot for a lone dimension (matches imageHeightClass h-[360px])
const ORDERING_ENTRIES_PER_PAGE = 28; // decoder entries (tallest column) that fit one page under the heading + header

// `group` lets the packer keep multi-block sections (e.g. Dimensions rows) in order and contiguous
// while still back-filling standalone sections into earlier gaps. Sections listed in SEQUENCE_GROUPS
// act as a barrier: nothing after them is pulled up until every one of their blocks is placed.
type SheetBlock = { key: string; group: string; height: number; node: React.ReactNode };

const SEQUENCE_GROUPS = new Set(["specs", "dims", "ordering"]);

function estimateSpecsHeight(draft: EditorDraft) {
  const rows = draft.specGroups
    .filter(specGroupHasContent)
    .reduce((sum, group) => sum + Math.max(1, group.options.length), 0);
  const note = isSpecified(draft.specsNote) ? 30 : 0;
  return 46 + 40 + Math.max(1, rows) * 23 + note;
}

function estimateAccessoriesHeight(draft: EditorDraft) {
  const count = draft.accessoryRows.filter(accessoryRowHasContent).length;
  if (count === 0) return 0;
  return 46 + 26 + Math.ceil(count / 2) * 54;
}

function estimateCustomSectionHeight(section: CustomSection, hasImage: boolean) {
  const points = splitLineList(section.bodyText).length;
  const bodyHeight = Math.max(points * 20, hasImage ? 350 : 0, 20);
  return 40 + bodyHeight + 16;
}

/** Render an extra vendor table (photometric/performance/etc.) in the IKIO spec-table style. */
function ExtraTableView({ table }: { table: ExtraTable }) {
  const colCount = Math.max(1, table.headers.length);
  return (
    <div className="overflow-hidden">
      <table className="w-full table-fixed border-collapse" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
        <colgroup>
          {table.headers.map((_, index) => (
            <col key={index} style={{ width: `${100 / colCount}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {table.headers.map((header, i, arr) => (
              <th
                key={i}
                className={cn(
                  "border border-[#414042] bg-[#414042] px-1 py-1 text-center align-middle text-[8px] font-bold uppercase leading-[1.1] text-white",
                  i === 0 && "border-l-0",
                  i === arr.length - 1 && "border-r-0",
                )}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="align-middle">
              {table.headers.map((_, ci, arr) => (
                <td
                  key={ci}
                  className={cn(
                    "border border-slate-200 px-1 py-1.5 text-center text-[7px] leading-[1.2] text-black [overflow-wrap:anywhere]",
                    ci === 0 && "border-l-0",
                    ci === arr.length - 1 && "border-r-0",
                  )}
                >
                  {hyphenateSelectable(row[ci] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Build the ordered, height-estimated section blocks that follow page 1. */
function buildSheetBlocks(
  draft: EditorDraft,
  resolveImage: (id: string | null) => SourceImage | null,
): SheetBlock[] {
  const blocks: SheetBlock[] = [];

  // Product Specifications — split into page-sized chunks so a long variant table CONTINUES onto
  // the next page(s) instead of overflowing/clipping. Each chunk repeats the table header; only the
  // first shows the "Product Specifications" heading (the rest say "… (cont.)"), and the note follows
  // the last chunk. Chunks share the "specs" sequence group so they stay contiguous and in order.
  const groups = draft.specGroups.filter(specGroupHasContent);
  const SPEC_ROWS_PER_PAGE = 28; // spec rows that comfortably fit one page under the heading + header
  const specChunks: SpecGroup[][] = [];
  {
    let current: SpecGroup[] = [];
    let currentRows = 0;
    for (const group of groups) {
      const groupRows = Math.max(1, group.options.length);
      if (current.length > 0 && currentRows + groupRows > SPEC_ROWS_PER_PAGE) {
        specChunks.push(current);
        current = [];
        currentRows = 0;
      }
      current.push(group);
      currentRows += groupRows;
    }
    if (current.length > 0 || specChunks.length === 0) specChunks.push(current);
  }
  if (!isSectionHidden(draft, "specs")) specChunks.forEach((chunk, chunkIndex) => {
    const first = chunkIndex === 0;
    const last = chunkIndex === specChunks.length - 1;
    const rows = chunk.reduce((sum, group) => sum + Math.max(1, group.options.length), 0);
    const showNote = last && isSpecified(draft.specsNote);
    blocks.push({
      key: `specs-${chunkIndex}`,
      group: "specs",
      height: (first ? 46 : 24) + 40 + Math.max(1, rows) * 23 + (showNote ? 30 : 0),
      node: (
        <section>
          <SheetPageHeading title={first ? "Product Specifications" : "Product Specifications (cont.)"} />
          <SpecificationsTable groups={chunk} columns={draft.specColumns} />
          {showNote && <SheetNote>{draft.specsNote}</SheetNote>}
        </section>
      ),
    });
  });

  // Product Ordering Information — placed above Dimensions. The decoder's tallest column (usually
  // POWER) can list dozens of options; when that exceeds one page the table is sliced into vertical
  // chunks that CONTINUE onto the next page(s) instead of clipping. Headers repeat on every chunk;
  // only the first shows the "Product Ordering Information" heading (the rest say "… (cont.)") and the
  // note follows the last chunk. Chunks share the "ordering" sequence group so they stay contiguous.
  const orderingMaxEntries = draft.orderingColumns.reduce((max, column) => {
    const count = column.entries.filter((entry) => isSpecified(entry.code) || isSpecified(entry.description)).length;
    return Math.max(max, count);
  }, 0);
  const orderingChunkCount = Math.max(1, Math.ceil(orderingMaxEntries / ORDERING_ENTRIES_PER_PAGE));
  if (!isSectionHidden(draft, "ordering")) for (let chunkIndex = 0; chunkIndex < orderingChunkCount; chunkIndex += 1) {
    const first = chunkIndex === 0;
    const last = chunkIndex === orderingChunkCount - 1;
    const start = chunkIndex * ORDERING_ENTRIES_PER_PAGE;
    const end = start + ORDERING_ENTRIES_PER_PAGE;
    const chunkRows = Math.min(ORDERING_ENTRIES_PER_PAGE, Math.max(1, orderingMaxEntries - start));
    const showNote = last && isSpecified(draft.orderingNote);
    blocks.push({
      key: `ordering-${chunkIndex}`,
      group: "ordering",
      height: (first ? 46 : 24) + 66 + (26 + chunkRows * 22) + (showNote ? 30 : 0),
      node: (
        <section>
          <SheetPageHeading
            title={first ? "Product Ordering Information" : "Product Ordering Information (cont.)"}
            trailing={first && isSpecified(draft.orderingExample) ? `Typical order example: ${draft.orderingExample}` : undefined}
          />
          <OrderingDecoderTable
            columns={draft.orderingColumns}
            selection={draft.orderingSelection}
            rowRange={orderingChunkCount > 1 ? { start, end } : undefined}
          />
          {showNote && <SheetNote>{draft.orderingNote}</SheetNote>}
        </section>
      ),
    });
  }

  // Dimensions — one block per row of (up to) two drawings; only the first shows the heading.
  const dims = isSectionHidden(draft, "dims") ? [] : draft.dimensionItems.filter(dimensionItemHasContent);
  if (isSectionHidden(draft, "dims")) {
    // Section removed by the user — emit nothing (no empty-dimensions placeholder either).
  } else if (dims.length === 0) {
    blocks.push({
      key: "dims-empty",
      group: "dims",
      height: 46 + DIM_ROW_HEIGHT,
      node: <DimensionsSection items={[]} resolveImage={resolveImage} imageHeightClass="h-[190px]" />,
    });
  } else if (dims.length === 1) {
    // A lone dimension gets a tall, full-width slot so the drawing has room to be enlarged (corner
    // handle) and pushed to the top/bottom of its box without being clipped by a short frame.
    blocks.push({
      key: "dims-0",
      group: "dims",
      height: 46 + SINGLE_DIM_HEIGHT + 24,
      node: (
        <DimensionsSection
          items={dims}
          resolveImage={resolveImage}
          imageHeightClass="h-[360px]"
          showHeading
        />
      ),
    });
  } else {
    for (let i = 0; i < dims.length; i += 2) {
      const first = i === 0;
      blocks.push({
        key: `dims-${i}`,
        group: "dims",
        height: (first ? 46 : 0) + DIM_ROW_HEIGHT,
        node: (
          <DimensionsSection
            items={dims.slice(i, i + 2)}
            resolveImage={resolveImage}
            imageHeightClass="h-[190px]"
            showHeading={first}
          />
        ),
      });
    }
  }

  // Accessories Ordering Information
  const accessories = isSectionHidden(draft, "accessories") ? [] : draft.accessoryRows.filter(accessoryRowHasContent);
  if (accessories.length > 0) {
    const half = Math.max(1, Math.ceil(accessories.length / 2));
    blocks.push({
      key: "accessories",
      group: "accessories",
      height: estimateAccessoriesHeight(draft),
      node: (
        <section>
          <SheetPageHeading title="Accessories Ordering Information" />
          <div className="flex gap-4">
            <div className="flex-1">
              <AccessoriesTable rows={accessories.slice(0, half)} resolveImage={resolveImage} />
            </div>
            <div className="flex-1">
              <AccessoriesTable rows={accessories.slice(half)} resolveImage={resolveImage} />
            </div>
          </div>
        </section>
      ),
    });
  }

  // Custom sections — each user-added heading with text points and/or image.
  for (const section of draft.customSections) {
    if (!isSpecified(section.heading) && !isSpecified(section.bodyText) && !section.imageId) continue;
    const image = resolveImage(section.imageId);
    const points = splitLineList(section.bodyText);
    blocks.push({
      key: `custom-${section.id}`,
      group: "custom",
      height: estimateCustomSectionHeight(section, Boolean(image)),
      node: (
        <section>
          {isSpecified(section.heading) && <SheetSectionTitle>{section.heading}</SheetSectionTitle>}
          <div className="flex gap-5">
            {points.length > 0 && (
              <ul className="flex-1 space-y-1.5 text-[11px] leading-[1.35] text-black">
                {points.map((point, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[#00a651]" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            )}
            {image && (
              <div className={cn("flex shrink-0 items-start justify-center", points.length > 0 ? "w-[300px]" : "w-full")}>
                <SheetImage
                  image={image}
                  alt={section.heading || "Custom section image"}
                  className="flex w-full items-start justify-center"
                  imgClassName="max-h-[340px] w-full object-contain"
                />
              </div>
            )}
          </div>
        </section>
      ),
    });
  }

  // Extra vendor tables (photometric/performance/etc.) — shown LAST, in the IKIO table style.
  for (const table of draft.extraTables ?? []) {
    if (table.headers.length === 0 || table.rows.length === 0) continue;
    blocks.push({
      key: `extratable-${table.id}`,
      group: "custom",
      height: 54 + (table.rows.length + 1) * 22 + 24,
      node: (
        <section>
          <SheetPageHeading title={table.title || "Additional Data"} />
          <ExtraTableView table={table} />
        </section>
      ),
    });
  }

  return blocks;
}

/**
 * Pack estimated-height blocks into as few pages of PAGE_CONTENT_BUDGET as possible, filling each
 * page top-to-bottom. Unlike a strict in-order fill, when the next section doesn't fit the current
 * page this back-fills a LATER standalone section into the gap (order-preferring: it always tries
 * the earliest fitting block first). Multi-block sequence groups (Dimensions rows) stay in order and
 * are never interleaved — nothing after them is pulled up until all their blocks are placed — so the
 * result is consolidated, not scattered, without breaking any section.
 */
function packSheetBlocks(blocks: SheetBlock[]): SheetBlock[][] {
  const placed = new Array(blocks.length).fill(false);

  // A block may go on the current page only if no earlier block is still pending that either shares
  // its group (keep same-section order) or is a sequence group acting as a barrier (keep flow order).
  const isEligible = (i: number) => {
    if (placed[i]) return false;
    for (let j = 0; j < i; j += 1) {
      if (placed[j]) continue;
      if (blocks[j].group === blocks[i].group) return false;
      if (SEQUENCE_GROUPS.has(blocks[j].group)) return false;
    }
    return true;
  };

  const pages: SheetBlock[][] = [];
  while (placed.some((done) => !done)) {
    const page: SheetBlock[] = [];
    let used = 0;

    // Keep adding the earliest eligible block that still fits, restarting the scan each time so the
    // natural section order is preferred and later sections only fill genuine leftover space.
    let addedThisPage = true;
    while (addedThisPage) {
      addedThisPage = false;
      for (let i = 0; i < blocks.length; i += 1) {
        if (!isEligible(i)) continue;
        const addition = (page.length > 0 ? SHEET_BLOCK_GAP : 0) + blocks[i].height;
        if (used + addition <= PAGE_CONTENT_BUDGET) {
          page.push(blocks[i]);
          placed[i] = true;
          used += addition;
          addedThisPage = true;
          break;
        }
      }
    }

    // Nothing fit an empty page: a single block is taller than the budget — place it alone so we
    // always make progress (respecting group order).
    if (page.length === 0) {
      for (let i = 0; i < blocks.length; i += 1) {
        if (isEligible(i)) {
          page.push(blocks[i]);
          placed[i] = true;
          break;
        }
      }
    }

    pages.push(page);
  }

  return pages.length > 0 ? pages : [[]];
}

function SheetPreview({
  draft,
  selectedImage,
  spec,
  variantSelected,
  onImagePlacementChange,
}: {
  draft: EditorDraft;
  selectedImage: SourceImage | null;
  spec: ExtendedExtractedSpec;
  variantSelected?: boolean;
  onImagePlacementChange?: (imageId: string, placement: ImagePlacement) => void;
}) {
  const sourceImages = getDraftSourceImages(spec, draft);
  const resolveImage = (id: string | null) =>
    (id ? sourceImages.find((image) => image.id === id) : null) ?? null;

  const pages = packSheetBlocks(buildSheetBlocks(draft, resolveImage));

  // One provider covers every image on every page/section, so `<SheetImage>` anywhere in the tree
  // gets drag/resize without threading callbacks through each render helper.
  const imageEditing: SheetImageEditing = {
    placements: draft.imagePlacements ?? {},
    editable: Boolean(onImagePlacementChange),
    onChange: onImagePlacementChange,
  };

  return (
    <SheetImageEditingContext.Provider value={imageEditing}>
      <div className="flex flex-col items-center gap-8">
        <SheetPageOne draft={draft} selectedImage={selectedImage} spec={spec} variantSelected={variantSelected} />
        {pages.map((page, index) => (
          <SheetPageFrame key={`page-${index}`} draft={draft} pageNumber={2 + index}>
            <div className="flex w-[727px] flex-col gap-5">
              {page.map((block) => (
                <div key={block.key}>{block.node}</div>
              ))}
            </div>
          </SheetPageFrame>
        ))}
      </div>
    </SheetImageEditingContext.Provider>
  );
}

/** Total rendered pages: page 1 + the packed section pages. */
function getPreviewPageCount(draft: EditorDraft, spec?: ExtendedExtractedSpec) {
  const sourceImages = spec ? getDraftSourceImages(spec, draft) : [];
  const resolveImage = (id: string | null) =>
    (id ? sourceImages.find((image) => image.id === id) : null) ?? null;
  return 1 + packSheetBlocks(buildSheetBlocks(draft, resolveImage)).length;
}

function SecondPageImagePicker({
  images,
  value,
  onChange,
}: {
  images: SourceImage[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-10 w-full rounded-xl border border-border/70 bg-background px-3 text-sm text-foreground"
    >
      <option value="">No image</option>
      {images.map((image, index) => (
        <option key={image.id} value={image.id}>
          Image {index + 1} · {image.page > 0 ? `Page ${image.page}` : "Uploaded"}
        </option>
      ))}
    </select>
  );
}

const DEFAULT_DESCRIPTION_PROMPT =
  "One concise paragraph (400-450 characters) covering what the product is, where it is used, its main performance or design advantage, and its broader project value. Do NOT restate specific numeric spec values that already appear on the sheet (power, lumens, CCT, voltage, current, efficacy, CRI, IP/IK, lifespan, warranty) — keep it qualitative and benefit-focused. Use US terminology: say 'power', never 'wattage'.";
const DEFAULT_FEATURES_PROMPT =
  "Write 4 benefit-oriented feature bullets (~100 characters each) grounded in the product's real specs. Do NOT restate spec numbers already shown on the sheet (power, lumens, CCT, voltage, efficacy, CRI, IP/IK) — describe what each feature does for the user, not the raw values. Use US terminology: say 'power', never 'wattage'.";

/** Inline AI helper with an editable prompt + Generate button for a copy field. */
function AiCopyAssistant({
  label,
  prompt,
  onPromptChange,
  busy,
  onGenerate,
}: {
  label: string;
  prompt: string;
  onPromptChange: (value: string) => void;
  busy: boolean;
  onGenerate: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-primary"
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI rewrite {label} {open ? "▾" : "▸"}
        </button>
        <Button type="button" disabled={busy} onClick={onGenerate} className="h-7 gap-1 px-3 text-[11px]">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          {busy ? "Generating…" : "Generate"}
        </Button>
      </div>
      {open && (
        <Textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="Tell the AI how to write it…"
          className="mt-2 min-h-[64px] text-[12px]"
        />
      )}
    </div>
  );
}

// ---- Final QA reviewer (deterministic, no model): flags what a human should verify and what to
// add, checked against the vendor PDF text + IKIO's standard overview heads. Re-runs on every edit.
type ReviewItem = { label: string; detail: string; severity?: "high" | "med" };

function buildReviewReport(draft: EditorDraft, spec: ExtendedExtractedSpec) {
  const source = spec.sourceText ?? "";
  const verify: ReviewItem[] = [];
  const suggest: ReviewItem[] = [];

  const includedRows = draft.overviewRows.filter((row) => row.included !== false && isSpecified(row.value));

  // 1) Values shown on the sheet that aren't supported by the vendor PDF → verify.
  if (isSpecified(source)) {
    for (const row of includedRows) {
      const grounded = groundValue(row.value, source);
      if (grounded.level === "none") {
        verify.push({ label: row.label, detail: `“${row.value}” isn’t found in the vendor PDF — confirm or correct it.`, severity: "high" });
      } else if (grounded.level === "low") {
        verify.push({ label: row.label, detail: `“${row.value}” only partly matches the PDF — double-check.`, severity: "med" });
      }
    }
  }

  // 2) Power ↔ Lumen must pair 1:1 per variant.
  for (const variant of buildPreviewVariantRows(spec)) {
    const powerCount = (String(variant.power).match(/\d+(?:\.\d+)?\s*w\b/gi) ?? []).length;
    const lumenCount = (String(variant.lumens).match(/\d[\d,]*(?:\.\d+)?\s*lm\b/gi) ?? []).length;
    if (powerCount > 1 && lumenCount > 1 && powerCount !== lumenCount) {
      verify.push({
        label: "Power / Lumen",
        detail: `${isSpecified(variant.fixture) ? `${variant.fixture}: ` : ""}${powerCount} wattages vs ${lumenCount} lumen values — they should pair 1:1.`,
        severity: "high",
      });
    }
  }

  // 2b) Efficacy cross-check: every computed efficacy must be physically possible (real LEDs are
  // ~40-220 lm/W) AND not wildly above the vendor's own stated figure. An impossible value means the
  // Power↔Lumen pairing is misaligned in the extraction — flag it so the user re-checks that variant.
  {
    const wattages = extractNumericValues(getOverviewValue(spec, ["Wattage", "Power"]), /(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b/gi);
    const lumens = extractNumericValues(getOverviewValue(spec, ["Lumen Output", "Lumens"]), /(\d[\d,]*(?:\.\d+)?)\s*lm\b/gi);
    const pairs = Math.min(wattages.length, lumens.length);
    const effs = Array.from({ length: pairs }, (_, i) => (wattages[i] > 0 ? lumens[i] / wattages[i] : NaN)).filter((v) => Number.isFinite(v));
    const impossible = effs.filter((v) => v > 220 || v < 30);
    if (impossible.length > 0) {
      verify.push({
        label: "Efficacy",
        detail: `Computed ${Math.round(Math.max(...impossible))} lm/W is physically impossible — the Power↔Lumen pairing is misaligned. Verify each variant's wattages line up 1:1 with its lumens in the vendor table.`,
        severity: "high",
      });
    }
    const stated = (source.match(/(\d{2,3})\s*lm\s*\/\s*w/gi) ?? []).map((token) => Number((token.match(/\d+/) ?? ["0"])[0]));
    if (stated.length > 0 && effs.length > 0) {
      const maxComputed = Math.max(...effs);
      const maxStated = Math.max(...stated);
      if (maxStated > 0 && maxComputed > maxStated * 1.15) {
        verify.push({
          label: "Efficacy",
          detail: `Sheet computes up to ${Math.round(maxComputed)} lm/W but the vendor states up to ${maxStated} lm/W — re-check the lumen values against the PDF.`,
          severity: "med",
        });
      }
    }
  }

  // 3) Standard IKIO overview heads for this category that aren't filled → suggest.
  const template = getOverviewTemplateRows(spec);
  const filledKeys = new Set(includedRows.map((row) => normalizeSpecKey(row.label)));
  const optionalKeys = new Set(
    draft.overviewRows.filter((row) => row.included === false && isSpecified(row.value)).map((row) => normalizeSpecKey(row.label)),
  );
  const templateHeads = template.map((templateRow) => {
    const key = normalizeSpecKey(templateRow.label);
    return { label: templateRow.label, key, filled: filledKeys.has(key), optional: optionalKeys.has(key) };
  });
  for (const head of templateHeads) {
    if (head.filled) continue;
    suggest.push({
      label: head.label,
      detail: head.optional
        ? "sitting in Optional fields — Include it if it belongs on the sheet."
        : "standard head is empty — fill it if the vendor states a value.",
    });
  }

  // 4) Section completeness.
  if (!isSpecified(draft.description)) suggest.push({ label: "Product Description", detail: "empty — add a short benefit-led paragraph." });
  const featureCount = splitLineList(draft.featuresText).filter(isSpecified).length;
  if (featureCount < 4) suggest.push({ label: "Features", detail: `${featureCount} of 4 — add ${Math.max(0, 4 - featureCount)} more benefit bullet(s).` });
  if (draft.accessoryRows.filter(accessoryRowHasContent).length === 0) suggest.push({ label: "Accessories", detail: "none captured — check the vendor’s options / mounting section." });
  if (draft.dimensionItems.filter(dimensionItemHasContent).length === 0) suggest.push({ label: "Dimensions", detail: "no sizes/drawings — add them." });
  if (!isSpecified(draft.applicationAreasText)) suggest.push({ label: "Application Areas", detail: "empty — add where the fixture is used." });

  const filledHeads = templateHeads.filter((head) => head.filled).length;
  const score = Math.round((filledHeads / Math.max(1, templateHeads.length)) * 100);

  verify.sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));
  return { verify, suggest, score, templateHeads };
}

function ReviewPanel({ draft, spec }: { draft: EditorDraft; spec: ExtendedExtractedSpec }) {
  const [open, setOpen] = useState(true);
  const report = buildReviewReport(draft, spec);
  const scoreColor = report.score >= 80 ? "text-emerald-600" : report.score >= 50 ? "text-amber-600" : "text-rose-600";

  // Remember which standard heads were ever flagged empty for THIS sheet, so once the user fills one
  // we can confirm it with a green "✓ added" instead of the line silently disappearing.
  const everEmptyRef = useRef<{ specId: string; keys: Set<string> }>({ specId: "", keys: new Set() });
  if (everEmptyRef.current.specId !== String(spec.id)) {
    everEmptyRef.current = { specId: String(spec.id), keys: new Set() };
  }
  report.templateHeads.forEach((head) => {
    if (!head.filled) everEmptyRef.current.keys.add(head.key);
  });
  const resolved = report.templateHeads.filter((head) => head.filled && everEmptyRef.current.keys.has(head.key));
  return (
    <section className="space-y-2 rounded-2xl border border-amber-200/70 bg-amber-50/30 p-3">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          <ClipboardCheck className="h-4 w-4 text-amber-600" /> Review &amp; Verify
        </span>
        <span className="flex items-center gap-2 text-[11px]">
          <span className={cn("font-bold", scoreColor)}>{report.score}% ready</span>
          {report.verify.length > 0 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">{report.verify.length} to verify</span>
          )}
          <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-3">
          {report.verify.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-rose-700">
                <AlertTriangle className="h-3.5 w-3.5" /> Verify first
              </div>
              <ul className="space-y-1">
                {report.verify.map((item, index) => (
                  <li key={`v-${index}`} className="flex gap-2 text-[11px] leading-snug">
                    <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", item.severity === "high" ? "bg-rose-500" : "bg-amber-500")} />
                    <span><span className="font-semibold text-foreground">{item.label}:</span> <span className="text-muted-foreground">{item.detail}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.suggest.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Consider adding / filling
              </div>
              <ul className="space-y-1">
                {report.suggest.map((item, index) => (
                  <li key={`s-${index}`} className="flex gap-2 text-[11px] leading-snug">
                    <Plus className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
                    <span><span className="font-semibold text-foreground">{item.label}:</span> <span className="text-muted-foreground">{item.detail}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {resolved.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                <ClipboardCheck className="h-3.5 w-3.5" /> Added by you
              </div>
              <div className="flex flex-wrap gap-1.5">
                {resolved.map((head) => (
                  <span key={head.key} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    <Check className="h-3 w-3" /> {head.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {report.verify.length === 0 && report.suggest.length === 0 && (
            <div className="text-[11px] font-medium text-emerald-600">Looks complete and grounded — no flags.</div>
          )}
          <div className="text-[10px] leading-snug text-muted-foreground/70">
            Auto-checked against the vendor PDF and IKIO&apos;s standard heads. Updates live as you edit.
          </div>
        </div>
      )}
    </section>
  );
}

export function SpecSheetEditor({ spec }: { spec: ExtendedExtractedSpec }) {
  const [productNameRecommendations, setProductNameRecommendations] = useState<string[]>(() => buildProductNameRecommendations(spec));
  const [draft, setDraft] = useState<EditorDraft>(() => buildEditorDraft(spec, buildProductNameRecommendations(spec)));
  const [draggedOverviewIndex, setDraggedOverviewIndex] = useState<number | null>(null);
  const [overviewDropIndex, setOverviewDropIndex] = useState<number | null>(null);
  const [isImageEditorOpen, setIsImageEditorOpen] = useState(false);
  const [editingImageId, setEditingImageId] = useState<string | null>(null);
  // Whether the current edit should also become the page-1 product image (true for the
  // product image, false when editing a dimension/accessory drawing).
  const [editingImageSetsSelection, setEditingImageSetsSelection] = useState(true);
  const [isCropDialogOpen, setIsCropDialogOpen] = useState(false);
  const [croppingPageId, setCroppingPageId] = useState<string | null>(null);
  const [pendingImageTarget, setPendingImageTarget] = useState<
    { kind: "dimension" | "accessory" | "custom"; id: string } | null
  >(null);
  // Vendor-image suggestion picker: which section is choosing a vendor library image (null = closed).
  const [vendorImagePicker, setVendorImagePicker] = useState<
    { kind: "product" | "accessory" | "dimension" | "custom"; id: string } | null
  >(null);
  const [learningVendor, setLearningVendor] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  // Variant sheet: the chosen power(s) the generated sheet is for (null = all powers / full draft).
  const variantGroups = enumerateVariantGroups(spec);
  const totalVariantOptions = variantGroups.reduce((count, group) => count + group.options.length, 0);
  const hasVariantChoice = totalVariantOptions > 1;
  const [sheetVariant, setSheetVariant] = useState<{ label: string; group: VariantGroup; options: VariantOption[] } | null>(null);
  const [variantDialogOpen, setVariantDialogOpen] = useState(false);
  const [pendingPdfKind, setPendingPdfKind] = useState<null | "download" | "editable">(null);
  const [pendingPdfRun, setPendingPdfRun] = useState<null | "download" | "editable">(null);
  // Per-option checkbox state for the multi-select (selectable) groups in the variant dialog.
  const [variantChecks, setVariantChecks] = useState<Record<string, boolean>>({});
  // The draft actually rendered on the sheet/preview/PDF — narrowed to the chosen power(s) when set.
  const displayDraft = sheetVariant ? makeVariantDraft(draft, sheetVariant.group, sheetVariant.options) : draft;
  // Tracks which extraction's saved draft has finished loading, so autosave
  // never overwrites persisted edits with the freshly-built baseline.
  const hydratedSpecIdRef = useRef<string | null>(null);
  // Signature of the last fixture profile we auto-applied, so re-detecting the same fixture
  // (or a user clearing the field) never re-fills it — it applies once per detected type.
  const lastAutoPredictRef = useRef<string | null>(null);
  // Spec id that still needs its description auto-generated (fresh extraction, no saved draft).
  // Spec id that still needs its description + features auto-generated (fresh extraction, no saved
  // draft). STATE (not a ref) so setting it reliably re-runs the auto-generate effect — a ref set
  // inside the async hydration wouldn't trigger a re-render.
  const [autoGenSpecId, setAutoGenSpecId] = useState<string | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [descriptionPrompt, setDescriptionPrompt] = useState(DEFAULT_DESCRIPTION_PROMPT);
  const [featuresPrompt, setFeaturesPrompt] = useState(DEFAULT_FEATURES_PROMPT);
  const [aiBusy, setAiBusy] = useState<null | "description" | "features">(null);
  const isWideWorkspace = useMediaQuery("(min-width: 1280px)");
  const sourcePages = spec.sourcePages ?? [];
  const sourcePdfUrl = `${apiUrl(`/api/extract/${spec.id}/source-pdf`)}#toolbar=0&navpanes=0&view=FitH`;

  useEffect(() => {
    const nextRecommendations = buildProductNameRecommendations(spec);
    setProductNameRecommendations(nextRecommendations);
    const fresh = buildEditorDraft(spec, nextRecommendations);
    setDraft(fresh);
    setDraggedOverviewIndex(null);
    setOverviewDropIndex(null);
    setEditingImageId(null);
    setCroppingPageId(null);

    // Hydrate any saved edits for this extraction from IndexedDB.
    hydratedSpecIdRef.current = null;
    setAutoGenSpecId(null);
    // A fresh extraction may auto-fill its category / sub-category from the fixture profile.
    lastAutoPredictRef.current = null;
    let cancelled = false;
    loadDraft<EditorDraft>(draftKey(spec.id)).then(async (localSaved) => {
      if (cancelled) return;
      // Prefer the server-saved draft (survives browser data clears / other devices),
      // falling back to the local IndexedDB copy when offline.
      let saved: EditorDraft | null | undefined = localSaved;
      try {
        const draftResponse = await fetch(apiUrl(`/api/extract/${spec.id}/draft`), { credentials: "include" });
        if (draftResponse.ok) {
          const data = (await draftResponse.json()) as { draft?: EditorDraft | null };
          if (data?.draft) saved = data.draft;
        }
      } catch {
        /* offline — keep the local copy */
      }
      if (cancelled) return;
      if (saved) {
        // Migration: strip the auto-seeded "Photometric Diagram" sections (id "diagram-init-…") that
        // an earlier build injected — they cluttered the sheet and auto-picked the wrong image. Any
        // section the user added by hand (id "sec-…") is preserved, along with all other edits.
        if (Array.isArray(saved.customSections)) {
          saved = {
            ...saved,
            customSections: saved.customSections.filter(
              (section) => !String(section?.id ?? "").startsWith("diagram-init-"),
            ),
          };
        }
        // Merge over the fresh baseline so fields added in newer versions keep defaults.
        setDraft({ ...fresh, ...saved });
        // The saved draft already holds the user's category / sub-category — mark its fixture
        // profile as applied so auto-prediction never overwrites those hand-kept values.
        const savedProfile = predictFixtureProfile(
          saved.title, saved.subtitle, saved.categoryLabel, saved.subCategory,
        );
        if (savedProfile) lastAutoPredictRef.current = `${spec.id}::${savedProfile.id}`;
      } else {
        // Fresh extraction with no saved edits — auto-generate the description + features from the
        // recommended product name so the user doesn't have to click Generate.
        setAutoGenSpecId(String(spec.id));
      }
      hydratedSpecIdRef.current = String(spec.id);

      // Reserve globally-unique names from the backend registry so no two products repeat
      // a name. Falls back silently to the local suggestions if the backend is unavailable.
      fetch(apiUrl("/api/product-names/reserve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          key: buildProductNameRegistryKey(spec),
          candidates: buildProductNameCandidates(spec),
          count: 3,
        }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { names?: string[] } | null) => {
          if (cancelled || !data?.names?.length) return;
          const reserved = data.names;
          setProductNameRecommendations(reserved);
          // Only migrate the untouched default title — never a user's edited/chosen name.
          setDraft((current) =>
            current.title === nextRecommendations[0] ? { ...current, title: reserved[0] } : current,
          );
        })
        .catch(() => {
          /* offline / backend down — keep the local recommendations */
        });
    });

    return () => {
      cancelled = true;
    };
  }, [spec]);

  // Autosave the draft (debounced) once hydration for this spec is done — to IndexedDB for
  // instant local recall AND to the server so the hand-tweaks persist across devices/restarts.
  useEffect(() => {
    if (hydratedSpecIdRef.current !== String(spec.id)) return undefined;
    const handle = window.setTimeout(() => {
      void saveDraft(draftKey(spec.id), draft);
      void fetch(apiUrl(`/api/extract/${spec.id}/draft`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ draft }),
      }).catch(() => {
        /* offline — the IndexedDB copy still holds the edits */
      });
    }, 800);
    return () => window.clearTimeout(handle);
  }, [draft, spec.id]);

  // Smart prediction: once a fixture type is recognised from the product name / category /
  // sub-category, auto-fill the application areas that fixture is used for, and fill the
  // category / sub-category with the recommended canonical name. Fires once per detected type and
  // only cleans up messy/raw values — it NEVER force-refills a field just because it's empty, so
  // Category and Sub-category stay freely editable (you can clear or retype them).
  useEffect(() => {
    if (hydratedSpecIdRef.current !== String(spec.id)) return;
    const profile = predictFixtureProfile(
      draft.title, draft.subtitle, draft.categoryLabel, draft.subCategory, spec.productName,
    );
    if (!profile) return;

    const signature = `${spec.id}::${profile.id}`;
    // First time we detect THIS fixture for THIS spec, fill/clean the canonical names. After that we
    // leave the fields alone — so an empty field you cleared on purpose is respected, and a value you
    // hand-typed is never overwritten.
    const firstApply = lastAutoPredictRef.current !== signature;
    lastAutoPredictRef.current = signature;

    setDraft((current) => {
      const patch: Partial<EditorDraft> = {};
      // Fill on first detection, or clean up a raw backend enum ("downlight") left in a saved draft
      // (so old sheets self-correct on open) — but never touch a field the user has edited by hand
      // (the touched flag is persisted with the draft, so this holds across refreshes too).
      if (
        !current.categoryTouched
        && (
          (firstApply && current.categoryLabel !== profile.category)
          || (isRawCategoryEnum(current.categoryLabel) && current.categoryLabel !== profile.category)
        )
      ) {
        patch.categoryLabel = profile.category;
      }
      if (!current.subCategoryTouched && firstApply && current.subCategory !== profile.subCategory) {
        patch.subCategory = profile.subCategory;
      }
      if (firstApply && !isSpecified(current.applicationAreasText)) {
        patch.applicationAreasText = profile.applications.join(", ");
      }
      return Object.keys(patch).length ? { ...current, ...patch } : current;
    });
  }, [spec.id, draft.title, draft.subtitle, draft.categoryLabel, draft.subCategory]);

  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return undefined;

    const updateScale = () => {
      const availableWidth = viewport.clientWidth;
      if (availableWidth <= 0) {
        setPreviewScale(1);
        return;
      }

      setPreviewScale(Math.min(1, availableWidth / SHEET_PREVIEW_WIDTH));
    };

    updateScale();

    if (typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => updateScale());
    observer.observe(viewport);

    return () => observer.disconnect();
  }, [isWideWorkspace]);

  const displaySourceImages = getDraftSourceImages(spec, draft);
  // The vendor's embedded photos/diagrams, offered as one-click suggestions per section.
  const vendorLibraryImages = displaySourceImages.filter((image) => isLibraryImageId(image.id));
  // Images owned by a given section (plus the one currently assigned to that row, for legacy drafts).
  const imagesForOwner = (ownerKey: string, currentId: string | null) =>
    draft.manualSourceImages
      .filter((image) => (draft.imageOwners[image.id] ?? "product") === ownerKey || image.id === currentId)
      .map((image) => resolveSourceImage(image, draft.editedImageDataUrls));
  // Product Image section: only images added for the product (uploaded/cropped here), never
  // auto-extracted embedded images or images uploaded for accessories/dimensions.
  const productImages = imagesForOwner("product", draft.selectedImageId);
  const selectedImage =
    displaySourceImages.find((image) => image.id === draft.selectedImageId) ?? null;
  const editingImage =
    displaySourceImages.find((image) => image.id === editingImageId) ??
    null;
  const croppingPage =
    sourcePages.find((page) => page.id === croppingPageId) ??
    null;

  const updateDraft = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  // Show/remove a predefined sheet section (and its page(s)) — see SHEET_SECTION_TOGGLES.
  const setSectionHidden = (key: string, hidden: boolean) => {
    setDraft((current) => ({
      ...current,
      hiddenSections: { ...(current.hiddenSections ?? {}), [key]: hidden },
    }));
  };

  // Persist a dragged/resized image placement on the sheet (keyed by source-image id). Applies to
  // every sheet image — product, dimensions, accessories, and custom sections.
  const handleImagePlacementChange = (imageId: string, placement: ImagePlacement) => {
    setDraft((current) => ({
      ...current,
      imagePlacements: { ...(current.imagePlacements ?? {}), [imageId]: placement },
    }));
  };

  // When the warranty label is typed (e.g. "5 Year"), auto-fill the warranty copy with the
  // matching standard statement — but never overwrite copy the user has manually edited.
  const updateWarrantyLabel = (value: string) => {
    setDraft((current) => {
      const next: EditorDraft = { ...current, warrantyLabel: value };
      const years = Number(value.match(/\d+/)?.[0] ?? "");
      const isDerivedCopy =
        !isSpecified(current.warrantyCopy) ||
        /^This product is backed by a limited \d+-year manufacturer/i.test(normalizeText(current.warrantyCopy));
      if (Number.isFinite(years) && years > 0 && isDerivedCopy) {
        next.warrantyCopy = buildWarrantyStatement(years);
      }
      return next;
    });
  };

  const previewPageCount = getPreviewPageCount(draft, spec);
  const totalPreviewHeight =
    previewPageCount * SHEET_PREVIEW_HEIGHT + (previewPageCount - 1) * PREVIEW_PAGE_GAP;

  const openImageEditor = (imageId: string, setsSelection = true) => {
    if (setsSelection) updateDraft("selectedImageId", imageId);
    setEditingImageSetsSelection(setsSelection);
    setEditingImageId(imageId);
    setIsImageEditorOpen(true);
  };

  const openCropDialog = (pageId: string) => {
    setPendingImageTarget(null);
    setCroppingPageId(pageId);
    setIsCropDialogOpen(true);
  };

  const openCropForTarget = (target: { kind: "dimension" | "accessory" | "custom"; id: string }) => {
    if (sourcePages.length === 0) {
      toast.error("No vendor PDF pages available to crop.");
      return;
    }
    setPendingImageTarget(target);
    setCroppingPageId((current) => current ?? sourcePages[0].id);
    setIsCropDialogOpen(true);
  };

  const triggerImageUpload = (target?: { kind: "dimension" | "accessory" | "custom"; id: string }) => {
    setPendingImageTarget(target ?? null);
    uploadInputRef.current?.click();
  };

  const handleUploadFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const image = new window.Image();
      const finish = (width: number, height: number) =>
        addManualSourceImage({ id: `upload-${Date.now()}`, page: 0, width, height, dataUrl });
      image.onload = () => finish(image.naturalWidth || 0, image.naturalHeight || 0);
      image.onerror = () => finish(0, 0);
      image.src = dataUrl;
    };
    reader.onerror = () => toast.error("Could not read the image file.");
    reader.readAsDataURL(file);
  };

  const saveEditedImage = (imageId: string, dataUrl: string) => {
    setDraft((current) => ({
      ...current,
      // Only re-point the product image when editing the product image itself.
      ...(editingImageSetsSelection ? { selectedImageId: imageId } : {}),
      editedImageDataUrls: {
        ...current.editedImageDataUrls,
        [imageId]: dataUrl,
      },
    }));
    setIsImageEditorOpen(false);
  };

  const resetEditedImage = (imageId: string) => {
    setDraft((current) => {
      const nextEditedImageDataUrls = { ...current.editedImageDataUrls };
      delete nextEditedImageDataUrls[imageId];
      return {
        ...current,
        editedImageDataUrls: nextEditedImageDataUrls,
      };
    });
  };

  const addManualSourceImage = (image: SourceImage) => {
    setDraft((current) => {
      const owner = pendingImageTarget ? `${pendingImageTarget.kind}:${pendingImageTarget.id}` : "product";
      const next: EditorDraft = {
        ...current,
        manualSourceImages: [...current.manualSourceImages, image],
        imageOwners: { ...current.imageOwners, [image.id]: owner },
        // Only images meant for the product update the page-1 product image.
        selectedImageId: pendingImageTarget ? current.selectedImageId : image.id,
      };
      // Auto-assign the freshly cropped image to the row that triggered the crop.
      if (pendingImageTarget?.kind === "dimension") {
        next.dimensionItems = current.dimensionItems.map((item) =>
          item.id === pendingImageTarget.id ? { ...item, imageId: image.id } : item,
        );
      } else if (pendingImageTarget?.kind === "accessory") {
        next.accessoryRows = current.accessoryRows.map((row) =>
          row.id === pendingImageTarget.id ? { ...row, imageId: image.id } : row,
        );
      } else if (pendingImageTarget?.kind === "custom") {
        next.customSections = current.customSections.map((section) =>
          section.id === pendingImageTarget.id ? { ...section, imageId: image.id } : section,
        );
      }
      return next;
    });
    setPendingImageTarget(null);
    setIsCropDialogOpen(false);
  };

  // Assign a chosen vendor-library image to a section. We copy it into manualSourceImages with a
  // fresh id + owner, so the same vendor photo can be used by several rows and behaves like an
  // uploaded image (editable, croppable), while the original stays in the pickable library.
  const assignVendorImage = (
    target: { kind: "product" | "accessory" | "dimension" | "custom"; id: string },
    vendorImage: SourceImage,
  ) => {
    const newId = `vpick-${target.kind}-${target.id}-${vendorImage.id}`;
    setDraft((current) => {
      const already = current.manualSourceImages.some((image) => image.id === newId);
      const owner = target.kind === "product" ? "product" : `${target.kind}:${target.id}`;
      const next: EditorDraft = {
        ...current,
        manualSourceImages: already
          ? current.manualSourceImages
          : [...current.manualSourceImages, { ...vendorImage, id: newId }],
        imageOwners: { ...current.imageOwners, [newId]: owner },
      };
      if (target.kind === "product") {
        next.selectedImageId = newId;
      } else if (target.kind === "accessory") {
        next.accessoryRows = current.accessoryRows.map((row) =>
          row.id === target.id ? { ...row, imageId: newId } : row,
        );
      } else if (target.kind === "dimension") {
        next.dimensionItems = current.dimensionItems.map((item) =>
          item.id === target.id ? { ...item, imageId: newId } : item,
        );
      } else if (target.kind === "custom") {
        next.customSections = current.customSections.map((section) =>
          section.id === target.id ? { ...section, imageId: newId } : section,
        );
      }
      return next;
    });
    setVendorImagePicker(null);
  };

  const removeSourceImage = (imageId: string) => {
    setDraft((current) => {
      const nextEdited = { ...current.editedImageDataUrls };
      delete nextEdited[imageId];
      const nextOwners = { ...current.imageOwners };
      delete nextOwners[imageId];
      return {
        ...current,
        manualSourceImages: current.manualSourceImages.filter((image) => image.id !== imageId),
        editedImageDataUrls: nextEdited,
        imageOwners: nextOwners,
        selectedImageId: current.selectedImageId === imageId ? null : current.selectedImageId,
        dimensionItems: current.dimensionItems.map((item) =>
          item.imageId === imageId ? { ...item, imageId: null } : item,
        ),
        accessoryRows: current.accessoryRows.map((row) =>
          row.imageId === imageId ? { ...row, imageId: null } : row,
        ),
      };
    });
  };

  const updateOverviewRow = (index: number, field: Exclude<keyof OverviewRow, "id">, value: string) => {
    setDraft((current) => ({
      ...current,
      overviewRows: current.overviewRows.map((row, rowIndex) =>
        rowIndex === index
          ? { ...row, [field]: value, ...(field === "value" ? { manual: true } : {}) }
          : row,
      ),
    }));
  };

  const removeOverviewRow = (index: number) => {
    setDraft((current) => ({
      ...current,
      overviewRows: current.overviewRows.filter((_, rowIndex) => rowIndex !== index),
    }));
  };

  // Move a row between the sheet overview and the optional (not-included) pool.
  const setOverviewIncluded = (index: number, included: boolean) => {
    setDraft((current) => ({
      ...current,
      overviewRows: current.overviewRows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, included } : row,
      ),
    }));
  };

  const addOverviewRow = () => {
    setDraft((current) => ({
      ...current,
      overviewRows: [
        ...current.overviewRows,
        {
          id: `custom-${Date.now()}-${current.overviewRows.length}`,
          label: "",
          value: "",
          included: true,
        },
      ],
    }));
  };

  const moveOverviewRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;

    setDraft((current) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.overviewRows.length ||
        toIndex >= current.overviewRows.length
      ) {
        return current;
      }

      const nextRows = [...current.overviewRows];
      const [movedRow] = nextRows.splice(fromIndex, 1);

      if (!movedRow) {
        return current;
      }

      nextRows.splice(toIndex, 0, movedRow);
      return {
        ...current,
        overviewRows: nextRows,
      };
    });
  };

  // ---- Page 2: Product Specifications ----
  const addSpecGroup = () => {
    setDraft((current) => ({
      ...current,
      specGroups: [
        ...current.specGroups,
        {
          id: `spec-${Date.now()}-${current.specGroups.length}`,
          partNumber: "",
          sku: "",
          options: [{ power: "", lumen: "" }],
          voltage: "",
          efficacy: "",
          cri: "",
          current: "",
          cct: "",
          thd: "",
          lightDistribution: "",
        },
      ],
    }));
  };

  const removeSpecGroup = (index: number) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.filter((_, i) => i !== index),
    }));
  };

  const updateSpecGroup = (index: number, patch: Partial<SpecGroup>) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    }));
  };

  const addSpecOption = (groupIndex: number) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.map((group, i) =>
        i === groupIndex ? { ...group, options: [...group.options, { power: "", lumen: "" }] } : group,
      ),
    }));
  };

  const updateSpecOption = (groupIndex: number, optionIndex: number, patch: Partial<SpecOption>) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.map((group, i) =>
        i === groupIndex
          ? {
              ...group,
              options: group.options.map((option, oi) => (oi === optionIndex ? { ...option, ...patch } : option)),
            }
          : group,
      ),
    }));
  };

  const removeSpecOption = (groupIndex: number, optionIndex: number) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.map((group, i) =>
        i === groupIndex && group.options.length > 1
          ? { ...group, options: group.options.filter((_, oi) => oi !== optionIndex) }
          : group,
      ),
    }));
  };

  // ---- Page 3: Ordering decoder ----
  const updateOrderingSelection = (columnId: string, code: string) => {
    setDraft((current) => ({
      ...current,
      orderingSelection: { ...current.orderingSelection, [columnId]: code },
    }));
  };

  const updateOrderingEntry = (columnIndex: number, entryIndex: number, patch: Partial<OrderingEntry>) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.map((column, i) =>
        i === columnIndex
          ? { ...column, entries: column.entries.map((entry, ei) => (ei === entryIndex ? { ...entry, ...patch } : entry)) }
          : column,
      ),
    }));
  };

  const addOrderingEntry = (columnIndex: number) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.map((column, i) =>
        i === columnIndex ? { ...column, entries: [...column.entries, { code: "", description: "" }] } : column,
      ),
    }));
  };

  const removeOrderingEntry = (columnIndex: number, entryIndex: number) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.map((column, i) =>
        i === columnIndex && column.entries.length > 1
          ? { ...column, entries: column.entries.filter((_, ei) => ei !== entryIndex) }
          : column,
      ),
    }));
  };

  // ---- Product Specifications COLUMNS (rename label/unit, show/hide) ----
  const updateSpecColumn = (index: number, patch: Partial<{ label: string; unit: string; hidden: boolean }>) => {
    setDraft((current) => ({
      ...current,
      specColumns: resolveSpecColumns(current.specColumns).map((column, i) => (i === index ? { ...column, ...patch } : column)),
    }));
  };
  // Insert a user-defined custom column BEFORE the given position (one value per variant).
  const insertSpecColumn = (beforeIndex: number) => {
    setDraft((current) => {
      const cols = [...resolveSpecColumns(current.specColumns)];
      const fieldId = `custom:${Date.now()}`;
      cols.splice(beforeIndex, 0, { id: fieldId, label: "New Column", unit: "", field: fieldId as `custom:${string}`, scope: "group" });
      return { ...current, specColumns: cols };
    });
  };
  const removeSpecColumn = (index: number) => {
    setDraft((current) => {
      const cols = resolveSpecColumns(current.specColumns);
      const target = cols[index];
      if (!target || !target.field.startsWith("custom:")) return current; // only custom columns are deletable
      return { ...current, specColumns: cols.filter((_, i) => i !== index) };
    });
  };
  const setSpecGroupExtra = (groupIndex: number, field: string, value: string) => {
    setDraft((current) => ({
      ...current,
      specGroups: current.specGroups.map((group, i) =>
        i === groupIndex ? { ...group, extra: { ...(group.extra ?? {}), [field]: value } } : group,
      ),
    }));
  };

  // ---- Ordering COLUMNS (dynamic: rename / add / delete a whole column) ----
  const renameOrderingColumn = (columnIndex: number, header: string) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.map((column, i) => (i === columnIndex ? { ...column, header } : column)),
    }));
  };
  const setOrderingColumnUnit = (columnIndex: number, unit: string) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.map((column, i) => (i === columnIndex ? { ...column, unit } : column)),
    }));
  };
  const removeOrderingColumn = (columnIndex: number) => {
    setDraft((current) => ({
      ...current,
      orderingColumns: current.orderingColumns.filter((_, i) => i !== columnIndex),
    }));
  };
  const addOrderingColumn = () => {
    setDraft((current) => ({
      ...current,
      orderingColumns: [
        ...current.orderingColumns,
        { id: `ordering-col-${Date.now()}`, group: "construction", header: "New Column", unit: "", entries: [{ code: "", description: "" }] },
      ],
    }));
  };
  // Insert a new column at a specific position (in the same group as the column it's inserted before),
  // so a column can be added BETWEEN any two existing ones.
  const insertOrderingColumn = (beforeIndex: number) => {
    setDraft((current) => {
      const next = [...current.orderingColumns];
      const group = next[beforeIndex]?.group ?? "construction";
      next.splice(beforeIndex, 0, {
        id: `ordering-col-${Date.now()}`,
        group,
        header: "New Column",
        unit: "",
        entries: [{ code: "", description: "" }],
      });
      return { ...current, orderingColumns: next };
    });
  };

  // ---- Extra vendor tables (editable, prefilled) ----
  const mapExtraTables = (fn: (t: ExtraTable) => ExtraTable) =>
    setDraft((current) => ({ ...current, extraTables: (current.extraTables ?? []).map(fn) }));
  const updateExtraTableTitle = (id: string, title: string) =>
    mapExtraTables((t) => (t.id === id ? { ...t, title } : t));
  const updateExtraTableHeader = (id: string, col: number, value: string) =>
    mapExtraTables((t) => (t.id === id ? { ...t, headers: t.headers.map((h, i) => (i === col ? value : h)) } : t));
  const updateExtraTableCell = (id: string, row: number, col: number, value: string) =>
    mapExtraTables((t) =>
      t.id === id
        ? { ...t, rows: t.rows.map((r, ri) => (ri === row ? r.map((c, ci) => (ci === col ? value : c)) : r)) }
        : t,
    );
  const addExtraTableRow = (id: string) =>
    mapExtraTables((t) => (t.id === id ? { ...t, rows: [...t.rows, t.headers.map(() => "")] } : t));
  const removeExtraTableRow = (id: string, row: number) =>
    mapExtraTables((t) => (t.id === id ? { ...t, rows: t.rows.filter((_, ri) => ri !== row) } : t));
  const addExtraTableColumn = (id: string) =>
    mapExtraTables((t) =>
      t.id === id ? { ...t, headers: [...t.headers, `Column ${t.headers.length + 1}`], rows: t.rows.map((r) => [...r, ""]) } : t,
    );
  const removeExtraTable = (id: string) =>
    setDraft((current) => ({ ...current, extraTables: (current.extraTables ?? []).filter((t) => t.id !== id) }));
  const addExtraTable = () =>
    setDraft((current) => ({
      ...current,
      extraTables: [
        ...(current.extraTables ?? []),
        { id: `extratable-${Date.now()}`, title: "Additional Data", headers: ["Column 1", "Column 2"], rows: [["", ""]] },
      ],
    }));

  // ---- Page 3: Accessories ----
  const addAccessoryRow = () => {
    setDraft((current) => ({
      ...current,
      accessoryRows: [
        ...current.accessoryRows,
        { id: `acc-${Date.now()}-${current.accessoryRows.length}`, code: "", description: "", imageId: null, downloadUrl: "" },
      ],
    }));
  };

  const updateAccessoryRow = (index: number, patch: Partial<AccessoryRow>) => {
    setDraft((current) => ({
      ...current,
      accessoryRows: current.accessoryRows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  };

  const removeAccessoryRow = (index: number) => {
    setDraft((current) => ({
      ...current,
      accessoryRows: current.accessoryRows.filter((_, i) => i !== index),
    }));
  };

  // ---- Page 4: Dimensions ----
  const addDimensionItem = () => {
    setDraft((current) => ({
      ...current,
      dimensionItems: [
        ...current.dimensionItems,
        { id: `dim-${Date.now()}-${current.dimensionItems.length}`, label: "", imageId: null, width: "", height: "", depth: "" },
      ],
    }));
  };

  const updateDimensionItem = (index: number, patch: Partial<DimensionItem>) => {
    setDraft((current) => ({
      ...current,
      dimensionItems: current.dimensionItems.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  };

  const removeDimensionItem = (index: number) => {
    setDraft((current) => ({
      ...current,
      dimensionItems: current.dimensionItems.filter((_, i) => i !== index),
    }));
  };

  const addCustomSection = () => {
    setDraft((current) => ({
      ...current,
      customSections: [
        ...current.customSections,
        { id: `sec-${Date.now()}-${current.customSections.length}`, heading: "", bodyText: "", imageId: null },
      ],
    }));
  };

  const updateCustomSection = (index: number, patch: Partial<CustomSection>) => {
    setDraft((current) => ({
      ...current,
      customSections: current.customSections.map((section, i) => (i === index ? { ...section, ...patch } : section)),
    }));
  };

  const removeCustomSection = (index: number) => {
    setDraft((current) => ({
      ...current,
      customSections: current.customSections.filter((_, i) => i !== index),
    }));
  };

  const toggleQualificationBadge = (badgeId: QualificationBadgeId) => {
    setDraft((current) => ({
      ...current,
      selectedQualificationIds: current.selectedQualificationIds.includes(badgeId)
        ? current.selectedQualificationIds.filter((item) => item !== badgeId)
        : [...current.selectedQualificationIds, badgeId],
    }));
  };

  const handleOverviewDragStart = (index: number) => (event: React.DragEvent<HTMLButtonElement>) => {
    setDraggedOverviewIndex(index);
    setOverviewDropIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };

  const handleOverviewDragOver = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (overviewDropIndex !== index) {
      setOverviewDropIndex(index);
    }
  };

  const handleOverviewDrop = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const fallbackIndex = Number(event.dataTransfer.getData("text/plain"));
    const sourceIndex = draggedOverviewIndex ?? (Number.isNaN(fallbackIndex) ? null : fallbackIndex);

    if (sourceIndex !== null) {
      moveOverviewRow(sourceIndex, index);
    }

    setDraggedOverviewIndex(null);
    setOverviewDropIndex(null);
  };

  const handleOverviewDragEnd = () => {
    setDraggedOverviewIndex(null);
    setOverviewDropIndex(null);
  };


  const getPrintablePages = () =>
    Array.from(previewRef.current?.querySelectorAll<HTMLElement>(".sheet-print-root") ?? []).filter(
      (element) => element.getAttribute("data-page-empty") !== "true",
    );

  const waitForSheetImages = async (sheets: HTMLElement[]) => {
    const images = sheets.flatMap((sheet) => Array.from(sheet.querySelectorAll("img")));
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            }),
      ),
    );
  };

  // One-click, works everywhere (including embedded webviews): captures each page
  // exactly as it appears in the preview and auto-downloads to the Downloads folder.
  // The look is pixel-identical to the preview; the text is not selectable/editable.
  const runDownloadPdf = async () => {
    const sheets = getPrintablePages();
    if (sheets.length === 0) {
      toast.error("The sheet preview is not ready yet.");
      return;
    }

    const toastId = toast.loading("Generating PDF...");
    try {
      await waitForSheetImages(sheets);
      const [{ toPng }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
      const pdf = new jsPDF({ unit: "in", format: "letter", orientation: "portrait" });

      for (let i = 0; i < sheets.length; i += 1) {
        const dataUrl = await toPng(sheets[i], {
          pixelRatio: 3,
          cacheBust: true,
          backgroundColor: "#ffffff",
          width: 816,
          height: 1056,
          style: { transform: "none", margin: "0", boxShadow: "none" },
          // Strip editor-only overlays (e.g. the image drag frame + resize handle) from the export.
          filter: (node) =>
            !(node instanceof HTMLElement && node.dataset?.exportHide === "true"),
        });
        if (i > 0) pdf.addPage();
        pdf.addImage(dataUrl, "PNG", 0, 0, 8.5, 11, undefined, "FAST");
      }

      const filename = `${draft.title.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "spec_sheet"}.pdf`;
      pdf.save(filename);
      toast.success("PDF saved to your Downloads folder.", { id: toastId });
    } catch (error) {
      console.error("PDF export failed", error);
      toast.error("Could not generate the PDF. Please try again.", { id: toastId });
    }
  };

  // Editable route: prints the real sheet HTML so the PDF looks exactly like the
  // preview AND keeps text editable. Requires a browser whose print dialog offers a
  // "Save as PDF" destination (Chrome/Edge) — not available in some embedded webviews.
  const runEditablePdf = async () => {
    const sheets = getPrintablePages();
    if (sheets.length === 0) {
      toast.error("The sheet preview is not ready yet.");
      return;
    }

    try {
      await waitForSheetImages(sheets);

      const printRoot = document.createElement("div");
      printRoot.className = "print-only-root";
      sheets.forEach((sheet) => {
        const clone = sheet.cloneNode(true) as HTMLElement;
        clone.style.transform = "none";
        clone.style.margin = "0 auto";
        clone.style.boxShadow = "none";
        printRoot.appendChild(clone);
      });
      document.body.appendChild(printRoot);
      document.body.classList.add("printing");

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return; // idempotent — afterprint + fallback must not double-run
        cleaned = true;
        document.body.classList.remove("printing");
        printRoot.remove();
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup);

      toast.message(
        "In the print dialog, set the destination to \"Save as PDF\". If you only see printers, open this app in Chrome or Edge — then the text stays editable.",
        { duration: 9000 },
      );

      window.setTimeout(() => {
        window.print();
        // Fallback ONLY if `afterprint` never fires (some embedded webviews). Long enough that it can
        // never remove the print content while the user is still in the Save-as-PDF dialog — the old
        // 1s timer could blank the printout wherever window.print() is non-blocking.
        window.setTimeout(cleanup, 120000);
      }, 60);
    } catch (error) {
      console.error("PDF export failed", error);
      toast.error("Could not open the print dialog. Please try again.");
    }
  };

  const runPdf = (kind: "download" | "editable") =>
    kind === "editable" ? runEditablePdf() : runDownloadPdf();

  // Entry point for the two export buttons. If the fixture has more than one power/variant and none
  // has been chosen for this sheet yet, ask the user which to build first.
  const requestPdf = (kind: "download" | "editable") => {
    if (hasVariantChoice && !sheetVariant) {
      setPendingPdfKind(kind);
      openVariantDialog();
      return;
    }
    void runPdf(kind);
  };

  // Open the dialog and default every option to checked (for the selectable multi-select groups).
  const openVariantDialog = () => {
    const checks: Record<string, boolean> = {};
    variantGroups.forEach((group) => group.options.forEach((option) => (checks[option.key] = true)));
    setVariantChecks(checks);
    setVariantDialogOpen(true);
  };

  // After a variant is picked in the dialog, the preview re-renders single-variant; wait two frames
  // for the DOM/images to settle, then run the queued export.
  useEffect(() => {
    if (!pendingPdfRun) return;
    const kind = pendingPdfRun;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void runPdf(kind);
        setPendingPdfRun(null);
      }),
    );
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPdfRun]);

  // Resolve the variant dialog: apply the chosen power(s) (or "all"), then queue the pending export.
  const chooseSheetVariant = (
    selection: { label: string; group: VariantGroup; options: VariantOption[] } | null,
  ) => {
    setSheetVariant(selection && selection.options.length > 0 ? selection : null);
    setVariantDialogOpen(false);
    if (pendingPdfKind) {
      setPendingPdfRun(pendingPdfKind);
      setPendingPdfKind(null);
    }
  };

  const runAiContent = async (kind: "description" | "features", instruction: string) => {
    setAiBusy(kind);
    const toastId = toast.loading(`Generating ${kind}…`);
    try {
      const specsSummary = draft.overviewRows
        .filter((row) => isSpecified(row.label) && isSpecified(row.value))
        .slice(0, 24)
        .map((row) => `${row.label}: ${row.value}`)
        .join("; ");
      const product = {
        name: draft.title,
        category: draft.categoryLabel,
        subCategory: draft.subCategory,
        specs: specsSummary,
        current: kind === "description" ? draft.description : draft.featuresText,
      };
      const response = await fetch(apiUrl("/api/ai-content"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ kind, instruction, product }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { text?: string; features?: string[] };
      if (kind === "description" && isSpecified(data.text ?? "")) {
        updateDraft("description", String(data.text).trim());
        toast.success("Description updated.", { id: toastId });
      } else if (kind === "features" && Array.isArray(data.features) && data.features.length > 0) {
        updateDraft("featuresText", data.features.filter(Boolean).slice(0, 4).join("\n"));
        toast.success("Features updated.", { id: toastId });
      } else {
        toast.error("AI returned no usable content.", { id: toastId });
      }
    } catch (error) {
      console.error("AI content generation failed", error);
      toast.error("AI generation failed. Check the backend/model.", { id: toastId });
    } finally {
      setAiBusy(null);
    }
  };

  // Auto-generate BOTH the description and the features once for a fresh extraction, using the
  // (settled) recommended product name — so the user never has to click Generate. The 1.2s debounce
  // lets the reserved unique name arrive first; re-scheduling on title change means it always uses
  // the final name. Description runs first, then features (sequential AI calls).
  useEffect(() => {
    if (autoGenSpecId !== String(spec.id)) return undefined;
    if (hydratedSpecIdRef.current !== String(spec.id)) return undefined;
    if (!isSpecified(draft.title) || aiBusy) return undefined;
    const handle = window.setTimeout(async () => {
      setAutoGenSpecId(null);
      await runAiContent("description", descriptionPrompt);
      await runAiContent("features", featuresPrompt);
    }, 1200);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id, autoGenSpecId, draft.title, aiBusy]);

  const renderControlsPanel = (className?: string) => (
    <Card className={cn("sheet-editor-controls flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <div className="shrink-0 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="h-4 w-4 text-primary" />
          Edit First Page
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-5 py-5">
          <ReviewPanel draft={draft} spec={spec} />
          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
              Header
            </h2>
            <Input
              value={draft.headerProjectName}
              onChange={(event) => updateDraft("headerProjectName", event.target.value)}
              placeholder="Project Name"
            />
            <Input
              value={draft.headerCatNumber}
              onChange={(event) => updateDraft("headerCatNumber", event.target.value)}
              placeholder="CAT.#"
            />
            <Input
              value={draft.headerFixtureSchedule}
              onChange={(event) => updateDraft("headerFixtureSchedule", event.target.value)}
              placeholder="Fixture Schedule"
            />
            <Input
              value={draft.headerNote}
              onChange={(event) => updateDraft("headerNote", event.target.value)}
              placeholder="Note"
            />
            <Input
              value={draft.footerNote}
              onChange={(event) => updateDraft("footerNote", event.target.value)}
              placeholder="Footer note (shown above the footer bar)"
            />
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
              Product
            </h2>
            <div className="rounded-2xl border border-border/70 bg-card/40 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Recommended Product Names
              </div>
              <div className="mt-3 grid gap-2">
                {productNameRecommendations.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => updateDraft("title", name)}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors",
                      draft.title === name
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/70 bg-background hover:border-primary/40 hover:bg-primary/5",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <Input
              value={draft.skuNumber}
              onChange={(event) => updateDraft("skuNumber", event.target.value)}
              placeholder="SKU No. (shown above the product name)"
            />
            <Input
              value={draft.title}
              onChange={(event) => updateDraft("title", event.target.value)}
              placeholder="Product name"
            />
            <Input
              value={draft.categoryLabel}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, categoryLabel: value, categoryTouched: true }));
              }}
              placeholder="Category (auto — e.g. Indoor / Outdoor / HazLoc Lighting)"
            />
            <Input
              value={draft.subCategory}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, subCategory: value, subCategoryTouched: true }));
              }}
              placeholder="Sub-category (auto — e.g. Panel, Linear High Bay)"
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Product Image
              </h2>
              <Badge variant="outline">
                {productImages.length} {productImages.length === 1 ? "image" : "images"}
              </Badge>
            </div>
            <div className="flex gap-2">
              {vendorLibraryImages.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVendorImagePicker({ kind: "product", id: "product" })}
                  className="h-10 flex-1 gap-2 rounded-xl border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
                  title="Pick a suggested product image from the vendor PDF"
                >
                  <Sparkles className="h-4 w-4" />
                  Suggest
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => triggerImageUpload()}
                className="h-10 flex-1 gap-2 rounded-xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
                title="Upload a product image from your computer"
              >
                <Upload className="h-4 w-4" />
                Upload
              </Button>
            </div>
            {productImages.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                {productImages.map((image) => (
                  <div
                    key={image.id}
                    className={cn(
                      "overflow-hidden rounded-2xl border p-1 transition-all",
                      draft.selectedImageId === image.id
                        ? "border-primary bg-primary/10 shadow-[0_0_20px_rgba(6,182,212,0.18)]"
                        : "border-border/60 bg-card/40 hover:border-primary/40",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => updateDraft("selectedImageId", image.id)}
                      className="block w-full"
                    >
                      <img
                        src={image.dataUrl}
                        alt={image.page > 0 ? `Cropped from page ${image.page}` : "Uploaded image"}
                        className="h-28 w-full rounded-xl object-cover"
                      />
                    </button>
                    <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-2">
                      <div className="text-left text-[11px] font-medium text-muted-foreground">
                        {image.page > 0 ? `Page ${image.page}` : "Uploaded"}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-7 rounded-lg px-2 text-[10px] font-semibold uppercase tracking-[0.12em]"
                          onClick={() => openImageEditor(image.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-7 w-7 rounded-lg border-border/70 p-0 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                          onClick={() => removeSourceImage(image.id)}
                          aria-label="Delete image"
                          title="Delete image"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
                No product image yet. Upload one above, or use the crop action in the vendor PDF panel to add one.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Qualification Icons
              </h2>
              <Badge variant="outline">{draft.selectedQualificationIds.length} selected</Badge>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {QUALIFICATION_BADGES.map((badge) => {
                const isSelected = draft.selectedQualificationIds.includes(badge.id);
                return (
                  <button
                    key={badge.id}
                    type="button"
                    onClick={() => toggleQualificationBadge(badge.id)}
                    className={cn(
                      "rounded-2xl border p-2 transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-border/70 bg-background hover:border-primary/40 hover:bg-primary/5",
                    )}
                  >
                    <QualificationBadge id={badge.id} selected={isSelected} className="mx-auto h-[70px] w-[70px]" />
                    <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {badge.label}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Overview
              </h2>
              <div className="text-[10px] font-medium text-muted-foreground">
                Drag rows to reorder
              </div>
            </div>
            {/* Overview text size: Auto-fits to the box by default; override manually if needed. */}
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/30 px-3 py-2">
              <span className="text-[11px] font-semibold text-muted-foreground">
                Overview text size
                <span className="ml-1.5 font-normal text-foreground">
                  {draft.overviewFontPx == null ? "Auto-fit" : `${draft.overviewFontPx}px`}
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 w-7 p-0 text-base leading-none"
                  onClick={() => updateDraft("overviewFontPx", Math.max(5, Math.round(((draft.overviewFontPx ?? 10) - 0.5) * 2) / 2))}
                  title="Smaller"
                  aria-label="Decrease overview text size"
                >
                  −
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 w-7 p-0 text-base leading-none"
                  onClick={() => updateDraft("overviewFontPx", Math.min(18, Math.round(((draft.overviewFontPx ?? 10) + 0.5) * 2) / 2))}
                  title="Larger"
                  aria-label="Increase overview text size"
                >
                  +
                </Button>
                <Button
                  type="button"
                  variant={draft.overviewFontPx == null ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => updateDraft("overviewFontPx", null)}
                  title="Auto-fit the overview text to the box"
                >
                  Auto
                </Button>
              </div>
            </div>
            {/* Source-grounding legend: each value is checked against the vendor PDF text. */}
            {isSpecified(spec.sourceText) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/60 bg-card/30 px-3 py-2 text-[10px] text-muted-foreground">
                <span className="font-semibold uppercase tracking-wide">Source check:</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> found</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> partial</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" /> not in PDF — verify</span>
                <span className="text-muted-foreground/70">(hover a dot for the source snippet)</span>
              </div>
            )}
            <div className="space-y-3">
              {draft.overviewRows.map((row, index) => row.included === false ? null : (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-start gap-2 rounded-2xl border border-transparent p-2 transition-colors",
                    draggedOverviewIndex === index
                      ? "bg-primary/5"
                      : overviewDropIndex === index
                        ? "border-primary/40 bg-primary/5"
                        : "hover:border-border/60 hover:bg-card/20",
                  )}
                  onDragOver={handleOverviewDragOver(index)}
                  onDrop={handleOverviewDrop(index)}
                >
                  <button
                    type="button"
                    draggable
                    onDragStart={handleOverviewDragStart(index)}
                    onDragEnd={handleOverviewDragEnd}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 cursor-grab active:cursor-grabbing"
                    aria-label={`Drag ${row.label || "overview row"} to reorder`}
                    title="Drag to reorder"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start">
                    <Input
                      value={row.label}
                      onChange={(event) => updateOverviewRow(index, "label", event.target.value)}
                      className="sm:w-[132px] sm:shrink-0"
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <ConfidenceBadge value={row.value} sourceText={spec.sourceText} />
                      {row.value.includes("\n") ? (
                        <Textarea
                          value={row.value}
                          onChange={(event) => updateOverviewRow(index, "value", event.target.value)}
                          className="min-h-[84px] flex-1"
                        />
                      ) : (
                        <Input
                          value={row.value}
                          onChange={(event) => updateOverviewRow(index, "value", event.target.value)}
                          className="min-w-0 flex-1"
                        />
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOverviewIncluded(index, false)}
                    className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 text-muted-foreground hover:border-primary/40 hover:bg-primary/5 [&>svg]:!size-5"
                    aria-label={`Move ${row.label || "overview row"} to optional`}
                    title="Move to optional (hide from sheet)"
                  >
                    <EyeOff className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => removeOverviewRow(index)}
                    className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                    aria-label={`Delete ${row.label || "overview row"}`}
                    title="Delete row"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addOverviewRow}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Field
              </Button>

              {/* Optional pool: extra values found in the vendor PDF that aren't one of the
                  category's standard overview heads. The user opts them into the sheet. */}
              {draft.overviewRows.some((row) => row.included === false && isSpecified(row.value)) && (
                <div className="mt-2 space-y-2 rounded-2xl border border-border/60 bg-card/20 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Optional fields — not on the sheet
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Extra values found in the vendor PDF (beyond the standard overview heads), plus any
                    rows you&apos;ve hidden. Click{" "}
                    <span className="font-semibold text-primary">Include</span> to add one to the sheet.
                  </p>
                  {draft.overviewRows.map((row, index) =>
                    row.included === false && isSpecified(row.value) ? (
                      <div
                        key={row.id}
                        className="flex items-center gap-2 rounded-xl border border-border/50 bg-background/60 p-2"
                      >
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setOverviewIncluded(index, true)}
                          className="h-8 shrink-0 gap-1 rounded-lg border-primary/40 bg-primary/5 px-2 text-[12px] text-primary hover:border-primary hover:bg-primary/10"
                        >
                          <Plus className="h-3.5 w-3.5" /> Include
                        </Button>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                          <span className="font-semibold">{formatOverviewLabel(row.label)}:</span> {row.value}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => removeOverviewRow(index)}
                          className="h-8 w-8 shrink-0 rounded-lg border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] [&>svg]:!size-4"
                          aria-label="Delete optional field"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
              Copy
            </h2>
            <Textarea
              value={draft.description}
              onChange={(event) => updateDraft("description", event.target.value)}
              placeholder="Product description"
              className="min-h-[120px]"
            />
            <AiCopyAssistant
              label="description"
              prompt={descriptionPrompt}
              onPromptChange={setDescriptionPrompt}
              busy={aiBusy === "description"}
              onGenerate={() => runAiContent("description", descriptionPrompt)}
            />
            <Textarea
              value={draft.featuresText}
              onChange={(event) => updateDraft("featuresText", event.target.value)}
              placeholder="One feature per line"
              className="min-h-[130px]"
            />
            <AiCopyAssistant
              label="features"
              prompt={featuresPrompt}
              onPromptChange={setFeaturesPrompt}
              busy={aiBusy === "features"}
              onGenerate={() => runAiContent("features", featuresPrompt)}
            />
            <Textarea
              value={draft.applicationAreasText}
              onChange={(event) => updateDraft("applicationAreasText", event.target.value)}
              placeholder="Comma separated application areas"
              className="min-h-[110px]"
            />
            <Input
              value={draft.certificationsText}
              onChange={(event) => updateDraft("certificationsText", event.target.value)}
              placeholder="Certification keywords"
            />
            <Input
              value={draft.warrantyLabel}
              onChange={(event) => updateWarrantyLabel(event.target.value)}
              placeholder="Warranty label"
            />
            <Textarea
              value={draft.warrantyCopy}
              onChange={(event) => updateDraft("warrantyCopy", event.target.value)}
              placeholder="Warranty copy"
              className="min-h-[180px]"
            />
          </section>

          <div className="flex items-center gap-2 border-t border-border/60 pt-5">
            <FileText className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Edit Additional Pages</span>
          </div>

          {/* Page 2 — Product Specifications */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Product Specifications
              </h2>
              <Badge variant="outline">{draft.specGroups.length} rows</Badge>
            </div>
            <details className="rounded-2xl border border-border/70 bg-card/40 p-3">
              <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Table columns — rename or hide
              </summary>
              <div className="mt-2 space-y-1.5">
                {resolveSpecColumns(draft.specColumns).map((column, columnIndex) => {
                  const isCustom = column.field.startsWith("custom:");
                  return (
                    <div key={column.id}>
                      <button
                        type="button"
                        onClick={() => insertSpecColumn(columnIndex)}
                        className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-primary/30 py-0.5 text-[10px] text-primary/80 hover:border-primary hover:bg-primary/5"
                        title="Insert a new column before this one"
                      >
                        <Plus className="h-3 w-3" /> Insert column here
                      </button>
                      <div className="mt-1 flex items-center gap-2">
                        <Input
                          value={column.label}
                          onChange={(event) => updateSpecColumn(columnIndex, { label: event.target.value })}
                          placeholder="Column name"
                          className={cn("h-9 text-[12px]", column.hidden && "opacity-50")}
                        />
                        <Input
                          value={column.unit}
                          onChange={(event) => updateSpecColumn(columnIndex, { unit: event.target.value })}
                          placeholder="Unit"
                          className={cn("h-9 w-[64px] shrink-0 text-[12px]", column.hidden && "opacity-50")}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => updateSpecColumn(columnIndex, { hidden: !column.hidden })}
                          className="h-9 shrink-0 px-2 text-[11px]"
                          title={column.hidden ? "Show this column" : "Hide this column"}
                        >
                          {column.hidden ? "Show" : "Hide"}
                        </Button>
                        {isCustom && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => removeSpecColumn(columnIndex)}
                            className="h-9 w-9 shrink-0 rounded-xl border-[#7a3b3b] bg-[#5f2a2a] p-0 text-red-100 hover:bg-[#743636] [&>svg]:!size-4 [&>svg]:!text-red-100"
                            title="Delete this custom column"
                            aria-label="Delete custom column"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <p className="pt-1 text-[10px] text-muted-foreground">
                  Hidden columns leave the printed table; rename headers/units above. Use "Insert column
                  here" to add a custom column — then fill its per-variant value in each part-number block below.
                </p>
              </div>
            </details>
            <div className="space-y-3">
              {draft.specGroups.map((group, groupIndex) => (
                <div key={group.id} className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={group.partNumber}
                      onChange={(event) => updateSpecGroup(groupIndex, { partNumber: event.target.value })}
                      placeholder="Part number"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeSpecGroup(groupIndex)}
                      className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                      aria-label="Delete part number"
                      title="Delete part number"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Input
                    value={group.sku ?? ""}
                    onChange={(event) => updateSpecGroup(groupIndex, { sku: event.target.value })}
                    placeholder="SKU No. (shown under the part number)"
                  />

                  <div className="space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Power (W) / Lumen (lm) options
                    </div>
                    {group.options.map((option, optionIndex) => (
                      <div key={optionIndex} className="flex items-center gap-2">
                        <Input
                          value={option.power}
                          onChange={(event) => updateSpecOption(groupIndex, optionIndex, { power: event.target.value })}
                          placeholder="Power (W)"
                        />
                        <Input
                          value={option.lumen}
                          onChange={(event) => updateSpecOption(groupIndex, optionIndex, { lumen: event.target.value })}
                          placeholder="Lumen (lm)"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => removeSpecOption(groupIndex, optionIndex)}
                          className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                          aria-label="Delete option"
                          title="Delete option"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => addSpecOption(groupIndex)}
                      className="h-9 w-full rounded-xl border-dashed border-primary/40 bg-primary/5 text-[12px] text-primary hover:border-primary hover:bg-primary/10"
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Add option
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Input value={group.voltage} onChange={(event) => updateSpecGroup(groupIndex, { voltage: event.target.value })} placeholder="Voltage (V)" />
                    <Input value={group.efficacy} onChange={(event) => updateSpecGroup(groupIndex, { efficacy: event.target.value })} placeholder="Efficacy (lm/W)" />
                    <Input value={group.cri} onChange={(event) => updateSpecGroup(groupIndex, { cri: event.target.value })} placeholder="CRI" />
                    <Input value={group.cct} onChange={(event) => updateSpecGroup(groupIndex, { cct: event.target.value })} placeholder="CCT (K)" />
                    <Input value={group.thd} onChange={(event) => updateSpecGroup(groupIndex, { thd: event.target.value })} placeholder="THD" />
                    <Input value={group.lightDistribution} onChange={(event) => updateSpecGroup(groupIndex, { lightDistribution: event.target.value })} placeholder="Light Distribution" className="col-span-2" />
                    {resolveSpecColumns(draft.specColumns)
                      .filter((column) => column.field.startsWith("custom:"))
                      .map((column) => (
                        <Input
                          key={column.id}
                          value={group.extra?.[column.field] ?? ""}
                          onChange={(event) => setSpecGroupExtra(groupIndex, column.field, event.target.value)}
                          placeholder={column.label || "Custom column"}
                          className="col-span-2"
                        />
                      ))}
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addSpecGroup}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Part Number
              </Button>
            </div>
            <Textarea
              value={draft.specsNote}
              onChange={(event) => updateDraft("specsNote", event.target.value)}
              placeholder="Specifications note"
              className="min-h-[70px]"
            />
          </section>

          {/* Page 3 — Product Ordering Information */}
          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
              Product Ordering Information
            </h2>
            <Input
              value={draft.orderingExample}
              onChange={(event) => updateDraft("orderingExample", event.target.value)}
              placeholder="Typical order example (e.g. IK-LHB2-02-...)"
            />

            {/* Build order code: single-option columns auto-fill; multi-option columns are selectable. */}
            <div className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Build Order Code (Selection)
              </div>
              <div className="grid grid-cols-2 gap-2">
                {draft.orderingColumns.map((column) => {
                  const options = orderingCodeOptions(column);
                  if (options.length === 0) return null;
                  const value = selectedOrderingCode(column, draft.orderingSelection);
                  const isMulti = options.length > 1;
                  return (
                    <label key={column.id} className="flex flex-col gap-1 text-[11px]">
                      <span className="font-semibold text-muted-foreground">
                        {column.header}
                        {isMulti ? "" : " (auto)"}
                      </span>
                      {isMulti ? (
                        <select
                          value={value}
                          onChange={(event) => updateOrderingSelection(column.id, event.target.value)}
                          className="h-9 rounded-md border border-primary/40 bg-background px-2 text-sm"
                        >
                          <option value="">Select…</option>
                          {options.map((option, i) => (
                            <option key={i} value={option.code}>
                              {option.code}
                              {isSpecified(option.description) ? ` — ${option.description}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="flex h-9 items-center rounded-md border border-border/50 bg-muted/40 px-2 text-sm text-muted-foreground">
                          {value || "—"}
                        </div>
                      )}
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <div className="min-w-0 flex-1 truncate rounded-md bg-primary/5 px-2 py-1.5 text-[12px] font-semibold text-primary">
                  {buildOrderingCode(draft.orderingColumns, draft.orderingSelection) || "—"}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 shrink-0"
                  onClick={() =>
                    updateDraft("orderingExample", buildOrderingCode(draft.orderingColumns, draft.orderingSelection))
                  }
                >
                  Use as example
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {draft.orderingColumns.map((column, columnIndex) => (
                <div key={column.id} className="space-y-1.5 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <button
                    type="button"
                    onClick={() => insertOrderingColumn(columnIndex)}
                    className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-primary/30 py-0.5 text-[10px] text-primary/80 hover:border-primary hover:bg-primary/5"
                    title="Insert a new column before this one"
                  >
                    <Plus className="h-3 w-3" /> Insert column here
                  </button>
                  <div className="flex items-center gap-2">
                    <Input
                      value={column.header}
                      onChange={(event) => renameOrderingColumn(columnIndex, event.target.value)}
                      placeholder="Column name"
                      className="h-9 font-semibold"
                    />
                    <Input
                      value={column.unit}
                      onChange={(event) => setOrderingColumnUnit(columnIndex, event.target.value)}
                      placeholder="Unit"
                      className="h-9 w-[70px] shrink-0"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeOrderingColumn(columnIndex)}
                      className="h-9 w-9 shrink-0 rounded-xl border-[#7a3b3b] bg-[#5f2a2a] p-0 text-red-100 hover:bg-[#743636] [&>svg]:!size-4 [&>svg]:!text-red-100"
                      aria-label="Delete column"
                      title="Delete this column"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {column.entries.map((entry, entryIndex) => (
                    <div key={entryIndex} className="flex items-center gap-2">
                      <Input
                        value={entry.code}
                        onChange={(event) => updateOrderingEntry(columnIndex, entryIndex, { code: event.target.value })}
                        placeholder="Code"
                        className="w-[90px] shrink-0"
                      />
                      <Input
                        value={entry.description}
                        onChange={(event) => updateOrderingEntry(columnIndex, entryIndex, { description: event.target.value })}
                        placeholder="Meaning"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => removeOrderingEntry(columnIndex, entryIndex)}
                        className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                        aria-label="Delete entry"
                        title="Delete entry"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => addOrderingEntry(columnIndex)}
                    className="h-9 w-full rounded-xl border-dashed border-primary/40 bg-primary/5 text-[12px] text-primary hover:border-primary hover:bg-primary/10"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add code
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addOrderingColumn}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Column
              </Button>
            </div>
            <Textarea
              value={draft.orderingNote}
              onChange={(event) => updateDraft("orderingNote", event.target.value)}
              placeholder="Ordering note"
              className="min-h-[70px]"
            />
          </section>

          {/* Page 3 — Accessories */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Accessories Ordering
              </h2>
              <Badge variant="outline">{draft.accessoryRows.length} rows</Badge>
            </div>
            <div className="space-y-2">
              {draft.accessoryRows.map((row, index) => (
                <div key={row.id} className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.code}
                      onChange={(event) => updateAccessoryRow(index, { code: event.target.value })}
                      placeholder="Product code"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeAccessoryRow(index)}
                      className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                      aria-label="Delete accessory"
                      title="Delete accessory"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Input
                    value={row.description}
                    onChange={(event) => updateAccessoryRow(index, { description: event.target.value })}
                    placeholder="Description"
                  />
                  <Input
                    value={row.downloadUrl}
                    onChange={(event) => updateAccessoryRow(index, { downloadUrl: event.target.value })}
                    placeholder="Download URL"
                  />
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <SecondPageImagePicker
                        images={imagesForOwner(`accessory:${row.id}`, row.imageId)}
                        value={row.imageId}
                        onChange={(value) => updateAccessoryRow(index, { imageId: value })}
                      />
                    </div>
                    {vendorLibraryImages.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setVendorImagePicker({ kind: "accessory", id: row.id })}
                        className="h-10 shrink-0 gap-1 rounded-xl border-primary/40 bg-primary/5 px-3 text-[12px] text-primary"
                        title="Pick a suggested image from the vendor PDF"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Suggest
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => openCropForTarget({ kind: "accessory", id: row.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Crop a new image from the vendor PDF"
                    >
                      <Crop className="h-3.5 w-3.5" />
                      Crop
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => triggerImageUpload({ kind: "accessory", id: row.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Upload an image from your computer"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!row.imageId}
                      onClick={() => row.imageId && openImageEditor(row.imageId, false)}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Edit this image — crop, erase, pen, background & adjustments"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addAccessoryRow}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Accessory
              </Button>
            </div>
          </section>

          {/* Page 4 — Dimensions */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Dimensions
              </h2>
              <Badge variant="outline">{draft.dimensionItems.length} drawings</Badge>
            </div>
            <div className="space-y-2">
              {draft.dimensionItems.map((item, index) => (
                <div key={item.id} className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={item.label}
                      onChange={(event) => updateDimensionItem(index, { label: event.target.value })}
                      placeholder="Label (e.g. 2' : IK-LHB2-02-S0150)"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeDimensionItem(index)}
                      className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                      aria-label="Delete drawing"
                      title="Delete drawing"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <SecondPageImagePicker
                        images={imagesForOwner(`dimension:${item.id}`, item.imageId)}
                        value={item.imageId}
                        onChange={(value) => updateDimensionItem(index, { imageId: value })}
                      />
                    </div>
                    {vendorLibraryImages.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setVendorImagePicker({ kind: "dimension", id: item.id })}
                        className="h-10 shrink-0 gap-1 rounded-xl border-primary/40 bg-primary/5 px-3 text-[12px] text-primary"
                        title="Pick a suggested drawing from the vendor PDF"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Suggest
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => openCropForTarget({ kind: "dimension", id: item.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Crop a new drawing from the vendor PDF"
                    >
                      <Crop className="h-3.5 w-3.5" />
                      Crop
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => triggerImageUpload({ kind: "dimension", id: item.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Upload a drawing from your computer"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!item.imageId}
                      onClick={() => item.imageId && openImageEditor(item.imageId, false)}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Edit this drawing — crop, erase, pen, background & adjustments"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Input value={item.width} onChange={(event) => updateDimensionItem(index, { width: event.target.value })} placeholder="Width" />
                    <Input value={item.height} onChange={(event) => updateDimensionItem(index, { height: event.target.value })} placeholder="Height" />
                    <Input value={item.depth} onChange={(event) => updateDimensionItem(index, { depth: event.target.value })} placeholder="Depth" />
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addDimensionItem}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Drawing
              </Button>
            </div>
          </section>

          {/* Custom sections — add your own heading with text points and/or an image (extra page). */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Custom Sections
              </h2>
              <Badge variant="outline">{draft.customSections.length} sections</Badge>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Add a heading, then text points (one per line) and/or an image. Each appears on an extra
              page after Ordering.
            </p>
            <div className="space-y-2">
              {draft.customSections.map((section, index) => (
                <div key={section.id} className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={section.heading}
                      onChange={(event) => updateCustomSection(index, { heading: event.target.value })}
                      placeholder="Section heading (e.g. Installation, Controls)"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeCustomSection(index)}
                      className="h-10 w-10 shrink-0 rounded-xl border-border/70 p-0 border-[#7a3b3b] bg-[#5f2a2a] text-red-100 hover:bg-[#743636] hover:text-red-50 [&>svg]:!size-5 [&>svg]:!text-red-100"
                      aria-label="Delete section"
                      title="Delete section"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Textarea
                    value={section.bodyText}
                    onChange={(event) => updateCustomSection(index, { bodyText: event.target.value })}
                    placeholder="One text point per line"
                    className="min-h-[90px]"
                  />
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <SecondPageImagePicker
                        images={imagesForOwner(`custom:${section.id}`, section.imageId)}
                        value={section.imageId}
                        onChange={(value) => updateCustomSection(index, { imageId: value })}
                      />
                    </div>
                    {vendorLibraryImages.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setVendorImagePicker({ kind: "custom", id: section.id })}
                        className="h-10 shrink-0 gap-1 rounded-xl border-primary/40 bg-primary/5 px-3 text-[12px] text-primary"
                        title="Pick a suggested diagram from the vendor PDF"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Suggest
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => openCropForTarget({ kind: "custom", id: section.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Crop a new image from the vendor PDF"
                    >
                      <Crop className="h-3.5 w-3.5" />
                      Crop
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => triggerImageUpload({ kind: "custom", id: section.id })}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Upload an image from your computer"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!section.imageId}
                      onClick={() => section.imageId && openImageEditor(section.imageId, false)}
                      className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[12px]"
                      title="Edit this image — crop, erase, pen, text, background & adjustments"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addCustomSection}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Section
              </Button>
            </div>
          </section>

          {/* Sheet Sections — remove any predefined section (and its page) the vendor sheet doesn't need. */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Sheet Sections
              </h2>
              <Badge variant="outline">
                {SHEET_SECTION_TOGGLES.filter((s) => !isSectionHidden(draft, s.key)).length}/{SHEET_SECTION_TOGGLES.length} shown
              </Badge>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Turn off any section you don't need — it (and its page) is removed from the generated sheet
              and the PDF. Turn it back on anytime. Overview, header and footer are always kept.
            </p>
            <div className="space-y-2">
              {SHEET_SECTION_TOGGLES.map((s) => {
                const hidden = isSectionHidden(draft, s.key);
                return (
                  <div
                    key={s.key}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/40 px-3 py-2"
                  >
                    <span className={cn("text-[13px] font-medium", hidden ? "text-muted-foreground line-through" : "text-foreground")}>
                      {s.label}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSectionHidden(s.key, !hidden)}
                      className={cn(
                        "h-8 shrink-0 gap-1 rounded-lg px-3 text-[11px] font-semibold",
                        hidden ? "border-primary/40 bg-primary/5 text-primary" : "text-muted-foreground",
                      )}
                      title={hidden ? "Add this section back to the sheet" : "Remove this section (and its page) from the sheet"}
                    >
                      {hidden ? <Plus className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      {hidden ? "Add back" : "Remove"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Extra Tables — vendor tables captured verbatim, rendered at the end, editable here. */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
                Extra Tables
              </h2>
              <Badge variant="outline">{(draft.extraTables ?? []).length} tables</Badge>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Extra vendor tables (e.g. photometric / performance data) captured from the PDF. They
              render in IKIO style at the end of the sheet — edit any title, header or cell here.
            </p>
            <div className="space-y-3">
              {(draft.extraTables ?? []).map((table) => (
                <div key={table.id} className="space-y-2 rounded-2xl border border-border/70 bg-card/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={table.title}
                      onChange={(event) => updateExtraTableTitle(table.id, event.target.value)}
                      placeholder="Table title"
                      className="font-semibold"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeExtraTable(table.id)}
                      className="h-10 w-10 shrink-0 rounded-xl border-[#7a3b3b] bg-[#5f2a2a] p-0 text-red-100 hover:bg-[#743636] [&>svg]:!size-5 [&>svg]:!text-red-100"
                      aria-label="Delete table"
                      title="Delete table"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="border-collapse">
                      <thead>
                        <tr>
                          {table.headers.map((header, ci) => (
                            <th key={ci} className="p-0.5">
                              <Input
                                value={header}
                                onChange={(event) => updateExtraTableHeader(table.id, ci, event.target.value)}
                                className="h-8 min-w-[92px] text-[11px] font-semibold"
                                placeholder={`Col ${ci + 1}`}
                              />
                            </th>
                          ))}
                          <th className="p-0.5">
                            <Button type="button" variant="outline" className="h-8 whitespace-nowrap px-2 text-[11px]" onClick={() => addExtraTableColumn(table.id)}>
                              + Col
                            </Button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map((row, ri) => (
                          <tr key={ri}>
                            {table.headers.map((_, ci) => (
                              <td key={ci} className="p-0.5">
                                <Input
                                  value={row[ci] ?? ""}
                                  onChange={(event) => updateExtraTableCell(table.id, ri, ci, event.target.value)}
                                  className="h-8 min-w-[92px] text-[11px]"
                                />
                              </td>
                            ))}
                            <td className="p-0.5">
                              <Button
                                type="button"
                                variant="outline"
                                className="h-8 w-8 p-0 [&>svg]:!size-4"
                                onClick={() => removeExtraTableRow(table.id, ri)}
                                title="Remove row"
                                aria-label="Remove row"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button type="button" variant="outline" className="h-9 w-full text-[12px]" onClick={() => addExtraTableRow(table.id)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add Row
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={addExtraTable}
                className="h-11 w-full rounded-2xl border-dashed border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Table
              </Button>
            </div>
          </section>
        </div>
      </ScrollArea>
    </Card>
  );

  const renderPreviewPanel = (className?: string) => (
    <Card className={cn("sheet-preview-shell flex h-full min-h-0 flex-col overflow-hidden bg-gradient-to-b from-slate-950/80 to-slate-900/40", className)}>
      <div className="shrink-0 border-b border-white/10 px-5 py-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold text-white">Generated Template Preview</div>
            <div className="text-xs text-slate-400">
              US Letter, 8.5 x 11 in, ready for print/save as PDF from the browser.
            </div>
          </div>
          <Badge className="bg-white/5 text-white" variant="outline">
            {previewPageCount} Pages
          </Badge>
        </div>
      </div>

      <div ref={previewViewportRef} className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <div
          className="mx-auto"
          style={{
            height: `${totalPreviewHeight * previewScale}px`,
            width: `${SHEET_PREVIEW_WIDTH * previewScale}px`,
          }}
        >
          <div
            ref={previewRef}
            style={{
              height: `${totalPreviewHeight}px`,
              transform: `scale(${previewScale})`,
              transformOrigin: "top left",
              width: `${SHEET_PREVIEW_WIDTH}px`,
            }}
          >
            <SheetPreview
              draft={displayDraft}
              selectedImage={selectedImage}
              spec={spec}
              variantSelected={sheetVariant !== null}
              onImagePlacementChange={handleImagePlacementChange}
            />
          </div>
        </div>
      </div>
    </Card>
  );

  // "Learn this vendor" — teach the extractor this vendor's format so future PDFs from the same
  // vendor extract every detail the same way. Sends the vendor name + this sheet's source text.
  const learnThisVendor = async () => {
    const guess = normalizeText((spec as { vendorInfo?: { vendorName?: string } }).vendorInfo?.vendorName ?? "") || draft.title;
    const vendorName = typeof window !== "undefined" ? window.prompt("Remember this vendor's format under which name?", guess) : guess;
    if (!vendorName || !normalizeText(vendorName)) return;
    const sourceText = spec.sourceText ?? "";
    if (!isSpecified(sourceText)) {
      toast.error("No vendor text to learn from — re-extract this PDF first.");
      return;
    }
    setLearningVendor(true);
    const toastId = toast.loading("Learning this vendor's format…");
    try {
      const res = await fetch(apiUrl("/api/learn-vendor"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorName: normalizeText(vendorName), sourceText }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; vendor?: string; source?: string; totalProfiles?: number; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
      toast.success(
        `Learned "${data.vendor}" (${data.source === "ai" ? "AI profile" : "keyword profile"}). ` +
          `${data.totalProfiles ?? ""} vendor formats remembered.`,
        { id: toastId },
      );
    } catch (err) {
      toast.error(`Couldn't learn this vendor: ${err instanceof Error ? err.message : String(err)}`, { id: toastId });
    } finally {
      setLearningVendor(false);
    }
  };

  const renderVendorPanel = (className?: string) => (
    <Card className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <div className="shrink-0 border-b border-border/60 px-5 py-4">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Vendor PDF Review</div>
            <div className="text-xs text-muted-foreground">
              Cross-check the uploaded vendor specification sheet beside the generated IKIO template. Use page crop to capture product visuals instead of auto-extracting embedded PDF images.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline">{sourcePages.length} pages</Badge>
            <a
              href={sourcePdfUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-border/70 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <ExternalLink className="h-3.5 w-3.5 text-primary" />
              Open Original PDF
            </a>
            <Button
              type="button"
              variant="outline"
              disabled={learningVendor || !isSpecified(spec.sourceText ?? "")}
              onClick={learnThisVendor}
              className="inline-flex h-auto items-center gap-2 rounded-xl border-border/70 px-3 py-2 text-xs font-semibold text-foreground hover:border-primary/40 hover:bg-primary/5"
              title="Teach the extractor this vendor's format so future PDFs from the same vendor extract every detail the same way."
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {learningVendor ? "Learning…" : "Learn this vendor"}
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-5">
        <div className="h-full overflow-hidden rounded-[1.5rem] border border-border/70 bg-slate-950/60">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-5">
              {sourcePages.length > 0 ? (
                sourcePages.map((page) => (
                  <div key={page.id} className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
                    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
                      <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                        Page {page.page}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg px-3 text-[10px] font-semibold uppercase tracking-[0.12em]"
                        onClick={() => openCropDialog(page.id)}
                      >
                        <Crop className="mr-2 h-3.5 w-3.5" />
                        Crop Image
                      </Button>
                    </div>
                    <img src={page.dataUrl} alt={`Vendor PDF page ${page.page}`} className="w-full" />
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                  Vendor PDF page previews were not stored for this extraction. Re-extract the PDF once to populate this panel with the original vendor pages.
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Card>
  );

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.26em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Visual Sheet Editor
          </div>
          <h1 className="mt-3 break-words text-2xl font-display font-bold text-foreground sm:text-3xl">
            {draft.title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Editable page-1 builder with the vendor PDF as reference on the same screen.
            The generated sheet follows the demo layout and uses the IKIO header/footer template.
          </p>
          <p className="mt-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Vendor Source Name: {spec.productName}
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Button
              variant="outline"
              className="flex-1 gap-2 sm:flex-none"
              onClick={() => {
                // Rebuild the draft from scratch (new overview template, SKU, etc.) and allow the
                // fixture auto-prediction to re-fill category / sub-category / group (buildEditorDraft
                // starts with the touched flags cleared).
                lastAutoPredictRef.current = null;
                setSheetVariant(null);
                setDraft(buildEditorDraft(spec));
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            <Button className="flex-1 gap-2 sm:flex-none" onClick={() => requestPdf("download")}>
              <FileText className="h-4 w-4" />
              Download PDF
            </Button>
            <Button variant="outline" className="flex-1 gap-2 sm:flex-none" onClick={() => requestPdf("editable")}>
              <FileText className="h-4 w-4" />
              Editable PDF (Print)
            </Button>
          </div>
          {hasVariantChoice && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
              <span className="text-muted-foreground">Sheet variant:</span>
              {sheetVariant ? (
                <>
                  <span className="max-w-[220px] truncate rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-semibold text-primary">
                    {sheetVariant.label}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground underline hover:text-foreground"
                    onClick={openVariantDialog}
                  >
                    change
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground underline hover:text-foreground"
                    onClick={() => setSheetVariant(null)}
                  >
                    all powers
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-border/70 px-2.5 py-1 font-medium text-foreground hover:border-primary/40"
                  onClick={openVariantDialog}
                >
                  All powers — pick a variant
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {isWideWorkspace ? (
        <div className="h-[calc(100vh-250px)] min-h-[720px]">
          <ResizablePanelGroup
            autoSaveId="spec-sheet-workspace"
            direction="horizontal"
            className="h-full min-h-0 w-full"
          >
            <ResizablePanel defaultSize={26} minSize={20}>
              <div className="h-full min-h-0 min-w-0 pr-3">
                {renderControlsPanel()}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle className="bg-transparent" />
            <ResizablePanel defaultSize={42} minSize={32}>
              <div className="h-full min-h-0 min-w-0 px-3">
                {renderPreviewPanel()}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle className="bg-transparent" />
            <ResizablePanel defaultSize={32} minSize={24}>
              <div className="h-full min-h-0 min-w-0 pl-3">
                {renderVendorPanel()}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      ) : (
        <div className="grid gap-6">
          {renderControlsPanel()}
          {renderPreviewPanel()}
          {renderVendorPanel()}
        </div>
      )}

      <ImageEditorDialog
        image={editingImage}
        open={isImageEditorOpen}
        onOpenChange={setIsImageEditorOpen}
        onSave={(dataUrl) => {
          if (!editingImageId) return;
          saveEditedImage(editingImageId, dataUrl);
        }}
        onReset={() => {
          if (!editingImageId) return;
          resetEditedImage(editingImageId);
        }}
      />
      <SourcePageCropDialog
        page={croppingPage}
        pages={sourcePages}
        onSelectPage={setCroppingPageId}
        open={isCropDialogOpen}
        onOpenChange={(open) => {
          setIsCropDialogOpen(open);
          if (!open) setPendingImageTarget(null);
        }}
        onSave={addManualSourceImage}
      />
      <Dialog open={vendorImagePicker !== null} onOpenChange={(open) => !open && setVendorImagePicker(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Suggested images from the vendor PDF</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Pick an image to use for this {vendorImagePicker?.kind === "product" ? "product" : vendorImagePicker?.kind}.
            You can crop or clean it afterwards with the Edit tool.
          </p>
          {vendorLibraryImages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
              No embedded images were found in this vendor PDF. Use Crop to capture one from a page.
            </div>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-auto p-1 sm:grid-cols-3">
              {(vendorImagePicker ? sortVendorImagesFor(vendorLibraryImages, vendorImagePicker.kind) : vendorLibraryImages).map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => vendorImagePicker && assignVendorImage(vendorImagePicker, image)}
                  className="group flex flex-col items-center gap-1 rounded-xl border border-border/70 bg-card/40 p-2 transition hover:border-primary hover:bg-primary/5"
                  title={`Use this image (page ${image.page})`}
                >
                  <img
                    src={image.dataUrl}
                    alt={`Vendor image on page ${image.page}`}
                    className="h-28 w-full rounded-lg bg-white object-contain"
                  />
                  <span className="text-[11px] text-muted-foreground">Page {image.page}</span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) handleUploadFile(file);
          event.target.value = "";
        }}
      />

      <Dialog
        open={variantDialogOpen}
        onOpenChange={(open) => {
          setVariantDialogOpen(open);
          if (!open) setPendingPdfKind(null);
        }}
      >
        <DialogContent className="max-h-[88vh] w-[min(94vw,480px)] max-w-none overflow-hidden p-0">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle>Which variant should the sheet be for?</DialogTitle>
            <DialogDescription>
              Selectable variants list all their powers (tick the ones to include); distinct variants
              are separate. Pick one, or keep all powers on the sheet.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[64vh] space-y-3 overflow-auto px-6 py-5">
            {variantGroups.map((group, gi) => {
              const groupTitle = group.fixture || (variantGroups.length > 1 ? `Variant ${gi + 1}` : "Power");
              if (!group.selectable) {
                const option = group.options[0];
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() =>
                      chooseSheetVariant({
                        label: [group.fixture, option.power].filter(isSpecified).join(" · ") || option.power,
                        group,
                        options: [option],
                      })
                    }
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-background px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{option.power || groupTitle}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[groupTitle !== option.power ? groupTitle : "", option.lumen, option.efficacy].filter(isSpecified).join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Single
                    </span>
                  </button>
                );
              }
              const checked = group.options.filter((option) => variantChecks[option.key]);
              return (
                <div key={group.id} className="space-y-2 rounded-xl border border-border/70 bg-card/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{groupTitle}</span>
                    <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Power selectable
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {group.options.map((option) => (
                      <label
                        key={option.key}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-primary/5"
                      >
                        <input
                          type="checkbox"
                          checked={!!variantChecks[option.key]}
                          onChange={() => setVariantChecks((current) => ({ ...current, [option.key]: !current[option.key] }))}
                          className="h-4 w-4 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{option.power}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {[option.lumen, option.efficacy].filter(isSpecified).join(" · ")}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      type="button"
                      className="h-8 px-3 text-xs"
                      disabled={checked.length === 0}
                      onClick={() =>
                        chooseSheetVariant({
                          label: `${groupTitle} · ${checked.length} power${checked.length > 1 ? "s" : ""}`,
                          group,
                          options: checked,
                        })
                      }
                    >
                      Use selected ({checked.length})
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={() =>
                        chooseSheetVariant({
                          label: `${groupTitle} · all ${group.options.length} powers`,
                          group,
                          options: group.options,
                        })
                      }
                    >
                      Use all (selectable)
                    </Button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => chooseSheetVariant(null)}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              Keep all powers / variants on the sheet
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

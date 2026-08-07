import base64
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import time
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS
import pdfplumber
import pypdfium2 as pdfium
import requests

app = Flask(__name__)
CORS(app)


def _load_dotenv() -> None:
    """Load KEY=VALUE lines from flask-backend/.env into the environment (no dependency).
    Existing environment variables always win, so START-WINDOWS.bat settings are preserved."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception:
        pass


_load_dotenv()

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama").strip().lower()
# When a cloud provider (gemini/groq) fails, only fall back to local Ollama if this is enabled.
# Default OFF so a Gemini error surfaces its real cause instead of a confusing "Ollama timed out"
# on servers that have no Ollama installed.
LLM_FALLBACK_OLLAMA = os.environ.get("LLM_FALLBACK_OLLAMA", "0").strip().lower() in ("1", "true", "yes", "on")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").strip()
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b").strip()
OLLAMA_TIMEOUT_SECONDS = int(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "300").strip())

GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1").strip().rstrip("/")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_TIMEOUT_SECONDS = int(os.environ.get("GROQ_TIMEOUT_SECONDS", "120").strip())

GEMINI_URL = os.environ.get("GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta").strip().rstrip("/")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest").strip()
# Image-capable model used for the in-editor "AI Edit" (e.g. converting mm dimensions to inches).
GEMINI_IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image").strip()
# Sibling image models to fail over to when the primary is overloaded (429/503) through all retries.
GEMINI_IMAGE_FALLBACK_MODELS = [
    m.strip()
    for m in os.environ.get(
        "GEMINI_IMAGE_FALLBACK_MODELS", "gemini-3.1-flash-image,nano-banana-pro-preview"
    ).split(",")
    if m.strip()
]
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_TIMEOUT_SECONDS = int(os.environ.get("GEMINI_TIMEOUT_SECONDS", "180").strip())
PDF_RENDER_SCALE = float(os.environ.get("PDF_RENDER_SCALE", "3.0").strip())
MAX_PROMPT_CHARS = int(os.environ.get("MAX_PROMPT_CHARS", "36000").strip())
# Multimodal extraction: also send the rendered page images to Gemini so it analyzes the PDF
# visually (product type, finish swatches, diagrams, tables, labels) — not just the extracted text.
LLM_VISION = os.environ.get("LLM_VISION", "1").strip().lower() not in {"0", "false", "no"}
LLM_VISION_MAX_PAGES = int(os.environ.get("LLM_VISION_MAX_PAGES", "8").strip())
ENABLE_PADDLE_OCR = os.environ.get("ENABLE_PADDLE_OCR", "1").strip().lower() not in {"0", "false", "no"}
# docTR (deep-learning OCR) is the PRIMARY OCR engine — it reads image-based spec tables reliably.
ENABLE_DOCTR_OCR = os.environ.get("ENABLE_DOCTR_OCR", "1").strip().lower() not in {"0", "false", "no"}
DOCTR_MODEL = None
DOCTR_READY = None

# Cache extraction results by PDF content so the same file is never re-analyzed (saves
# LLM quota + time). Cache-busting: bump CACHE_VERSION when the pipeline output changes.
ENABLE_EXTRACTION_CACHE = os.environ.get("ENABLE_EXTRACTION_CACHE", "1").strip().lower() not in {"0", "false", "no"}
EXTRACTION_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "extraction_cache")
CACHE_VERSION = "v20"  # bump when the extraction prompt/normalization changes so cached PDFs re-run


def _extraction_cache_path(pdf_bytes: bytes) -> str:
    digest = hashlib.sha256(CACHE_VERSION.encode() + pdf_bytes).hexdigest()
    return os.path.join(EXTRACTION_CACHE_DIR, f"{digest}.json")


def load_cached_extraction(pdf_bytes: bytes) -> "dict[str, Any] | None":
    if not ENABLE_EXTRACTION_CACHE:
        return None
    path = _extraction_cache_path(pdf_bytes)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def save_cached_extraction(pdf_bytes: bytes, result: "dict[str, Any]") -> None:
    if not ENABLE_EXTRACTION_CACHE:
        return
    try:
        os.makedirs(EXTRACTION_CACHE_DIR, exist_ok=True)
        with open(_extraction_cache_path(pdf_bytes), "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    except Exception as exc:  # noqa: BLE001 - cache write is best-effort
        print(f"[cache] save failed: {exc}", flush=True)


def purge_cached_extraction(pdf_bytes: bytes) -> bool:
    """Delete the cached result for a PDF so re-uploading forces a fresh analysis."""
    path = _extraction_cache_path(pdf_bytes)
    try:
        if os.path.exists(path):
            os.remove(path)
            return True
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] purge failed: {exc}", flush=True)
    return False

SYSTEM_PROMPT = """You are an expert lighting specification analyst building IKIO-style technical data sheet drafts from vendor PDFs.

Your job is to read the vendor source carefully, understand the real product family/fixture availability first, and then map the data into IKIO-standard fields without inventing unsupported claims.

You are given BOTH the extracted vendor TEXT and the RENDERED PAGE IMAGES of the same PDF. Analyze them together: use the images to read anything the text is missing, garbled or out of order — the true product type/name, finish colour swatches, ordering/spec/decoder tables, dimension diagrams, certification icons and small labels — and cross-check the text against what you actually see on the page. When the text and the image disagree, trust what is clearly shown in the document image. Correctly identify the fixture TYPE from the whole page (e.g. an area / shoebox / site luminaire is an "area" light, NOT a flood light) — do not guess from a single ambiguous word.

Return ONLY valid JSON with this exact structure:
{
  "productName": "Vendor-source product name, cleaned for IKIO TDS use",
  "alternateName": "Alternate vendor/product naming if present",
  "productDescription": "One concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value (400-450 characters). Grounded in the source PDF.",
  "productFeatures": ["Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars"],
  "applicationAreas": ["Area 1", "Area 2", "Area 3", "Area 4", "Area 5", "Area 6"],
  "productCategory": "panel/downlight/track/flood/area/high_mast/street/high_bay/low_bay/linear/wall_pack/canopy/post_top/stadium/bollard/unknown",
  "subCategory": "More specific sub-type or series name (e.g. 'Tri-Proof Light', 'Linear High Bay'). Best guess from the source if not explicit.",
  "isProductFamily": true,
  "orderingInfo": {
    "Brand": [{"code": "IK", "description": "IKIO"}],
    "Family/Version": [{"code": "value", "description": "meaning"}],
    "Size": [{"code": "value", "description": "meaning"}],
    "Power": [{"code": "value", "description": "meaning"}],
    "Voltage": [{"code": "value", "description": "meaning"}],
    "Dimming": [{"code": "value", "description": "meaning"}],
    "CCT": [{"code": "value", "description": "meaning"}],
    "Distribution": [{"code": "value", "description": "meaning"}],
    "Driver": [{"code": "value", "description": "meaning"}],
    "Finish": [{"code": "value", "description": "meaning"}],
    "Manufacturer": [{"code": "value", "description": "meaning"}]
  },
  "orderingExample": "Full assembled example ordering/part number if present, else best guess like IK-LHB2-02-...",
  "accessories": [
    {"code": "Accessory product code", "description": "Accessory description"}
  ],
  "dimensions": [
    {"label": "Fixture/variant label", "width": "value in", "height": "value in", "depth": "value in"}
  ],
  "extraTables": [
    {"title": "Photometric Performance", "headers": ["Model", "Watts", "3000K", "4000K", "5000K"],
     "rows": [["MAL08100W", "100W", "14540lm", "15800lm", "15000lm"]]}
  ],
  "variantOverview": {
    "parameters": ["Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"],
    "matrix": [
      ["60W package", "20W/30W/40W/50W/60W", "2800lm/4200lm/5600lm/7000lm/8400lm", "3000K/4000K/5000K", "140lm/W"],
      ["120W package", "40W/60W/80W/100W/120W", "5600lm/8400lm/11200lm/14000lm/16800lm", "3000K/4000K/5000K", "140lm/W"]
    ]
  },
  "variants": [
    {
      "label": "Variant/package label (NOT a part number)",
      "fixtureType": "value",
      "power": "Every selectable wattage, slash-separated, e.g. 20W/30W/40W/50W/60W",
      "lumenOutput": "Every lumen value in the SAME order, e.g. 2800lm/4200lm/5600lm/7000lm/8400lm",
      "cct": "3000K/4000K/5000K",
      "efficacy": "value"
    }
  ],
  "technicalSpecs": [
   
    {"parameter": "Power", "specification": "value"},
    {"parameter": "Voltage", "specification": "value"},
    {"parameter": "Current", "specification": "value"},
    {"parameter": "Power Factor", "specification": "value"},
    {"parameter": "THD", "specification": "value"},
    {"parameter": "Surge Protection", "specification": "value"},
    {"parameter": "Lumen Output", "specification": "value"},
    {"parameter": "Efficacy", "specification": "value"},
    {"parameter": "Color Temperature", "specification": "value"},
    {"parameter": "Color Rendering (CRI)", "specification": "value"},
    {"parameter": "R9 (Red Value)", "specification": "value"},
    {"parameter": "R13 (Skin Tones)", "specification": "value"},
    {"parameter": "Beam Angle", "specification": "value"},
    {"parameter": "Light Distribution", "specification": "value"},
    {"parameter": "BUG Rating", "specification": "value"},
    {"parameter": "IP Rating", "specification": "value"},
    {"parameter": "IK Rating", "specification": "value"},
    {"parameter": "Lifespan", "specification": "value"},
    {"parameter": "Warranty", "specification": "value"},
    {"parameter": "Operating Temperature", "specification": "value"},
    {"parameter": "Dimming", "specification": "value"},
    {"parameter": "Driver", "specification": "value"},
    {"parameter": "LED Source", "specification": "value"},
    {"parameter": "Housing Material", "specification": "value"},
    {"parameter": "Lens", "specification": "value"},
    {"parameter": "Mounting", "specification": "value"},
    {"parameter": "Protection Class", "specification": "value"},
    {"parameter": "Weight", "specification": "value"},
    {"parameter": "Dimensions", "specification": "value"},
    {"parameter": "Fixture Type", "specification": "value"},
    {"parameter": "EPA(Effective Protected area)", "specification": "value"},
    {"parameter": "Sensor Type", "specification": "value"},
    {"parameter": "Connectivity", "specification": "value"},
    {"parameter": "Color Options", "specification": "value"},
    {"parameter": "Finish Options", "specification": "value"},
    {"parameter": "Operating Humidity", "specification": "value"},
    {"parameter": "Storage Temperature", "specification": "value"},
    {"parameter": "Storage Humidity", "specification": "value"}
  ],
  "categorySpecificSpecs": [
    {"parameter": "value", "specification": "value"}
  ],
  "notes": ["note"],
  "vendorInfo": {"vendorName": "value", "vendorContact": "value"}
}

Rules:
- Read the vendor source first. Do not invent missing specs.
- READ EVERY LANGUAGE: the vendor PDF is often in Chinese, or mixed Chinese + English (or another
  language). Read ALL text in EVERY language — headers, table cells, footnotes, callouts — and
  TRANSLATE it to English to understand it. NEVER skip or mark a value "Not Specified" just because
  its label is written in Chinese/another language; translate the label, match it to the right field,
  and fill the value. Numbers/units are usually universal even when the label is Chinese.
- SCAN EVERY SPEC TABLE ON EVERY PAGE: vendors put the detailed parameters in a "Specifications" /
  "Technical Parameters" / "参数" table (frequently on page 2+). Read that table row by row and pull
  EACH parameter into the matching field, including ones easy to miss: Power Factor (功率因数),
  Total Harmonic Distortion / THD (总谐波失真), Surge Protection (浪涌保护), Operating Temperature
  (工作温度), Ingress Protection / IP rating (防护等级), IK rating, Average Life / lifespan (寿命),
  Warranty (质保), CRI (显色指数), Beam Angle (光束角), Driver (驱动), LED source (光源), Housing
  (外壳), Finish (表面处理), Cover/Lens material (透镜/罩), Cover Type. If the value exists ANYWHERE
  in the PDF (in any language), extract it — only use "Not Specified" when it is truly absent.
- NEVER leave a field blank. Use "Not Specified" for missing scalar values.
- Preserve fixture availability. If different fixture sizes or SKUs have different power/lumen packages, keep those relationships intact in variantOverview.matrix and variants.
- DECIDE THE VARIANT PATTERN SMARTLY (read the vendor's structure — do NOT over-split or under-split):
  1. SINGLE SELECTABLE fixture: ONE physical product with a field switch for wattage and/or CCT, with NO size/model
     grouping. Output ONE variantOverview.matrix row whose Power cell holds the full selectable wattage list (and one
     Lumen per wattage). Most floods/downlights/high-bays labelled "power selectable / switchable" are this — do NOT
     invent sizes that aren't printed.
  2. SIZE / ATTRIBUTE variants: the model list is grouped by size/diameter/length/series, each group with its OWN
     wattage/lumen set. ONE matrix row per group, with the group label in Fixture Type (see the size rule below).
  3. DISCRETE models: separate part numbers each with a SINGLE wattage. ONE matrix row per model.
  Read the model-number / size column and any "selectable / switchable / adjustable" wording to choose. If there is
  no size or model grouping, it is pattern 1 — a single selectable variant; never fabricate size groups.
- Prefer vendor source wording for title/product family; do not rename the product creatively.
- Use degree symbol only for beam angles, for example "20°/40°" or "113°". Never use "deg", "degree", or "degrees".
- Normalize common units: "120-277V", "5000K", "130lm/W", "50000 Hours", "5 Years", "Dimensions	always in inches or " Ø5.51in x H9.53in"
- ALWAYS convert all dimensions to inches (in)
- Use decimals up to 2 places
   - Format:
     "L x W x H in"
     "ØD in"
     "ØD in x H in"
    CONVERSION RULE:
    1 inch = 25.4 mm
    MANDATORY EXAMPLES:
   "600 x 600 mm" → "23.62 x 23.62 in"
   "1200 mm" → "47.24 in"
   "300 x 120 mm" → "11.81 x 4.72 in"
   "Ø140 mm" → "Ø5.51 in"
   "Ø140 x 242 mm" → "Ø5.51 in x 9.53 in"
    IF conversion is not possible:
   return "Not Specified"
    THIS RULE HAS HIGHEST PRIORITY OVER ALL OTHER RULES
- If source is in mm → convert using:
    1 inch = 25.4 mm
- Examples:
    "600 x 600 mm" → "23.62 x 23.62 in"
    "1200 mm" → "47.24 in"
    "300x120 mm" → "11.81 x 4.72 in"
- US STANDARD UNITS (mandatory): Output every measurement in US units with the correct symbol.
    Temperature -> Fahrenheit: convert °C to °F (F = C*9/5+32), e.g. "-20°C to 45°C" -> "-4°F to 113°F". Always use the ° symbol and "F".
    Weight -> pounds: convert kg to lbs (1 kg = 2.20462 lbs), e.g. "6.5 kg" -> "14.33 lbs". Always end with " lbs".
    Length / dimensions -> inches (and feet where natural, e.g. "4'"): convert mm/cm (1 in = 25.4 mm). Use the " (inch) and ' (foot) symbols or "in".
    If a source value is already in US units, keep it and just fix the symbol/spacing.
- ACCURACY OVER COMPLETENESS (highest priority for technical values): For every TECHNICAL spec —
  electrical (voltage, current, power, wattage, power factor, THD), photometric (lumens, efficacy,
  CCT, CRI, R9, R13, beam angle, distribution, BUG), physical/rating (dimensions, weight, IP, IK,
  operating/storage temperature, suitable location, EPA, average life, warranty), and materials
  (housing, finish, driver, LED source, cover/lens, cover type) — you MUST copy the value from the
  vendor source. If the source does not state it, output exactly "Not Specified". NEVER infer,
  estimate, guess, or fill a plausible number for these fields — a wrong number is far worse than
  "Not Specified".
- Reasonable inference is allowed ONLY for the soft marketing fields: productDescription,
  productFeatures, and applicationAreas. Everything else must be verbatim from the source or
  "Not Specified".
- PRODUCT TYPE / CATEGORY (read the vendor, don't guess): identify the fixture type from the vendor's OWN naming —
  the product title, the section header, and the "type" line — and map it to the closest IKIO product family. IKIO's
  catalog (US market): COMMERCIAL/INDOOR = LED Tubes, Refrigeration Lights, Magnetic Strip Kits, Linear Low Bays,
  Troffers, Panel Lights, Downlights. INDUSTRIAL = Retrofit Lamps, High Bays, Flood Lights, Canopy Lights, High Mast
  Lights, Yard Lights, Area Luminaires, Wall Packs, Vapor Tight Lights, Street Lights, Wraparound Lights. HAZARDOUS
  LOCATION = Area Lights, Jelly Jar Lights, Drop Lights, High Bays. Use the vendor's exact type. In particular: a
  "High Mast Light" is high_mast (NOT flood/stadium); an "Area / Shoebox Light" is area (NOT flood); a "Wall Pack" is
  wall_pack; a "Yard Light" is yard, not flood. Only fall back to inferring from the specs when the vendor never
  names the type.
- NEVER put a vendor part number, model code, SKU, or series code (e.g. "PT02", "SS-PT02", "PT02-60W",
  "S0150") into Power, Lumen Output, Voltage, Current, Efficacy, technicalSpecs, variants, or
  variantOverview.matrix. Those fields must contain ONLY real measured values with units (W, lm, V, A, lm/W).
- WATTAGE / VALUE ACCURACY (critical): read every wattage, lumen, voltage and current EXACTLY as printed in the
  vendor's specification / model table. Never substitute, round, guess, or carry a value over from a different
  product, a different row, or the example in these instructions. If the model table lists 48W/60W/80W/100W/130W,
  the Power values MUST be exactly those — do NOT output 20W. Cross-check each wattage against ITS OWN row's lumen
  output and model number before writing it, and re-read the table if a value looks inconsistent.
- SELECTABLE WATTAGES: for multi-wattage fixtures, extract the FULL list of individual wattages and pair each
  with its lumen output — never a part number, never a single collapsed value. Example: source
  "WATTAGES: 60/50/40/30/20W" with lumens "8400/7000/5600/4200/2800 lm" -> Power "20W/30W/40W/50W/60W",
  Lumen Output "2800/4200/5600/7000/8400 lm", keeping the wattage<->lumen order aligned. If there are two
  wattage families (e.g. a 60W package and a 120W package), return one variant per family in variantOverview.matrix
  with that family's individual wattages in the Power cell.
- VARIANTS BY SIZE / ATTRIBUTE (predict this smartly): if the vendor's model list is grouped by a distinguishing
  attribute — SIZE (e.g. 11 inch vs 14 inch, 2FT vs 4FT, 6" vs 8"), DIAMETER, length, or series — and EACH group has
  its OWN set of wattages/lumens, create ONE variantOverview.matrix ROW PER GROUP. Put that group's OWN selectable
  wattage list in its Power cell, its OWN lumen list in Lumen Output, and the group's distinguishing label (e.g.
  "11 inch", "14 inch", "4FT") in the Fixture Type cell. NEVER merge different sizes' wattages into one row.
  Example — model numbers "N-AURA-11IN-{18,15,12,10}W" and "N-AURA-14IN-{32,28,24,18}W" become TWO rows:
  Fixture Type "11 inch", Power "10W/12W/15W/18W", Lumen "1000/1200/1500/1800 lm"; and Fixture Type "14 inch",
  Power "18W/24W/28W/32W", Lumen "1800/2400/2800/3200 lm". Read the model-number/size column to decide the groups.
- POWER-ADJUSTABLE PERCENTAGE STEPS (critical for field-adjustable fixtures): when the vendor says the fixture is
  power-adjustable / field-selectable in PERCENTAGE steps (e.g. "Power adjustable: 100%, 80%, 60%, 40%") AND the
  lumen table has MORE values than the named model wattages, the REAL selectable wattages are each model's max
  wattage multiplied by EACH percentage step. COMPUTE and list ALL of them (round to whole watts), aligned 1:1 with
  the lumen outputs in the same order. Example: a 180W model with steps 100/80/60/40% -> "180W/144W/108W/72W" paired
  with that model's four lumen values; a 400W model -> "400W/320W/240W/160W". Do NOT output only the 100% (highest)
  wattage when the lumen list clearly has one value per step — for every variant the Power list and the Lumen Output
  list MUST contain the SAME number of values, in the SAME order (one wattage per lumen).
- LUMEN OUTPUT — EXACT LIST, NOT A RANGE: Lumen Output must be the EXACT list of every individual lumen value, read
  from the vendor's model / output TABLE, aligned 1:1 with the Power list. NEVER output a "from X to Y", "X–Y", or
  "up to X" summary, and never take the lumen figure from a marketing sentence (e.g. "scalable from 6,600 to 61,000
  lumens" or "replaces up to 1000W") — always read the individual per-model / per-step lumen numbers from the table.
  If the table lists 6400/9300/12000/16000 lm for a model, output exactly those, not "6,400–16,000 lm".
- DISTINCT SIZES / LENGTHS (very important): if the fixture comes in multiple physical SIZES or LENGTHS and EACH
  size has its OWN single wattage and its OWN lumen output — common for tri-proof / linear / batten / strip / vapor-tight
  fixtures, e.g. 2ft/4ft/5ft (or 600mm/1200mm/1500mm) = 20W/36W/45W = 2600-2800lm / 4680-5040lm / 5850-6300lm — then
  create ONE variantOverview.matrix row PER SIZE. Put ONLY that size's single wattage in its Power cell, ONLY that size's
  own lumen output in its Lumen Output cell, and the size/length (e.g. "2FT (600mm)") in the Fixture Type cell. Read the
  vendor's per-model/per-length table row by row and match each length to its exact wattage and lumen. NEVER dump the
  combined list of all sizes' wattages or lumens into every row, and never repeat the same Power/Lumen on every row —
  each row must show only its own size's values.
- CCT / Color Temperature must contain ONLY Kelvin values (e.g. "3000K/4000K/5000K") — NEVER power (W),
  lumen, or "for X W" qualifiers. List each distinct CCT once.
- If a value is clearly selectable, format compactly, for example "20W/25W/30W" or "3000K/4000K/5000K".
- Keep descriptions and features grounded in the source PDF.
- productFeatures: return EXACTLY 4 features (no more, no fewer). Take the vendor's real features/specs and rewrite EACH as a complete, benefit-oriented sentence of about 100 characters (aim 90-115). NEVER return a bare fragment. Expand short bullets — e.g. source "Samsung 2835 chips" -> "Built with premium Samsung 2835 LED chips for consistent brightness and dependable long-term output." and "4KV surge protection" -> "Integrated 4 kV surge protection safeguards the driver against voltage spikes for reliable operation." Every claim must stay grounded in the source PDF.
- productDescription: write one concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value (400-450 characters). Ground it in the source PDF.
- orderingInfo: Fill EVERY column with at least one {code, description} option. If the vendor PDF has a part-number / ordering decoder, copy its exact codes and meanings for each field. If it does NOT, best-effort DERIVE options from the real specs: Power codes from the wattage packages, CCT codes from the color temperatures, Voltage from the input voltage, etc. Use short codes (e.g. "50K" for 5000K, "MV" for 120-277V, "WH" for White, "D" for Dimmable). Never leave orderingInfo empty.
- orderingExample: assemble one concrete example part number by joining one chosen code from each column with "-".
- accessories (CAPTURE EVERY ONE — this is a required, high-priority section): Read the vendor's
  Accessories / Optional / Options / Ordering / Mounting / Add-ons section ROW BY ROW and extract
  EVERY accessory as a SEPARATE item. Look under these headings in ANY language, e.g. "Accessories",
  "Optional", "Options", "Mounting", "Add-ons", and Chinese "配件" (accessories), "选配"/"选配件"
  (optional), "附件" (attachments), "安装" (mounting/installation). ALSO treat these as accessories
  even when they appear only as a spec/feature LINE rather than a table: mounting brackets / arms /
  slipfitters / trunnions / yokes / knuckles, poles, chain/pendant/surface mount KITS, photocells,
  occupancy / PIR / microwave / motion / daylight SENSORS, remote controllers, SURGE protectors,
  wire guards, glare shields / visors / louvers, and EMERGENCY BATTERY / backup kits. For each,
  copy the vendor's EXACT ordering/part code when printed (otherwise best-effort like "ACC-..." or
  "IK-ACC-...") and a short plain description of what it is. Do NOT skip rows, do NOT merge multiple
  accessories into one, and do NOT invent accessories the PDF doesn't list. Return [] ONLY when the
  PDF truly lists no accessories, options, sensors, mounts, or emergency/surge parts anywhere.
- dimensions: For each fixture size/variant, give a label and its width/height/depth in inches (convert mm using 1in=25.4mm, 2 decimals). Use "Not Specified" for any missing axis.
- extraTables: Capture any NOTABLE data TABLE in the vendor PDF that does NOT already map to the
  sections above (Overview/technicalSpecs, the specifications/variant matrix, orderingInfo,
  accessories, dimensions). Good candidates: a photometric / performance-data table (lumens per
  CCT and distribution), a lumen-multiplier or wattage-vs-output matrix, an operating-parameters
  table, a compatibility / control chart, a projected-life (L70/L80) table. For EACH such table
  return {title, headers:[...], rows:[[...]]} with the vendor's real cell values (verbatim; convert
  units to US where the value is a measurement). Return AT MOST 3 tables, each at most 12 columns
  and 40 rows. Do NOT duplicate the main specifications or ordering tables, and do NOT invent tables
  — return [] when the PDF has no such extra table.
- Finish Options (technicalSpecs): list EVERY available housing finish the vendor offers, joined with ", " — read the finish colour swatches AND any "available in ..." / "Finish:" sentence (e.g. "Black, Dark Bronze, Silver Gray, White"). If the vendor also names a coating/treatment (e.g. "corrosion-resistant powder coat"), append it after the colours. Capture ALL finishes, not just the first. Use "Not Specified" only when the PDF truly gives none.
- IKIO STANDARDS (how IKIO builds its finished TDS from a vendor sheet — follow these):
  * POWER COLUMN: the Power value MUST come from the vendor's Wattage/Power column — the actual
    wattage list (e.g. "25W-40W-50W-60W"). NEVER put the part/model number or a fragment of it in
    Power (e.g. never "60W-XXK G2", "EDI-UFO-60W"). The part number belongs in Fixture Type / Part
    Number, not Power. If a model row lists a selectable wattage range, put that whole range in Power.
  * PER-WATTAGE LUMENS: for each wattage/step, use the vendor's TESTED lumen value at the DEFAULT CCT
    (usually 4000K or 5000K), NOT a nominal/marketing "up to" number. Keep Power, Lumen Output and
    Efficacy positionally aligned and the SAME length (Nth power ↔ Nth lumen ↔ Nth efficacy).
  * LUMEN SANITY: lumen ≈ efficacy × watts. If a lumen is ~10x off from efficacy×watts (e.g. "1600"
    where "16000" matches), it is a dropped/added-zero — output the value consistent with efficacy×watts.
    If efficacy is a single figure and per-step lumens are missing, compute lumen = efficacy × watts.
  * SELECTABLE (one fixture switches wattage/CCT): list values ASCENDING (low→high). DISCRETE options
    (separate SKUs, voltages, beam angles): keep them as distinct options.
  * Values verbatim/units: Kelvin in full ("50k"→"5000K"); Suitable Location UPPERCASE (WET/DAMP/DRY);
    IP as "IP65"; IK as "IK09"; Average Life a plain number with comma ("50,000"); Warranty a plain
    number of years; Operating Temperature in °F; Voltage as "120-277V". NEVER invent a performance
    number to fit — use "Not Specified" when the PDF does not state it.
- Return JSON only.
"""

TECHNICAL_SPEC_ORDER = [
    "Product Type",
    "Power",
    "Voltage",
    "Current",
    "Power Factor",
    "THD",
    "Surge Protection",
    "Lumen Output",
    "Efficacy",
    "Color Temperature",
    "Color Rendering (CRI)",
    "R9 (Red Value)",
    "R13 (Skin Tones)",
    "Beam Angle",
    "Light Distribution",
    "BUG Rating",
    "IP Rating",
    "IK Rating",
    "Lifespan",
    "Warranty",
    "Operating Temperature",
    "Dimming",
    "Driver",
    "LED Source",
    "Housing Material",
    "Lens",
    "Mounting",
    "Certifications",
    "Protection Class",
    "Weight",
    "Dimensions",
    "Fixture Type",
    "EPA(Effective Protected area)",
    "Sensor Type",
    "Connectivity",
    "Color Options",
    "Finish Options",
    "Operating Humidity",
    "Storage Temperature",
    "Storage Humidity",
]

SPEC_ALIASES = {
    "product category": "Product Type",
    "fixture type": "Fixture Type",
    "wattage": "Power",
    "max power": "Power",
    "input voltage": "Voltage",
    "power factor": "Power Factor",
    "pf": "Power Factor",
    "lumens": "Lumen Output",
    "lumen": "Lumen Output",
    "efficiency": "Efficacy",
    "cct": "Color Temperature",
    "cri": "Color Rendering (CRI)",
    "color rendering index": "Color Rendering (CRI)",
    "beam spread": "Beam Angle",
    "lighting angle": "Beam Angle",
    "ip": "IP Rating",
    "ik": "IK Rating",
    "led type": "LED Source",
    "housing": "Housing Material",
    "mounting type": "Mounting",
    "finish": "Finish Options",
    "finish options": "Finish Options",
    "color options": "Color Options",
    "sensor": "Sensor Type",
}

PADDLE_OCR_INSTANCE = None
PADDLE_OCR_READY = None


def normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\x00", " ")).strip()


def canonical_parameter_name(value: str) -> str:
    clean = normalize_whitespace(value).strip(":")
    return SPEC_ALIASES.get(clean.lower(), clean)


def is_missing_value(value: str) -> bool:
    return normalize_whitespace(value).lower() in {"", "n/a", "na", "none", "-", "--", "not available"}


def title_case_words(value: str) -> str:
    return " ".join(part.capitalize() for part in normalize_whitespace(value).split(" "))


def infer_product_category(text: str) -> str:
    lower = text.lower()
    if "downlight" in lower:
        return "downlight"
    if "track" in lower:
        return "track"
    # High mast BEFORE flood/street — a high mast light is its own type, not a flood light.
    if "high mast" in lower or "high-mast" in lower or "highmast" in lower:
        return "high_mast"
    if "street" in lower or "roadway" in lower:
        return "street"
    if "flood" in lower:
        return "flood"
    if "high bay" in lower or "high-bay" in lower:
        return "high_bay"
    if "low bay" in lower or "low-bay" in lower:
        return "low_bay"
    if "linear" in lower or "pendant" in lower:
        return "linear"
    if "panel" in lower or "troffer" in lower:
        return "panel"
    return "unknown"


def get_paddle_ocr():
    global PADDLE_OCR_INSTANCE, PADDLE_OCR_READY

    if not ENABLE_PADDLE_OCR:
        return None

    if PADDLE_OCR_READY is not None:
        return PADDLE_OCR_INSTANCE

    try:
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR  # type: ignore

        PADDLE_OCR_INSTANCE = PaddleOCR(use_angle_cls=True, lang="en")
        PADDLE_OCR_READY = True
        return PADDLE_OCR_INSTANCE
    except Exception as exc:  # pragma: no cover - dependency may be absent locally
        print(f"PaddleOCR unavailable: {exc}", file=sys.stderr)
        PADDLE_OCR_INSTANCE = None
        PADDLE_OCR_READY = False
        return None


def pil_image_to_data_url(image) -> str:
    # High-quality JPEG keeps the high-resolution source pages small enough to hold in
    # memory (PNG at 3x would be many MB/page). Crops are captured from these at native
    # resolution, so q95 gives sharp crops with a manageable payload.
    buffer = io.BytesIO()
    rgb = image.convert("RGB") if image.mode not in ("RGB", "L") else image
    rgb.save(buffer, format="JPEG", quality=95)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def render_pdf_pages(pdf_path: str) -> list[dict[str, Any]]:
    source_pages: list[dict[str, Any]] = []
    pdf = pdfium.PdfDocument(pdf_path)

    try:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                width, height = page.get_size()
                bitmap = page.render(scale=PDF_RENDER_SCALE)
                try:
                    image = bitmap.to_pil()
                    source_pages.append(
                        {
                            "id": f"page-{index + 1}",
                            "page": index + 1,
                            "width": int(round(width)),
                            "height": int(round(height)),
                            "dataUrl": pil_image_to_data_url(image),
                        }
                    )
                finally:
                    bitmap.close()
            finally:
                page.close()
    finally:
        pdf.close()

    return source_pages


def _classify_vendor_image(image) -> str:
    """Heuristically label an embedded image as 'diagram' (line drawing / dimension figure),
    'badge' (small square certification icon / logo — DLC, IP65, UL, "3CCT SELECTABLE"...), or
    'photo' (a real product / accessory photo). Used to keep certification badges out of the
    suggestion picker and to sort diagrams vs photos per section."""
    from collections import Counter

    rgb = image.convert("RGB")
    width, height = rgb.size
    small = rgb.resize((48, 48))
    pixels = list(small.getdata())
    count = len(pixels) or 1
    mean_bright = sum(sum(p) for p in pixels) / (3 * count) / 255.0
    mean_sat = sum(0.0 if max(p) == 0 else (max(p) - min(p)) / max(p) for p in pixels) / count
    quant = Counter((p[0] // 32, p[1] // 32, p[2] // 32) for p in pixels)
    top_frac = quant.most_common(1)[0][1] / count
    aspect = (width / height) if height else 1.0
    max_dim = max(width, height)
    is_square = 0.6 <= aspect <= 1.7
    num_colours = len(quant)
    # Certification badge / brand logo — kept CONSERVATIVE so real accessory/mounting thumbnails
    # (metal brackets, sensors — which are textured, many-coloured) are NOT dropped. Only catch:
    #  - a small square that is VERY uniform / very flat (a true icon): 3CCT, IP65, UL, Photocell…
    #  - a FLAT logo (<=10 colours) that is very dark or very light: the black "UL CERTIFIED" mark
    #  - a highly SATURATED, limited-palette logo at any size: the red/blue "RZ" brand mark
    if (
        (is_square and max_dim < 300 and (top_frac > 0.6 or num_colours <= 16))
        or (is_square and num_colours <= 10 and (mean_bright < 0.35 or mean_bright > 0.94))
        or (mean_sat > 0.55 and num_colours < 26)
    ):
        return "badge"
    # Line-drawing dimension figure: mostly white with thin dark lines (near-grayscale), and large
    # or clearly wide/tall (not a small square icon).
    if mean_bright > 0.8 and mean_sat < 0.1 and (max_dim >= 360 or aspect > 1.6 or aspect < 0.62):
        return "diagram"
    return "photo"


def extract_embedded_images(pdf_path: str, max_pages: int = 16, max_images: int = 48) -> list[dict[str, Any]]:
    """Pull EVERY embedded raster image (product photos, accessory / mounting / dimension / photometric
    figures) out of the PDF across ALL pages so the editor can offer them as pickable thumbnails.
    Filters out only header banners, rules, tiny icons AND certification badges; de-dupes repeats.
    IDs are 'vendorimg-<kind>-<page>-<i>' so the UI treats them as a pickable LIBRARY (never auto-
    placed as the hero) and can sort diagrams vs photos per section."""
    from pypdfium2 import raw as pdfium_raw

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for index in range(min(max_pages, len(pdf))):
            page = pdf[index]
            try:
                try:
                    objects = list(page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE]))
                except Exception:
                    objects = []
                for obj_index, obj in enumerate(objects):
                    try:
                        bitmap = obj.get_bitmap(render=True)
                        image = bitmap.to_pil()
                    except Exception:
                        continue
                    width, height = image.size
                    if width < 56 or height < 56:
                        continue  # icons / bullets / certification marks
                    aspect = (width / height) if height else 99.0
                    if aspect > 6.5 or aspect < 0.16:
                        continue  # header banners, rules, thin colour strips
                    kind = _classify_vendor_image(image)
                    if kind == "badge":
                        continue  # certification icons are never useful as a product/accessory image
                    thumb = image.convert("RGB").resize((16, 16))
                    key = hashlib.md5(thumb.tobytes()).hexdigest()
                    if key in seen:
                        continue  # same logo/photo repeated across pages
                    seen.add(key)
                    if max(width, height) > 900:
                        scale = 900.0 / max(width, height)
                        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))))
                    results.append(
                        {
                            "id": f"vendorimg-{kind}-{index + 1}-{obj_index}",
                            "page": index + 1,
                            "width": image.width,
                            "height": image.height,
                            "dataUrl": pil_image_to_data_url(image.convert("RGB")),
                        }
                    )
                    if len(results) >= max_images:
                        return results
            finally:
                page.close()
    finally:
        pdf.close()
    return results


def extract_tables_from_page(page) -> list[str]:
    extracted_rows: list[str] = []
    for table in page.extract_tables():
        for row in table or []:
            if not row:
                continue
            cleaned = [normalize_whitespace(str(cell)) if cell else "" for cell in row]
            line = " | ".join(cleaned).strip(" |")
            if line:
                extracted_rows.append(line)
    return extracted_rows


def should_use_ocr(page_text: str, table_rows: list[str]) -> bool:
    dense_text = normalize_whitespace(page_text)
    alpha_count = len(re.findall(r"[A-Za-z0-9]", dense_text))
    # Run OCR when the page is image-heavy (little selectable text) OR when pdfplumber could not pull
    # a real table out of it (< 2 table rows). Many vendor SPEC TABLES are rendered as IMAGES, so
    # their values (THD, Surge Protection, IP, Operating Temperature, Warranty, Lifespan…) are absent
    # from both the text layer and pdfplumber — only OCR recovers them. This catches those pages even
    # when they also carry some marketing text.
    return alpha_count < 600 or len(table_rows) < 2


def get_doctr_model():
    """Lazily load the docTR OCR model once (heavy). Returns None if docTR isn't installed/usable."""
    global DOCTR_MODEL, DOCTR_READY
    if not ENABLE_DOCTR_OCR:
        return None
    if DOCTR_READY is not None:
        return DOCTR_MODEL
    try:
        from doctr.models import ocr_predictor  # type: ignore

        DOCTR_MODEL = ocr_predictor(pretrained=True)
        DOCTR_READY = True
    except Exception as exc:  # noqa: BLE001
        print(f"docTR unavailable: {exc}", file=sys.stderr)
        DOCTR_MODEL = None
        DOCTR_READY = False
    return DOCTR_MODEL


def run_doctr_ocr_on_page(pdf_path: str, page_index: int) -> str:
    """OCR a single PDF page with docTR (renders to a numpy image, keeps line structure)."""
    model = get_doctr_model()
    if model is None:
        return ""
    try:
        import numpy as np

        pdf = pdfium.PdfDocument(pdf_path)
        try:
            page = pdf[page_index]
            try:
                bitmap = page.render(scale=max(PDF_RENDER_SCALE, 1.8))
                try:
                    image = np.array(bitmap.to_pil().convert("RGB"))
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            pdf.close()
        result = model([image])
        return result.render() if hasattr(result, "render") else ""
    except Exception as exc:  # noqa: BLE001 - never fail extraction over OCR
        print(f"docTR OCR failed on page {page_index + 1}: {str(exc)[:150]}", file=sys.stderr)
        return ""


def run_ocr_on_page(pdf_path: str, page_index: int) -> str:
    """Run OCR on a page: docTR first (best on image spec tables), PaddleOCR as a fallback."""
    text = run_doctr_ocr_on_page(pdf_path, page_index)
    if normalize_whitespace(text):
        return text
    return run_paddle_ocr_on_page(pdf_path, page_index)


def _paddle_result_texts(results: Any) -> list[str]:
    """Pull recognized text out of a PaddleOCR result, supporting BOTH the new PP-OCRv5 predict()
    format (OCRResult with 'rec_texts') and the legacy ocr() format ([box, (text, conf)])."""
    lines: list[str] = []
    for res in results or []:
        texts = None
        try:  # new API: OCRResult is subscriptable
            texts = res["rec_texts"]
        except Exception:
            texts = res.get("rec_texts") if isinstance(res, dict) else None
        if texts is not None:
            for token in texts:
                token = normalize_whitespace(str(token))
                if token:
                    lines.append(token)
            continue
        # legacy API: iterable of [box, (text, conf)]
        try:
            for item in res or []:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    value = item[1]
                    token = normalize_whitespace(str(value[0] if isinstance(value, (list, tuple)) else value))
                    if token:
                        lines.append(token)
        except Exception:
            pass
    return lines


def run_paddle_ocr_on_page(pdf_path: str, page_index: int) -> str:
    ocr = get_paddle_ocr()
    if ocr is None:
        return ""

    # Render the page to a NUMPY array — current PaddleOCR rejects PIL images ("Only numpy.ndarray
    # and str are supported"), which silently returned nothing before.
    try:
        import numpy as np

        pdf = pdfium.PdfDocument(pdf_path)
        try:
            page = pdf[page_index]
            try:
                bitmap = page.render(scale=max(PDF_RENDER_SCALE, 1.8))
                try:
                    image = np.array(bitmap.to_pil().convert("RGB"))
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            pdf.close()
    except Exception as exc:  # noqa: BLE001 - never fail extraction over a render error
        print(f"OCR render failed on page {page_index + 1}: {exc}", file=sys.stderr)
        return ""

    # Try the new predict() API first, then the legacy ocr(); fail gracefully if the paddle build is
    # broken on this host (e.g. a Windows oneDNN issue) so extraction still completes.
    results = None
    for method in ("predict", "ocr"):
        call = getattr(ocr, method, None)
        if call is None:
            continue
        try:
            results = call(image)
            break
        except Exception as exc:  # noqa: BLE001
            print(f"PaddleOCR .{method}() failed on page {page_index + 1}: {str(exc)[:120]}", file=sys.stderr)
            results = None
    if results is None:
        return ""
    try:
        return "\n".join(_paddle_result_texts(results))
    except Exception:  # noqa: BLE001
        return ""


def extract_text_from_pdf(pdf_path: str) -> tuple[str, list[str]]:
    text_parts: list[str] = []
    notes: list[str] = []

    with pdfplumber.open(pdf_path) as pdf:
        for index, page in enumerate(pdf.pages):
            page_text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            table_rows = extract_tables_from_page(page)
            ocr_text = ""

            if should_use_ocr(page_text, table_rows):
                ocr_text = run_ocr_on_page(pdf_path, index)
                if ocr_text:
                    notes.append(f"Used OCR on vendor page {index + 1}.")

            page_chunks = [chunk for chunk in [page_text, "\n".join(table_rows), ocr_text] if normalize_whitespace(chunk)]
            if page_chunks:
                text_parts.append(f"[PAGE {index + 1}]\n" + "\n\n".join(page_chunks))

    return "\n\n".join(text_parts), notes


def format_beam_angle(value: str) -> str:
    text = normalize_whitespace(value)
    if not text:
        return "Not Specified"

    text = re.sub(r"(?i)\bdegrees?\b", "°", text)
    text = re.sub(r"(?i)\bdeg\b", "°", text)
    text = re.sub(r"(\d)\s*°\s*", r"\1°", text)
    text = re.sub(r"(\d)\s*[dD](?![A-Za-z])", r"\1°", text)
    text = re.sub(r"\s*/\s*", "/", text)
    text = re.sub(r"\s*\|\s*", " | ", text)
    return text


def convert_mm_to_inches(text):
    if not text or text == "Not Specified":
        return text

    def mm_to_in(val):
        return round(float(val) / 25.4, 2)

    pattern = re.findall(r'(\d+\.?\d*)\s*[xX]\s*(\d+\.?\d*)\s*mm', text)
    if pattern:
        vals = pattern[0]
        return f"{mm_to_in(vals[0])} x {mm_to_in(vals[1])} in"

    pattern = re.findall(r'(\d+\.?\d*)\s*mm', text)
    if pattern:
        return f"{mm_to_in(pattern[0])} in"

    pattern = re.findall(r'Ø\s*(\d+\.?\d*)\s*mm', text)
    if pattern:
        return f"Ø{mm_to_in(pattern[0])} in"

    return text

def fix_dimensions_in_json(data):
    for item in data.get("technicalSpecs", []):
        if item["parameter"].lower() == "dimensions":
            item["specification"] = convert_mm_to_inches(item["specification"])
    return data


def normalize_temperature_value(value: str) -> str:
    text = normalize_whitespace(value)
    if not text:
        return "Not Specified"

    text = re.sub(r"(?i)\bdeg(?:ree)?s?\s*f\b", "°F", text)
    text = re.sub(r"(?i)\bdeg(?:ree)?s?\s*c\b", "°C", text)
    text = re.sub(r"(?i)(-?\d+(?:\.\d+)?)\s*f\b", r"\1°F", text)
    text = re.sub(r"(?i)(-?\d+(?:\.\d+)?)\s*c\b", r"\1°C", text)
    text = re.sub(r"\s*~\s*", " to ", text)
    text = re.sub(r"(?<!\d)-\s+(\d)", r"-\1", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)

    # US standard: convert every Celsius reading to Fahrenheit (F = C*9/5 + 32).
    def _c_to_f(match: "re.Match[str]") -> str:
        celsius = float(match.group(1))
        return f"{round(celsius * 9 / 5 + 32)}°F"

    text = re.sub(r"(-?\d+(?:\.\d+)?)\s*°?\s*C\b", _c_to_f, text)
    return text


def normalize_weight_value(value: str) -> str:
    """US standard: convert kilograms/grams to pounds and normalize the 'lbs' unit."""
    text = normalize_whitespace(value)
    if not text:
        return "Not Specified"

    def _kg_to_lbs(match: "re.Match[str]") -> str:
        return f"{round(float(match.group(1)) * 2.20462, 2)} lbs"

    def _g_to_lbs(match: "re.Match[str]") -> str:
        return f"{round(float(match.group(1)) * 0.00220462, 2)} lbs"

    text = re.sub(r"(?i)(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b", _kg_to_lbs, text)
    text = re.sub(r"(?i)(\d+(?:\.\d+)?)\s*(?:grams?|gm)\b", _g_to_lbs, text)
    text = re.sub(r"(?i)(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b", r"\1 lbs", text)
    return normalize_whitespace(text)


def normalize_unit_spacing(value: str) -> str:
    text = normalize_whitespace(value)
    if not text:
        return "Not Specified"

    replacements = [
        (r"(?i)(\d)\s*lm\s*/\s*w", r"\1 lm/W"),
        (r"(?i)(\d)\s*lm\b", r"\1 lm"),
        (r"(?i)(\d)\s*v\b", r"\1 V"),
        (r"(?i)(\d)\s*vac\b", r"\1 VAC"),
        (r"(?i)(\d)\s*a\b", r"\1 A"),
        (r"(?i)(\d)\s*k\b", r"\1K"),
        (r"(?i)(\d)\s*years?\b", r"\1 Years"),
        (r"(?i)(\d)\s*hours?\b", r"\1 Hours"),
        (r"\s*/\s*", "/"),
        (r"\s*-\s*", " - "),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    return normalize_whitespace(text)


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        normalized = normalize_whitespace(value)
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(normalized)
    return ordered


def normalize_color_temperature_value(value: str) -> str:
    # CCT must contain ONLY color temperatures. Extract every "<digits>K" token and drop any
    # power/lumen/other content that leaked in (e.g. "40W/60W: 3000K-4000K" -> "3000K/4000K/5000K").
    kelvin_tokens: list[str] = []
    for number in re.findall(r"(?i)(\d{3,5})\s*k\b", value or ""):
        token = f"{number}K"
        if token not in kelvin_tokens:
            kelvin_tokens.append(token)
    return "/".join(kelvin_tokens) if kelvin_tokens else "Not Specified"


def infer_length_feet_label(value: str) -> str:
    text = normalize_whitespace(value)
    if not text or text.lower() == "not specified":
        return "Not Specified"

    feet_match = re.search(r"(?i)\b(\d+(?:\.\d+)?)\s*['f]?\s*x\s*(\d+(?:\.\d+)?)\s*['f]?\b", text)
    if feet_match:
        length_ft = max(float(feet_match.group(1)), float(feet_match.group(2)))
        return f"{int(length_ft) if length_ft.is_integer() else round(length_ft, 2)} FT"

    inches_match = re.search(
        r"(?i)\b(\d+(?:\.\d+)?)\s*(?:in|inch|inches)\s*x\s*(\d+(?:\.\d+)?)\s*(?:in|inch|inches)\b",
        text,
    )
    if inches_match:
        length_ft = max(float(inches_match.group(1)), float(inches_match.group(2))) / 12
        normalized_length = int(length_ft) if length_ft.is_integer() else round(length_ft, 2)
        return f"{normalized_length} FT"

    panel_code_match = re.search(r"(?i)\bP(\d{1,2})\b", text)
    if panel_code_match:
        return f"{int(panel_code_match.group(1))} FT"

    return text


def strip_catalog_code(value: str) -> str:
    """Remove leaked vendor part-number / model-code prefixes, per line, so an electrical
    value never shows a SKU fragment. 'PT02-60W' -> '60W', '02-120W' -> '120W'. A real range
    like '20-60W' (starts with a normal digit, no letter, no leading zero) is left intact."""
    cleaned_lines = []
    for line in str(value).split("\n"):
        cleaned_lines.append(
            re.sub(r"^\s*(?:[A-Za-z][A-Za-z0-9]*|0\d+)\s*[-–]\s*", "", line).strip()
        )
    return "\n".join(cleaned_lines)


def normalize_spec_value(parameter: str, value: str) -> str:
    text = normalize_unit_spacing(value)
    if parameter == "Color Temperature":
        return normalize_color_temperature_value(text)
    if parameter == "Beam Angle":
        return format_beam_angle(text)
    if "Temperature" in parameter:
        return normalize_temperature_value(text)
    if parameter == "Weight":
        return normalize_weight_value(text)
    if parameter in ("Power", "Lumen Output", "Current", "Efficacy"):
        text = strip_catalog_code(text)
    return text


def normalize_technical_specs(specs: Any) -> list[dict[str, str]]:
    if not isinstance(specs, list):
        specs = []

    normalized_map: dict[str, str] = {}
    extras: list[dict[str, str]] = []

    for item in specs:
        if not isinstance(item, dict):
            continue

        raw_parameter = str(item.get("parameter", ""))
        raw_value = str(item.get("specification", ""))
        parameter = canonical_parameter_name(raw_parameter)
        if not parameter:
            continue

        specification = normalize_spec_value(parameter, raw_value)
        if is_missing_value(specification):
            specification = "Not Specified"

        if parameter in TECHNICAL_SPEC_ORDER:
            if parameter not in normalized_map or normalized_map[parameter] == "Not Specified":
                normalized_map[parameter] = specification
        else:
            extras.append({"parameter": parameter, "specification": specification})

    ordered = [
        {"parameter": parameter, "specification": normalized_map.get(parameter, "Not Specified")}
        for parameter in TECHNICAL_SPEC_ORDER
    ]
    return ordered + extras


def normalize_string_list(value: Any, fallback: str, max_items: int) -> list[str]:
    if not isinstance(value, list):
        value = []

    items = [normalize_whitespace(str(item)) for item in value if normalize_whitespace(str(item))]
    if not items:
        items = [fallback]
    return items[:max_items]


def normalize_variant_overview(value: Any) -> dict[str, list[Any]]:
    if not isinstance(value, dict):
        return {"parameters": ["Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"], "matrix": []}

    parameters = value.get("parameters")
    matrix = value.get("matrix")

    normalized_parameters = (
        [normalize_whitespace(str(item)) for item in parameters if normalize_whitespace(str(item))]
        if isinstance(parameters, list)
        else []
    )
    normalized_matrix = (
        [
            [normalize_whitespace(str(cell)) for cell in row]
            for row in matrix
            if isinstance(row, list) and any(normalize_whitespace(str(cell)) for cell in row)
        ]
        if isinstance(matrix, list)
        else []
    )

    if not normalized_parameters:
        normalized_parameters = ["Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"]

    return repair_variant_overview({"parameters": normalized_parameters, "matrix": normalized_matrix})


def is_power_value(value: str) -> bool:
    text = str(value)
    if not re.search(r"(?i)\b\d+(?:\.\d+)?\s*(?:w|watt|watts)\b", text):
        return False
    # A CLEAN power cell is only wattage tokens + separators (and words like max/typical). Reject a
    # part-number / catalog string that merely CONTAINS a wattage, e.g. "60W-XXK G2" — otherwise the
    # column repair can pick the part-number column as Power. Remove the wattage tokens and any
    # allowed words, then require no stray letters remain.
    residue = re.sub(r"(?i)\d+(?:\.\d+)?\s*(?:watts?|w)\b", " ", text)
    residue = re.sub(r"(?i)\b(?:max|maximum|typ|typical|nominal|selectable|per|and|to)\b", " ", residue)
    residue = re.sub(r"(?i)[^a-z]", "", residue)
    return residue == ""


def clean_power_cell(value: str) -> str:
    """Keep only the wattage tokens in a Power cell (hyphen-joined), dropping any leaked model / CCT
    code — "60W-XXK G2" -> "60W", "25W-40W-50W-60W" unchanged, "70W / 100W" -> "70W-100W". Preserves
    multiple lines (one per size)."""
    out_lines: list[str] = []
    for line in str(value).split("\n"):
        watts = re.findall(r"(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b", line, re.I)
        if watts:
            norm: list[str] = []
            for raw in watts:
                num = raw[:-2] if raw.endswith(".0") else raw
                token = f"{num}W"
                if token not in norm:
                    norm.append(token)
            out_lines.append("-".join(norm))
        else:
            out_lines.append(line.strip())
    return "\n".join(out_lines)


def is_lumen_value(value: str) -> bool:
    # Match lumens ("3000 lm") but NOT efficacy ("130 lm/W" / "lm/ft"), so the column repair can't
    # mistake the Efficacy column for Lumen Output (which swapped the two).
    return bool(re.search(r"(?i)\b\d[\d,]*(?:\.\d+)?\s*lm\b(?!\s*/\s*(?:w|ft))", value))


def is_efficacy_value(value: str) -> bool:
    return bool(re.search(r"(?i)\b\d[\d,]*(?:\.\d+)?\s*lm\s*/\s*(?:w|ft)\b", value))


def is_cct_value(value: str) -> bool:
    return bool(re.search(r"(?i)\b\d{3,5}\s*k\b", value))


def score_column(values: list[str], matcher) -> int:
    return sum(1 for value in values if matcher(value))


def pick_best_column(rows: list[list[str]], remaining_indexes: set[int], matcher) -> int | None:
    best_index = None
    best_score = 0
    for index in remaining_indexes:
        column_values = [row[index] if index < len(row) else "" for row in rows]
        score = score_column(column_values, matcher)
        if score > best_score:
            best_score = score
            best_index = index
    return best_index if best_score > 0 else None


def column_matches_expected(rows: list[list[str]], index: int | None, matcher) -> bool:
    if index is None:
        return False
    values = [row[index] if index < len(row) else "" for row in rows]
    populated_values = [value for value in values if value]
    if not populated_values:
        return False
    return score_column(populated_values, matcher) >= max(1, len(populated_values) // 2)


def repair_variant_overview(variant_overview: dict[str, list[Any]]) -> dict[str, list[Any]]:
    parameters = [normalize_whitespace(str(item)) for item in variant_overview.get("parameters", [])]
    matrix = [
        [normalize_whitespace(str(cell)) for cell in row]
        for row in variant_overview.get("matrix", [])
        if isinstance(row, list)
    ]

    if not parameters or not matrix:
        return {"parameters": parameters, "matrix": matrix}

    normalized_params = [canonical_parameter_name(item) for item in parameters]
    has_label = any(param.lower() == "label" for param in normalized_params)
    has_fixture = any(param == "Fixture Type" for param in normalized_params)
    has_power = any(param == "Power" for param in normalized_params)
    has_lumens = any(param == "Lumen Output" for param in normalized_params)
    has_cct = any(param in {"CCT", "Color Temperature"} for param in normalized_params)
    has_efficacy = any(param == "Efficacy" for param in normalized_params)
    power_index = next((i for i, param in enumerate(normalized_params) if param == "Power"), None)
    lumen_index = next((i for i, param in enumerate(normalized_params) if param == "Lumen Output"), None)
    cct_index = next((i for i, param in enumerate(normalized_params) if param in {"CCT", "Color Temperature"}), None)
    efficacy_index = next((i for i, param in enumerate(normalized_params) if param == "Efficacy"), None)

    if (
        has_power
        and has_lumens
        and has_cct
        and has_efficacy
        and (has_fixture or has_label)
        and column_matches_expected(matrix, power_index, is_power_value)
        and column_matches_expected(matrix, lumen_index, is_lumen_value)
        and column_matches_expected(matrix, cct_index, is_cct_value)
        and column_matches_expected(matrix, efficacy_index, is_efficacy_value)
    ):
        return {"parameters": parameters, "matrix": matrix}

    max_columns = max(len(row) for row in matrix)
    padded_rows = [row + [""] * (max_columns - len(row)) for row in matrix]
    remaining_indexes = set(range(max_columns))

    assignments: dict[str, int] = {}

    for key, matcher in [
        ("Power", is_power_value),
        ("Lumen Output", is_lumen_value),
        ("CCT", is_cct_value),
        ("Efficacy", is_efficacy_value),
    ]:
        index = pick_best_column(padded_rows, remaining_indexes, matcher)
        if index is not None:
            assignments[key] = index
            remaining_indexes.remove(index)

    preferred_label_index = next(
        (
            index
            for index, param in enumerate(normalized_params)
            if index in remaining_indexes and param.lower() in {"label", "fixture type"}
        ),
        None,
    )

    if preferred_label_index is not None:
        assignments["Fixture Type"] = preferred_label_index
        remaining_indexes.remove(preferred_label_index)
    elif remaining_indexes:
        first_remaining = min(remaining_indexes)
        assignments["Fixture Type"] = first_remaining
        remaining_indexes.remove(first_remaining)

    ordered_parameters = [key for key in ["Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"] if key in assignments]
    repaired_matrix = []
    for row in padded_rows:
        normalized_row = [row[assignments[key]] if assignments[key] < len(row) else "" for key in ordered_parameters]
        if "Fixture Type" in ordered_parameters:
            fixture_index = ordered_parameters.index("Fixture Type")
            normalized_row[fixture_index] = infer_length_feet_label(normalized_row[fixture_index])
        repaired_matrix.append(normalized_row)

    return {"parameters": ordered_parameters, "matrix": repaired_matrix}


def _pl_nums(cell: Any, unit_re: str) -> list[float]:
    """Ordered numeric tokens from a Power/Lumen/Efficacy cell — first the ones carrying the unit,
    else any bare numbers (the cell is already that single quantity's column)."""
    text = str(cell)
    toks = re.findall(unit_re, text, re.I)
    if not toks:
        toks = re.findall(r"\d[\d,]*(?:\.\d+)?", text)
    out: list[float] = []
    for tok in toks:
        try:
            out.append(float(str(tok).replace(",", "")))
        except ValueError:
            pass
    return out


def _pl_sep(cell: Any) -> str:
    text = str(cell)
    if "\n" in text:
        return "\n"
    if "|" in text:
        return " | "
    if "/" in text:
        return "/"
    return "-"  # IKIO selectable default


def repair_power_lumen_efficacy(variant_overview: dict[str, Any]) -> dict[str, Any]:
    """Deterministic backstop (no model): keep Power ↔ Lumen ↔ Efficacy consistent per step, since
    lumen ≈ watts × efficacy. Fixes dropped/added-zero lumen errors (e.g. 1600 where 16000 fits) and
    fills a genuinely missing lumen from watts × efficacy. Only acts when watts AND a PLAUSIBLE
    efficacy (40–260 lm/W) are present, and never overrides a lumen that already matches — so real
    tested values are left untouched."""
    params = variant_overview.get("parameters", []) or []
    matrix = variant_overview.get("matrix", []) or []
    if "Power" not in params or "Lumen Output" not in params or "Efficacy" not in params:
        return variant_overview
    pi, li, ei = params.index("Power"), params.index("Lumen Output"), params.index("Efficacy")
    for row in matrix:
        if not isinstance(row, list) or max(pi, li, ei) >= len(row):
            continue
        watts = _pl_nums(row[pi], r"(\d+(?:\.\d+)?)\s*w\b")
        lumens = _pl_nums(row[li], r"(\d[\d,]*(?:\.\d+)?)\s*lm\b(?!\s*/)")
        effs = _pl_nums(row[ei], r"(\d+(?:\.\d+)?)\s*lm\s*/\s*w")
        if not watts:
            continue
        if len(effs) == 1 and len(watts) > 1:
            effs = effs * len(watts)  # one efficacy applies to every step
        count = len(watts)
        new_lumens: list[float | None] = list(lumens) + [None] * max(0, count - len(lumens))
        changed = False
        for i in range(count):
            watt = watts[i]
            eff = effs[i] if i < len(effs) else None
            if eff is None or not (40 <= eff <= 260) or not (1 <= watt <= 4000):
                continue
            expected = watt * eff
            actual = new_lumens[i] if i < len(new_lumens) else None
            if actual is None or actual <= 0:
                new_lumens[i] = round(expected)
                changed = True
                continue
            ratio = actual / expected if expected else 0
            if 0.06 < ratio < 0.16:       # dropped a zero (~ /10)
                new_lumens[i] = round(actual * 10)
                changed = True
            elif 6 < ratio < 16:          # extra zero (~ x10)
                new_lumens[i] = round(actual / 10)
                changed = True
            # otherwise keep the extracted (tested) lumen — it is close enough or not a clear error
        if changed:
            vals = [v for v in new_lumens[:count] if v is not None]
            if vals:
                row[li] = _pl_sep(row[li]).join(f"{int(round(v))}lm" for v in vals)
    return variant_overview


def derive_variant_overview(technical_specs: list[dict[str, str]], current: dict[str, Any]) -> dict[str, Any]:
    return repair_power_lumen_efficacy(_derive_variant_overview_impl(technical_specs, current))


def _reconcile_selectable_lumens(variant_overview: dict[str, Any], technical_specs: list[dict[str, str]]) -> dict[str, Any]:
    """For a SINGLE selectable row, the structured matrix Lumen is often botched by the model
    (a value dropped/duplicated/out of order), while the flat technicalSpecs "Lumen Output" list is
    correct. If the flat list has exactly one lumen per wattage, all distinct and ascending (matching
    the ascending wattages), rebuild the matrix Lumen from it."""
    params = variant_overview.get("parameters", []) or []
    matrix = variant_overview.get("matrix", []) or []
    if len(matrix) != 1 or "Power" not in params or "Lumen Output" not in params:
        return variant_overview
    row = matrix[0]
    power_i, lumen_i = params.index("Power"), params.index("Lumen Output")
    if not isinstance(row, list) or max(power_i, lumen_i) >= len(row):
        return variant_overview
    watts = re.findall(r"(?i)\d+(?:\.\d+)?\s*(?:w|watt|watts)\b", str(row[power_i]))
    if len(watts) < 2:
        return variant_overview
    lookup = {item.get("parameter"): item.get("specification") for item in technical_specs}
    flat = re.findall(r"(?i)\d[\d,]*(?:\.\d+)?\s*lm\b", str(lookup.get("Lumen Output", "")))
    nums: list[float] = []
    for token in flat:
        try:
            nums.append(float(re.sub(r"[^\d.]", "", token)))
        except ValueError:
            pass
    if len(nums) == len(watts) and len(set(nums)) == len(nums) and nums == sorted(nums):
        row[lumen_i] = "-".join(f"{int(round(n))}lm" for n in nums)
    return variant_overview


def _derive_variant_overview_impl(technical_specs: list[dict[str, str]], current: dict[str, Any]) -> dict[str, Any]:
    variant_overview = normalize_variant_overview(current.get("variantOverview"))
    if variant_overview["matrix"]:
        # Scrub SKU / model-code fragments from the Power column (index 2) that feeds the spec
        # table, keeping only the wattage tokens (e.g. "60W-XXK G2" -> "60W").
        params = variant_overview.get("parameters", [])
        power_idx = params.index("Power") if "Power" in params else 2
        for row in variant_overview["matrix"]:
            if isinstance(row, list) and len(row) > power_idx:
                row[power_idx] = clean_power_cell(strip_catalog_code(str(row[power_idx])))
        # Safety net for the "repeated list" extraction error: if every row carries the SAME
        # Power AND Lumen (index 3) — i.e. the combined list was pasted onto each size — collapse
        # to a single row so the overview doesn't show the identical line N times.
        matrix = variant_overview["matrix"]
        lumen_idx = params.index("Lumen Output") if "Lumen Output" in params else 3
        def _cell(row: list, idx: int) -> str:
            return str(row[idx]).strip() if isinstance(row, list) and len(row) > idx else ""
        if len(matrix) > 1 and all(
            _cell(row, power_idx) == _cell(matrix[0], power_idx)
            and _cell(row, lumen_idx) == _cell(matrix[0], lumen_idx)
            for row in matrix
        ):
            variant_overview["matrix"] = [matrix[0]]
        variant_overview = _reconcile_selectable_lumens(variant_overview, technical_specs)
        return variant_overview

    lookup = {item["parameter"]: item["specification"] for item in technical_specs}
    power_lines = [strip_catalog_code(line.strip()) for line in re.split(r"[\r\n]+", lookup.get("Power", "")) if line.strip()]
    lumen_lines = [line.strip() for line in re.split(r"[\r\n]+", lookup.get("Lumen Output", "")) if line.strip()]
    cct = lookup.get("Color Temperature", "Not Specified")
    efficacy = lookup.get("Efficacy", "Not Specified")
    fixture_type = lookup.get("Fixture Type", "Not Specified")

    if len(power_lines) <= 1 and len(lumen_lines) <= 1:
        return variant_overview

    max_rows = max(len(power_lines), len(lumen_lines))
    matrix = []
    for index in range(max_rows):
        matrix.append(
            [
                f"Variant {index + 1}",
                infer_length_feet_label(fixture_type) if index == 0 else "See Source PDF",
                power_lines[index] if index < len(power_lines) else "Not Specified",
                lumen_lines[index] if index < len(lumen_lines) else "Not Specified",
                cct,
                efficacy,
            ]
        )

    return {
        "parameters": ["Label", "Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"],
        "matrix": matrix,
    }


def normalize_variants(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized_variants: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        normalized_item = dict(item)
        if "fixtureType" in normalized_item:
            normalized_item["fixtureType"] = infer_length_feet_label(str(normalized_item.get("fixtureType", "")))
        if "cct" in normalized_item:
            normalized_item["cct"] = normalize_color_temperature_value(str(normalized_item.get("cct", "")))
        for code_field in ("power", "lumenOutput"):
            if code_field in normalized_item:
                normalized_item[code_field] = strip_catalog_code(str(normalized_item[code_field]))
        normalized_variants.append(normalized_item)
    return normalized_variants


def normalize_vendor_info(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        value = {}
    return {
        "vendorName": normalize_whitespace(str(value.get("vendorName", ""))) or "Not Specified",
        "vendorContact": normalize_whitespace(str(value.get("vendorContact", ""))) or "Not Specified",
    }


def ensure_json_string(content: str) -> str:
    json_str = content.strip()
    if json_str.startswith("```"):
        json_str = re.sub(r"^```(?:json)?\n?", "", json_str)
        json_str = re.sub(r"\n?```$", "", json_str)
    return json_str.strip()


def get_available_ollama_models() -> list[str]:
    response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=15)
    response.raise_for_status()
    payload = response.json()

    models = payload.get("models", [])
    if not isinstance(models, list):
        return []

    available: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        name = normalize_whitespace(str(item.get("name", "")))
        if name:
            available.append(name)
    return available


def resolve_ollama_model() -> str:
    available_models = get_available_ollama_models()
    if not available_models:
        raise RuntimeError(
            f"No Ollama models are available at {OLLAMA_URL}. Pull a model such as '{OLLAMA_MODEL}' first."
        )

    if OLLAMA_MODEL in available_models:
        return OLLAMA_MODEL

    fallback_model = available_models[0]
    print(
        f"Configured Ollama model '{OLLAMA_MODEL}' is unavailable; using installed model '{fallback_model}' instead.",
        file=sys.stderr,
    )
    return fallback_model


def call_ollama(document_text: str) -> dict[str, Any]:
    model_name = resolve_ollama_model()
    user_message = build_user_message(document_text)

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
    }

    response = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT_SECONDS)
    response.raise_for_status()

    result = response.json()

    content = result.get("message", {}).get("content", "")
    return json.loads(ensure_json_string(content))


# ---- Vendor-pattern learning ------------------------------------------------
# The "Training Data/<Vendor>/" folders each hold a real Vendor.pdf (+ its IKIO TDS). We learn a
# lightweight PROFILE per vendor (which fields/tables that vendor provides + how to recognize them),
# cache it to disk, and — when an uploaded PDF matches a known vendor — inject that profile into the
# extraction prompt so the model extracts EVERY detail that vendor is known to include.
TRAINING_DIR = os.environ.get(
    "TRAINING_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Training Data")
).strip()

# (label shown to the model, [keywords/hints to look for in the vendor text, any language])
_VENDOR_FIELD_HINTS: list[tuple[str, list[str]]] = [
    ("Power / Wattage", ["watt", "power", "功率"]),
    ("Voltage", ["voltage", "vac", "120-277", "347", "电压"]),
    ("Current", ["current", "amp", "电流"]),
    ("Power Factor", ["power factor", "功率因数", "pf>"]),
    ("THD", ["thd", "harmonic", "总谐波"]),
    ("Surge Protection", ["surge", "kv", "浪涌"]),
    ("Lumen Output", ["lumen", "流明"]),
    ("Efficacy", ["lm/w", "efficacy", "光效"]),
    ("CCT (selectable)", ["cct", "kelvin", "3000k", "3cct", "5cct", "色温", "selectable"]),
    ("CRI", ["cri", "显色", " ra"]),
    ("Beam Angle", ["beam", "光束角"]),
    ("Light Distribution / IES type", ["distribution", "type iii", "type v", " ies"]),
    ("Dimming", ["dimming", "0-10v", "dali", "triac", "调光"]),
    ("Operating Temperature", ["operating temp", "ambient", "工作温度"]),
    ("IP Rating", ["ip6", "ip5", "ingress", "防护"]),
    ("IK Rating", ["ik0", "ik1", "impact"]),
    ("Lifespan (L70)", ["l70", "50000", "50,000", "lifespan", "寿命"]),
    ("Warranty", ["warranty", "质保", "year warranty"]),
    ("Driver", ["driver", "isolated", "驱动"]),
    ("Housing / Finish", ["housing", "finish", "powder", "外壳", "die-cast"]),
    ("EPA", ["epa", "effective projected"]),
    ("BUG Rating", ["bug ", "backlight", "uplight"]),
    ("Dimensions", ["dimension", "diameter", "尺寸", "mm)"]),
    ("Certifications", ["dlc", "etl", " ul ", "cul", "rohs", "fcc"]),
]
_VENDOR_CUE_HINTS: list[tuple[str, list[str]]] = [
    ("power/CCT is field-SELECTABLE (switchable) — capture every selectable step", ["selectable", "switchable", "adjustable", "switch", "可调"]),
    ("has an ORDERING / part-number decoder — capture every column & code", ["ordering", "how to order", "part number", "order example", "catalog"]),
    ("lists ACCESSORIES / mounting / sensor options — capture each one", ["accessor", "mounting", "bracket", "sensor", "photocell", "配件", "选配"]),
    ("has a PHOTOMETRIC / performance-data table — capture it as an extra table", ["photometric", "performance data", "lumen output table", "光度"]),
    ("offers an EMERGENCY battery / backup option", ["emergency", "battery backup"]),
    ("Zhaga / DALI / 0-10V controls present", ["zhaga", "dali", "0-10v"]),
    ("multiple SIZES / models with their own wattage-lumen sets", ["model", "size", "series"]),
]

_vendor_profiles_cache: list[dict[str, Any]] | None = None


def _vendor_match_tokens(vendor: str, text: str) -> list[str]:
    tokens: set[str] = set()
    for word in re.split(r"[\s/&-]+", vendor):
        if len(word) >= 3:
            tokens.add(word.lower())
    low = text.lower()
    for domain in re.findall(r"\b([a-z0-9][a-z0-9-]{2,}\.(?:com|net|cn|tech|co))\b", low):
        tokens.add(domain)
    for host in re.findall(r"[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})", low):
        tokens.add(host)
    # Distinctive model prefixes (e.g. MAL08, XCLA, SB08) — uppercase-run + digits.
    for model in re.findall(r"\b([A-Z]{2,}[A-Z0-9]{0,6}\d{1,4})\b", text):
        if len(model) >= 4:
            tokens.add(model.lower())
    return sorted(tokens)[:40]


def _summarize_vendor_format(text: str) -> str:
    low = f" {text.lower()} "
    fields = [label for label, keys in _VENDOR_FIELD_HINTS if any(k in low for k in keys)]
    cues = [note for note, keys in _VENDOR_CUE_HINTS if any(k in low for k in keys)]
    parts: list[str] = []
    if fields:
        parts.append("Fields this vendor typically provides: " + ", ".join(fields) + ".")
    if cues:
        parts.append("Notable patterns: " + "; ".join(cues) + ".")
    return " ".join(parts)


def _build_or_load_vendor_profile(vendor: str, vendor_dir: str) -> dict[str, Any] | None:
    cache_path = os.path.join(vendor_dir, ".profile.json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as handle:
                data = json.load(handle)
            if data.get("matchTokens"):
                return data
        except Exception:
            pass
    vendor_pdf = os.path.join(vendor_dir, "Vendor.pdf")
    if not os.path.exists(vendor_pdf):
        return None
    # FAST text-only read (pdfplumber, no OCR/tables) — profiles only need labels/tokens, and this
    # keeps profile-building quick so the first extraction isn't blocked. Cached to .profile.json.
    text = ""
    try:
        with pdfplumber.open(vendor_pdf) as pdf:
            text = "\n".join((page.extract_text() or "") for page in pdf.pages[:8])
    except Exception:
        text = ""
    if not normalize_whitespace(text):
        return None
    profile = {
        "vendor": vendor,
        "matchTokens": _vendor_match_tokens(vendor, text),
        "hints": _summarize_vendor_format(text),
    }
    try:
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(profile, handle, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return profile


# Prebuilt, COMMITTED store so profiles load instantly and work on the VPS (which has no Training
# Data PDFs). Rebuilt from the PDFs only when this file is missing (local dev), then written here.
PROFILE_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor_profiles.json")


def _load_vendor_profiles() -> list[dict[str, Any]]:
    global _vendor_profiles_cache
    if _vendor_profiles_cache is not None:
        return _vendor_profiles_cache
    # 1) Fast path — the committed prebuilt store (no PDFs needed).
    if os.path.exists(PROFILE_STORE):
        try:
            with open(PROFILE_STORE, encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list) and data:
                _vendor_profiles_cache = data
                print(f"[vendor-profiles] loaded {len(data)} profile(s) from store", flush=True)
                return data
        except Exception:
            pass
    # 2) Build from the Training Data folder (local dev), then persist the store.
    profiles: list[dict[str, Any]] = []
    base = os.path.abspath(TRAINING_DIR)
    if os.path.isdir(base):
        for vendor in sorted(os.listdir(base)):
            vendor_dir = os.path.join(base, vendor)
            if not os.path.isdir(vendor_dir):
                continue
            try:
                profile = _build_or_load_vendor_profile(vendor, vendor_dir)
            except Exception as exc:
                print(f"[vendor-profiles] skip {vendor}: {exc}", flush=True)
                profile = None
            if profile:
                profiles.append(profile)
        try:
            with open(PROFILE_STORE, "w", encoding="utf-8") as handle:
                json.dump(profiles, handle, ensure_ascii=False, indent=2)
        except Exception:
            pass
    _vendor_profiles_cache = profiles
    print(f"[vendor-profiles] built {len(profiles)} learned vendor profile(s)", flush=True)
    return profiles


def detect_vendor_profile(document_text: str) -> dict[str, Any] | None:
    """Return the best-matching learned vendor profile for this upload, or None."""
    low = f" {document_text.lower()} "
    best: dict[str, Any] | None = None
    best_score = 0
    for profile in _load_vendor_profiles():
        score = 0
        for token in profile.get("matchTokens", []):
            if not token:
                continue
            # Domains/emails/models are strong signals; a generic short word is weak.
            weight = 3 if ("." in token or any(ch.isdigit() for ch in token)) else 1
            if token in low:
                score += weight
        if score > best_score:
            best_score, best = score, profile
    # Require a reasonably confident match (a domain/model hit, or several word hits).
    return best if best_score >= 3 else None


def build_user_message(document_text: str) -> str:
    profile = detect_vendor_profile(document_text)
    learned = ""
    if profile and normalize_whitespace(profile.get("hints", "")):
        learned = (
            f"\nLEARNED VENDOR PROFILE — this looks like a {profile['vendor']} spec sheet, a vendor "
            f"format we have seen before. {profile['hints']} Extract EVERY one of these fields and "
            f"tables that appears in THIS document, using this vendor's own terminology and layout; "
            f"do not miss a section this vendor is known to include. Still read only THIS document's "
            f"values — never carry values over from another sheet.\n"
        )
    return f"""Analyze this vendor lighting specification sheet content.

Source-first instructions:
- Understand the vendor PDF before mapping fields.
- Preserve fixture-specific availability and power/lumen relationships.
- Use the vendor product family/title, cleaned but not creatively renamed.
- Use only supported claims from the source text.
{learned}
Vendor source text:
{document_text[:MAX_PROMPT_CHARS]}
"""


def call_groq(document_text: str) -> dict[str, Any]:
    if not GROQ_API_KEY:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Export GROQ_API_KEY (get a free key at https://console.groq.com/keys) "
            "or set LLM_PROVIDER=ollama to use a local model."
        )

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_message(document_text)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }

    response = requests.post(
        f"{GROQ_URL}/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        timeout=GROQ_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    result = response.json()
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    return json.loads(ensure_json_string(content))


# Gemini's free-tier / preview models intermittently return 429 (rate limit) or 503 (overloaded).
# Retry those (and other transient 5xx) a few times with exponential backoff before giving up.
GEMINI_MAX_RETRIES = int(os.environ.get("GEMINI_MAX_RETRIES", "4").strip())
_GEMINI_TRANSIENT_STATUS = {429, 500, 502, 503, 504}
# When the primary model stays overloaded (503) through all retries, fail over to a sibling model.
# Google overloads specific model endpoints independently, so a healthy sibling usually succeeds.
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in os.environ.get("GEMINI_FALLBACK_MODELS", "gemini-flash-lite-latest,gemini-3-flash-preview").split(",")
    if m.strip()
]


def _gemini_post(url: str, payload: dict[str, Any]) -> requests.Response:
    """POST to Gemini, retrying transient 429/5xx with exponential backoff (1s, 2s, 4s, 8s…)."""
    last_error: Exception | None = None
    for attempt in range(1, GEMINI_MAX_RETRIES + 1):
        response = requests.post(
            url,
            json=payload,
            headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
            timeout=GEMINI_TIMEOUT_SECONDS,
        )
        if response.status_code not in _GEMINI_TRANSIENT_STATUS:
            response.raise_for_status()
            return response
        last_error = requests.HTTPError(
            f"{response.status_code} {response.reason} for url: {url}", response=response
        )
        if attempt < GEMINI_MAX_RETRIES:
            wait = min(2 ** (attempt - 1), 8)
            print(
                f"[gemini] {response.status_code} on attempt {attempt}/{GEMINI_MAX_RETRIES}; "
                f"retrying in {wait}s",
                flush=True,
            )
            time.sleep(wait)
    assert last_error is not None
    raise last_error


def _source_pages_to_image_parts(source_pages: list[dict[str, Any]] | None, max_pages: int) -> list[dict[str, Any]]:
    """Convert rendered page data-URLs into Gemini inline_data image parts (for multimodal analysis)."""
    parts: list[dict[str, Any]] = []
    for page in (source_pages or [])[: max(0, max_pages)]:
        data_url = str(page.get("dataUrl", ""))
        if not data_url.startswith("data:") or "," not in data_url:
            continue
        header, _, b64 = data_url.partition(",")
        if not b64:
            continue
        mime = "image/jpeg"
        if ";" in header:
            candidate = header[5:].split(";", 1)[0]
            if candidate:
                mime = candidate
        parts.append({"inline_data": {"mime_type": mime, "data": b64}})
    return parts


def _gemini_generate(
    system_prompt: str,
    user_message: str,
    image_parts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Export GEMINI_API_KEY (get a key at "
            "https://aistudio.google.com/apikey) and set LLM_PROVIDER=gemini."
        )
    user_parts: list[dict[str, Any]] = [{"text": user_message}]
    if image_parts:
        # Text first, then the page images, so the model reads the extracted text and the visuals together.
        user_parts.extend(image_parts)
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": user_parts}],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }
    # Try the configured model first, then fail over to siblings on sustained transient errors.
    models = [GEMINI_MODEL] + [m for m in GEMINI_FALLBACK_MODELS if m != GEMINI_MODEL]
    last_error: Exception | None = None
    for index, model in enumerate(models):
        url = f"{GEMINI_URL}/models/{model}:generateContent"
        try:
            response = _gemini_post(url, payload)
        except requests.HTTPError as exc:
            last_error = exc
            status = exc.response.status_code if exc.response is not None else None
            if status in _GEMINI_TRANSIENT_STATUS and index < len(models) - 1:
                print(
                    f"[gemini] model '{model}' failed ({status}) after retries; "
                    f"failing over to '{models[index + 1]}'",
                    flush=True,
                )
                continue
            raise
        data = response.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {str(data)[:300]}")
        parts = candidates[0].get("content", {}).get("parts", [])
        content = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        return json.loads(ensure_json_string(content))
    assert last_error is not None
    raise last_error


def call_gemini(document_text: str, source_pages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    image_parts = (
        _source_pages_to_image_parts(source_pages, LLM_VISION_MAX_PAGES)
        if (LLM_VISION and source_pages)
        else None
    )
    if image_parts:
        print(f"[gemini] multimodal extraction with {len(image_parts)} page image(s)", flush=True)
    return _gemini_generate(SYSTEM_PROMPT, build_user_message(document_text), image_parts)


def _gemini_edit_image(image_b64: str, mime_type: str, prompt: str) -> tuple[str, str]:
    """Edit an image with Gemini's image model. Returns (base64_data, mime_type) of the result."""
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Export GEMINI_API_KEY (get a key at "
            "https://aistudio.google.com/apikey) and set LLM_PROVIDER=gemini."
        )
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": mime_type or "image/png", "data": image_b64}},
                ],
            }
        ],
    }
    # Try the configured image model first, then fail over to siblings on sustained transient errors.
    models = [GEMINI_IMAGE_MODEL] + [m for m in GEMINI_IMAGE_FALLBACK_MODELS if m != GEMINI_IMAGE_MODEL]
    last_error: Exception | None = None
    for index, model in enumerate(models):
        url = f"{GEMINI_URL}/models/{model}:generateContent"
        has_next = index < len(models) - 1
        try:
            response = _gemini_post(url, payload)
        except requests.HTTPError as exc:
            last_error = exc
            status = exc.response.status_code if exc.response is not None else None
            if status in _GEMINI_TRANSIENT_STATUS and has_next:
                print(f"[gemini] image model '{model}' failed ({status}); failing over to '{models[index + 1]}'", flush=True)
                continue
            raise
        data = response.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        for part in parts:
            if not isinstance(part, dict):
                continue
            inline = part.get("inlineData") or part.get("inline_data")
            if isinstance(inline, dict) and inline.get("data"):
                out_mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                return str(inline["data"]), str(out_mime)
        # No image from this model — try the next one, else surface any text it returned.
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        last_error = RuntimeError(f"'{model}' returned no image. {text[:200]}".strip())
        if has_next:
            print(f"[gemini] image model '{model}' returned no image; trying '{models[index + 1]}'", flush=True)
            continue
        raise last_error
    assert last_error is not None
    raise last_error


def _gemini_annotate_image(image_b64: str, mime_type: str, prompt: str) -> list[dict[str, Any]]:
    """Use the VISION-capable TEXT model (not image-generation) to locate each text label the
    instruction targets and compute its replacement. Returns a list of
    {original, replacement, box:[ymin,xmin,ymax,xmax] (0-1000)} so the frontend can overlay the
    change on the canvas. Works on the standard text quota — no image-generation quota needed."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set.")
    system = (
        "You are editing text on a product / technical image (often a dimension drawing). Look at the image "
        "and find EVERY text label that the user's instruction asks to change. For EACH one, return an object with: "
        '"original" (the exact text as printed), "replacement" (the new text after applying the instruction — '
        "compute unit conversions precisely: inches->mm multiply by 25.4, mm->inches divide by 25.4, keep 0-2 "
        'decimals and include the unit symbol), and "box" ([ymin,xmin,ymax,xmax] as integers 0-1000 normalized to '
        "the image size, fitted tightly around that text). Preserve any leading symbol like Ø. Return ONLY JSON: "
        '{"edits": [...]}. If nothing matches the instruction, return {"edits": []}. '
        f"Instruction: {prompt}"
    )
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": system},
                    {"inline_data": {"mime_type": mime_type or "image/png", "data": image_b64}},
                ],
            }
        ],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }
    models = [GEMINI_MODEL] + [m for m in GEMINI_FALLBACK_MODELS if m != GEMINI_MODEL]
    last_error: Exception | None = None
    for index, model in enumerate(models):
        url = f"{GEMINI_URL}/models/{model}:generateContent"
        try:
            response = _gemini_post(url, payload)
        except requests.HTTPError as exc:
            last_error = exc
            status = exc.response.status_code if exc.response is not None else None
            if status in _GEMINI_TRANSIENT_STATUS and index < len(models) - 1:
                continue
            raise
        parts = (response.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        content = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        parsed = json.loads(ensure_json_string(content))
        raw_edits = parsed.get("edits") if isinstance(parsed, dict) else None
        edits: list[dict[str, Any]] = []
        if isinstance(raw_edits, list):
            for entry in raw_edits:
                if not isinstance(entry, dict):
                    continue
                box = entry.get("box")
                if not (isinstance(box, list) and len(box) == 4):
                    continue
                try:
                    ymin, xmin, ymax, xmax = (float(v) for v in box)
                except (TypeError, ValueError):
                    continue
                replacement = normalize_whitespace(str(entry.get("replacement", "")))
                if not replacement:
                    continue
                edits.append({
                    "original": normalize_whitespace(str(entry.get("original", ""))),
                    "replacement": replacement,
                    "box": [ymin, xmin, ymax, xmax],
                })
        return edits
    assert last_error is not None
    raise last_error


REVIEW_SYSTEM_PROMPT ="""You are a senior QA reviewer for IKIO lighting technical data sheets.
You receive (1) the vendor source text and (2) a first-pass JSON extraction of it. Cross-check the
extraction against the source like a careful human would, then return a CORRECTED JSON with the
EXACT same keys/structure.

Fix these problems specifically:
- CONTRADICTIONS: any value that conflicts with productDescription or with other fields. Example:
  Power shows "02-60W" (a catalog/part-number fragment) but the description says selectable "20W to 120W" —
  the real selectable wattages are correct; replace the fragment with "20W/.../120W".
- SKU LEAKAGE: Power, Lumen Output, Voltage, Current, Efficacy must be real measured values, NEVER
  catalog/part-number codes (e.g. "PT02", "S0150", "02", "PTO2-60W"). Strip any code fragments.
- SELECTABLE PACKAGES: when a fixture offers multiple wattages/lumens/CCTs, format compactly like
  "20W/60W/120W" and keep the power<->lumen relationship intact.
- POWER<->LUMEN COUNT (selectable packages ONLY): when ONE fixture offers a selectable RANGE of wattages that
  map 1:1 to a range of lumens, the Power cell must list the same number of values as the Lumen Output cell,
  aligned in order. If Lumen Output has more values than Power (e.g. 4 lumens but 1 wattage), find or COMPUTE the
  full wattage list and expand Power to match: if the source states power-adjustable PERCENTAGE steps (e.g. "Power
  adjustable: 100%, 80%, 60%, 40%"), the wattages are the model's max wattage times each step (180W -> 180/144/108/72W),
  one per lumen value, in the same order. Never leave Power as just the single highest value when the lumen list is longer.
- LUMEN OUTPUT MUST BE EXACT (not a range): if Lumen Output is a "from X to Y", "X-Y", or "up to X" summary (often
  copied from a marketing line), that is WRONG — re-read the vendor's per-model output table and replace it with the
  EXACT list of individual lumen values, one per wattage, aligned in order. Lumen Output must never be a 2-value range
  when the fixture actually has many discrete lumen packages.
- DISTINCT SIZES / LENGTHS (do NOT expand or merge): if each variantOverview.matrix row is a different physical
  SIZE / LENGTH with its OWN single wattage (e.g. row1 2FT=20W, row2 4FT=36W, row3 5FT=45W), KEEP each row's single
  wattage and that size's own lumen(s). Do NOT expand a size's single wattage into the full list, and do NOT merge
  sizes together.
- REPEATED VARIANT ROWS (wrong — fix it): if EVERY variantOverview.matrix row has the SAME Power and the SAME
  Lumen Output (the combined list of all variants repeated on each row), that is an extraction error. Re-read the
  vendor's per-model/per-length table and split it so each row shows ONLY its own size/length's specific wattage
  and lumen, matched from the source.
- MISSING VALUES that clearly appear in the source text.
- US UNITS with symbols: temperature in °F, weight in lbs, dimensions in inches.
Keep every value that is already correct — only change what is wrong or missing. Return JSON only."""


def _ollama_chat_json(system_prompt: str, user_message: str) -> dict[str, Any]:
    payload = {
        "model": resolve_ollama_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
    }
    response = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT_SECONDS)
    response.raise_for_status()
    content = response.json().get("message", {}).get("content", "")
    return json.loads(ensure_json_string(content))


def _llm_chat_json(system_prompt: str, user_message: str) -> dict[str, Any]:
    """Single JSON chat completion via the active provider, falling back to local Ollama."""
    if LLM_PROVIDER in ("gemini", "groq"):
        try:
            if LLM_PROVIDER == "gemini":
                return _gemini_generate(system_prompt, user_message)
            payload = {
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            }
            response = requests.post(
                f"{GROQ_URL}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                timeout=GROQ_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            content = response.json().get("choices", [{}])[0].get("message", {}).get("content", "")
            return json.loads(ensure_json_string(content))
        except Exception as exc:  # noqa: BLE001
            if not LLM_FALLBACK_OLLAMA:
                # Let the caller (best-effort reviewer) skip rather than stall on a missing Ollama.
                raise
            print(f"[review] {LLM_PROVIDER} failed ({str(exc)[:120]}); using local Ollama for review.", flush=True)
    return _ollama_chat_json(system_prompt, user_message)


def review_extraction(raw_result: dict[str, Any], source_text: str) -> dict[str, Any]:
    """Second 'reviewer agent' pass: cross-check the first extraction against the source and
    correct contradictions/SKU-leakage/units. Falls back to the first result on any failure."""
    if os.environ.get("ENABLE_REVIEW", "1").strip().lower() not in ("1", "true", "yes", "on"):
        return raw_result
    try:
        user_message = (
            "Vendor source text:\n"
            f"{source_text[:MAX_PROMPT_CHARS]}\n\n"
            "First-pass extraction JSON to review and correct:\n"
            f"{json.dumps(raw_result, ensure_ascii=False)[:20000]}\n\n"
            "Return the corrected JSON with the same structure."
        )
        reviewed = _llm_chat_json(REVIEW_SYSTEM_PROMPT, user_message)
        if isinstance(reviewed, dict) and (reviewed.get("productName") or reviewed.get("technicalSpecs")):
            # Merge so any key the reviewer dropped falls back to the first pass.
            return {**raw_result, **reviewed}
    except Exception as exc:  # noqa: BLE001 - reviewer is best-effort
        print(f"[review] skipped: {exc}", flush=True)
    return raw_result


def call_llm(document_text: str, source_pages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    try:
        if LLM_PROVIDER == "gemini":
            return call_gemini(document_text, source_pages)
        if LLM_PROVIDER == "groq":
            return call_groq(document_text)
        return call_ollama(document_text)
    except Exception as exc:  # noqa: BLE001 - resilience: never hard-fail if a fallback exists
        if LLM_PROVIDER != "ollama" and LLM_FALLBACK_OLLAMA:
            print(
                f"[llm] provider '{LLM_PROVIDER}' failed ({str(exc)[:160]}); falling back to local Ollama.",
                flush=True,
            )
            return call_ollama(document_text)
        if LLM_PROVIDER != "ollama":
            # No silent Ollama fallback — surface the real provider error so the cause
            # (bad API key, wrong model id, quota/timeout) is visible to the user.
            print(f"[llm] provider '{LLM_PROVIDER}' failed: {str(exc)[:300]}", flush=True)
            raise RuntimeError(f"{LLM_PROVIDER} extraction failed: {str(exc)[:300]}") from exc
        raise


ORDERING_FIELD_KEYS = [
    "Brand",
    "Family/Version",
    "Size",
    "Power",
    "Voltage",
    "Dimming",
    "CCT",
    "Distribution",
    "Driver",
    "Finish",
    "Manufacturer",
]


def _clean_code_entries(entries: Any) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict):
                code = normalize_whitespace(str(entry.get("code", "")))
                desc = normalize_whitespace(str(entry.get("description", "")))
            elif isinstance(entry, str):
                code, desc = normalize_whitespace(entry), ""
            else:
                continue
            if code or desc:
                cleaned.append({"code": code, "description": desc})
    return cleaned


def normalize_ordering_info(value: Any) -> dict[str, list[dict[str, str]]]:
    src = value if isinstance(value, dict) else {}
    return {key: _clean_code_entries(src.get(key)) for key in ORDERING_FIELD_KEYS}


def normalize_accessories(value: Any) -> list[dict[str, str]]:
    return _clean_code_entries(value)[:15]


# Spec parameters whose VALUES are, in practice, orderable accessories/options rather than a
# fixed attribute of the fixture. Used only as a backstop when the model returns no accessories.
_ACCESSORY_PARAM_HINTS = (
    "accessor", "optional", "options", "add-on", "add on",
    "sensor", "occupancy", "photocell", "daylight", "motion", "pir", "microwave",
    "emergency", "battery", "backup", "surge", "wire guard", "guard", "glare shield",
    "shield", "slipfitter", "slip fitter", "trunnion", "yoke", "visor", "louver", "louvre",
    "bracket", "mount", "pole", "arm", "adapter", "remote", "controller",
)
# Values that are the fixture's own fixed attribute, NOT an orderable accessory.
_NON_ACCESSORY_VALUES = {
    "surface", "recessed", "surface mounted", "recessed mounted", "pendant", "suspended",
    "wall", "ceiling", "not specified", "n/a", "na", "none", "no", "yes", "standard", "-",
}
# Parameters to skip even if they contain a hint word (they are electrical/optical, not parts).
_ACCESSORY_PARAM_BLOCK = ("dimming", "driver", "input", "voltage", "control gear", "control:", "cct", "current")


def _accessory_code_from_desc(desc: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", desc.upper())
    slug = "-".join(words[:3]) if words else "ITEM"
    return f"ACC-{slug}"[:26]


def backfill_accessories_from_specs(
    accessories: list[dict[str, str]],
    technical_specs: list[dict[str, str]],
    category_specs: list[dict[str, str]],
) -> list[dict[str, str]]:
    """If the model captured no accessories, recover them from accessory-type spec lines
    (mounting kits, sensors, emergency battery, surge protector, guards, etc.). Conservative:
    it only runs when the model returned nothing, and skips electrical/optical parameters."""
    result = list(accessories or [])
    if len(result) >= 1:
        return result[:15]  # trust the model's list when it found anything
    seen: set[str] = set()
    for spec in list(technical_specs or []) + list(category_specs or []):
        param = normalize_whitespace(str(spec.get("parameter", "")))
        param_l = param.lower()
        value = normalize_whitespace(str(spec.get("specification", "")))
        if not value:
            continue
        if any(block in param_l for block in _ACCESSORY_PARAM_BLOCK):
            continue
        if not any(hint in param_l for hint in _ACCESSORY_PARAM_HINTS):
            continue
        for piece in re.split(r"\s*[,/;]\s*|\s+and\s+|\s*\|\s*", value):
            piece = normalize_whitespace(piece)
            low = piece.lower().strip(".")
            if len(piece) < 3 or low in _NON_ACCESSORY_VALUES:
                continue
            key = low
            if key in seen:
                continue
            seen.add(key)
            # Keep the parameter name for context unless the piece already reads like a part.
            part_words = ("sensor", "battery", "surge", "bracket", "mount", "guard", "shield",
                          "pole", "remote", "kit", "adapter", "photocell", "controller",
                          "emergency", "slipfitter", "trunnion", "visor", "louver", "louvre")
            desc = piece if any(w in low for w in part_words) else f"{param}: {piece}"
            result.append({"code": _accessory_code_from_desc(desc), "description": desc})
            if len(result) >= 12:
                return result
    return result[:15]


def normalize_extra_tables(value: Any) -> list[dict[str, Any]]:
    """Clean the model's extraTables into [{title, headers:[str], rows:[[str]]}], capped so a stray
    huge table can't bloat the payload. Drops empty tables and pads/truncates rows to the header count."""
    if not isinstance(value, list):
        return []
    tables: list[dict[str, Any]] = []
    for entry in value[:3]:
        if not isinstance(entry, dict):
            continue
        title = normalize_whitespace(str(entry.get("title", ""))) or "Additional Data"
        headers = [normalize_whitespace(str(h)) for h in (entry.get("headers") or []) if isinstance(entry.get("headers"), list)][:12]
        headers = [h for h in headers if h]
        raw_rows = entry.get("rows") or []
        rows: list[list[str]] = []
        if isinstance(raw_rows, list):
            col_count = len(headers) if headers else 0
            for raw_row in raw_rows[:40]:
                if not isinstance(raw_row, list):
                    continue
                cells = [normalize_whitespace(str(c)) for c in raw_row][:12]
                if col_count:
                    cells = (cells + [""] * col_count)[:col_count]
                if any(cells):
                    rows.append(cells)
        if not headers and rows:
            headers = [f"Column {i + 1}" for i in range(len(rows[0]))]
        if headers and rows:
            tables.append({"title": title, "headers": headers, "rows": rows})
    return tables


def normalize_dimensions_list(value: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if isinstance(value, list):
        for entry in value:
            if not isinstance(entry, dict):
                continue
            row = {
                "label": normalize_whitespace(str(entry.get("label", ""))),
                "width": normalize_whitespace(str(entry.get("width", ""))),
                "height": normalize_whitespace(str(entry.get("height", ""))),
                "depth": normalize_whitespace(str(entry.get("depth", ""))),
            }
            if any(row.values()):
                result.append(row)
    return result[:8]


def derive_name_from_text(source_text: str) -> str:
    """Best-effort vendor name: the first prominent, title-like line of the source."""
    for raw in (source_text or "").splitlines():
        line = normalize_whitespace(raw)
        if not line or line.upper().startswith("[PAGE"):
            continue
        letters = sum(1 for ch in line if ch.isalpha())
        if 3 <= len(line) <= 60 and letters >= 3:
            return line
    return ""


def post_process_extraction(model_output: dict[str, Any], source_text: str, source_pages: list[dict[str, Any]], notes: list[str]) -> dict[str, Any]:
    technical_specs = normalize_technical_specs(model_output.get("technicalSpecs"))

    product_name = (
        normalize_whitespace(str(model_output.get("productName", "")))
        or derive_name_from_text(source_text)
        or "Unknown Product"
    )
    alternate_name = normalize_whitespace(str(model_output.get("alternateName", ""))) or "Not Specified"
    description = normalize_whitespace(str(model_output.get("productDescription", ""))) or "Not Specified"
    category = normalize_whitespace(str(model_output.get("productCategory", ""))) or infer_product_category(source_text)

    payload = {
        "productName": product_name,
        "alternateName": alternate_name,
        "productDescription": description,
        "productFeatures": normalize_string_list(model_output.get("productFeatures"), "See source vendor PDF for product features.", 4),
        "applicationAreas": normalize_string_list(model_output.get("applicationAreas"), "General commercial lighting", 6),
        "productCategory": category,
        "subCategory": normalize_whitespace(str(model_output.get("subCategory", ""))),
        "isProductFamily": bool(model_output.get("isProductFamily", False)),
        "orderingInfo": normalize_ordering_info(model_output.get("orderingInfo")),
        "orderingExample": normalize_whitespace(str(model_output.get("orderingExample", ""))),
        "accessories": normalize_accessories(model_output.get("accessories")),
        "dimensions": normalize_dimensions_list(model_output.get("dimensions")),
        "extraTables": normalize_extra_tables(model_output.get("extraTables")),
        "technicalSpecs": technical_specs,
        "categorySpecificSpecs": normalize_technical_specs(model_output.get("categorySpecificSpecs")),
        "notes": normalize_string_list(model_output.get("notes"), "Generated from vendor PDF source.", 8) + notes,
        "vendorInfo": normalize_vendor_info(model_output.get("vendorInfo")),
        "sourceImages": [],
        "sourcePages": source_pages,
        # Raw extracted PDF text (capped) so the editor can flag which values are
        # actually grounded in the vendor source.
        "sourceText": (source_text or "")[:60000],
        "variants": normalize_variants(model_output.get("variants")),
    }

    # Backstop: if the model returned no accessories, recover them from accessory-type spec lines
    # (mounting kits, sensors, emergency battery, surge protector, guards) so a vendor's optional
    # parts still reach the sheet even when they weren't printed as a tidy accessories table.
    payload["accessories"] = backfill_accessories_from_specs(
        payload["accessories"], payload["technicalSpecs"], payload["categorySpecificSpecs"],
    )

    payload["variantOverview"] = derive_variant_overview(technical_specs, model_output)
    return payload


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


AI_DESCRIPTION_SYSTEM = (
    'You write IKIO lighting PRODUCT DESCRIPTIONS. Return ONLY JSON: {"text": "..."}. '
    "Write one concise paragraph covering what the product is, where it is used, its main performance "
    "or design advantage, and its broader project value (400-450 characters). Ground it in the provided specs. "
    "Do NOT restate specific numeric spec values that already appear on the sheet (power, lumens, CCT, voltage, "
    "current, efficacy, CRI, IP/IK rating, lifespan, warranty) — describe benefits, use cases and value "
    "qualitatively instead of repeating the numbers. Use US terminology: always say 'power', never 'wattage'. "
    "Do not invent unsupported claims and never include vendor part numbers. Follow the user's instruction."
)
AI_FEATURES_SYSTEM = (
    'You write IKIO lighting product FEATURES. Return ONLY JSON: {"features": ["...", "...", "...", "..."]}. '
    "Exactly 4 benefit-oriented sentences, each about 100 characters (90-115), grounded in the provided specs. "
    "Do NOT restate specific numeric spec values already listed on the sheet (power, lumens, CCT, voltage, "
    "efficacy, CRI, IP/IK rating, lifespan) — focus on what each feature does for the user, not the raw numbers. "
    "Use US terminology: always say 'power', never 'wattage'. No part numbers, no bare fragments. "
    "Follow the user's instruction."
)


@app.route("/ai-content", methods=["POST"])
def ai_content():
    """Generate/rewrite the Product Description or Features from a user-editable prompt."""
    data = request.get_json(silent=True) or {}
    kind = str(data.get("kind", "description")).strip().lower()
    instruction = normalize_whitespace(str(data.get("instruction", "")))
    product = data.get("product") if isinstance(data.get("product"), dict) else {}

    context_lines = []
    for label, key in (
        ("Product name", "name"),
        ("Category", "category"),
        ("Sub-category", "subCategory"),
        ("Key specs", "specs"),
        ("Current text", "current"),
    ):
        value = normalize_whitespace(str(product.get(key, "")))
        if value:
            context_lines.append(f"{label}: {value}")
    context = "\n".join(context_lines) or "No additional context provided."

    is_features = kind == "features"
    system_prompt = AI_FEATURES_SYSTEM if is_features else AI_DESCRIPTION_SYSTEM
    default_instruction = (
        "Write 4 strong, benefit-oriented feature bullets."
        if is_features
        else "One concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value (400-450 characters)."
    )
    user_message = f"{instruction or default_instruction}\n\nProduct context:\n{context}"

    try:
        out = _llm_chat_json(system_prompt, user_message)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "AI generation failed", "detail": str(exc)[:200]}), 502

    if is_features:
        raw = out.get("features") if isinstance(out, dict) else None
        features = (
            [normalize_whitespace(str(item)) for item in raw if isinstance(item, str) and str(item).strip()][:4]
            if isinstance(raw, list)
            else []
        )
        return jsonify({"features": features})

    text = normalize_whitespace(str(out.get("text", "")) if isinstance(out, dict) else "")
    return jsonify({"text": text})


@app.route("/ai-image-edit", methods=["POST"])
def ai_image_edit():
    """Edit a product image from a natural-language prompt (e.g. convert mm dimensions to inches).
    Accepts {imageDataUrl, prompt} and returns {dataUrl} with the edited image."""
    data = request.get_json(silent=True) or {}
    data_url = str(data.get("imageDataUrl", "")).strip()
    prompt = normalize_whitespace(str(data.get("prompt", "")))

    if not data_url.startswith("data:") or "," not in data_url:
        return jsonify({"error": "imageDataUrl must be a base64 data URL"}), 400
    if not prompt:
        return jsonify({"error": "A prompt describing the edit is required"}), 400
    if LLM_PROVIDER != "gemini":
        return jsonify({"error": "AI image edit requires LLM_PROVIDER=gemini"}), 400

    header, b64 = data_url.split(",", 1)
    mime_type = "image/png"
    if header.startswith("data:") and ";" in header:
        mime_type = header[len("data:"):header.index(";")] or "image/png"

    instruction = (
        "You are editing a product / technical image for a lighting spec sheet. Apply ONLY the "
        "requested change and preserve the product, framing, layout, colours and background exactly. "
        "Do not add, remove or restyle anything you were not asked to. Keep all other text identical. "
        f"Requested change: {prompt}"
    )
    try:
        out_b64, out_mime = _gemini_edit_image(b64, mime_type, instruction)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status == 429:
            return jsonify({
                "error": "Image model rate limit",
                "detail": (
                    "All Gemini image models are rate-limited (429) — your API key's image-generation "
                    "quota is exhausted. Wait for the quota to reset (per-minute limits clear quickly; "
                    "the free daily limit resets at midnight US-Pacific), or enable billing on the key's "
                    "Google Cloud project to raise the limit. You can also cover/retype the dimension "
                    "manually with the Erase Box + Add Text tools."
                ),
            }), 429
        return jsonify({"error": "AI image edit failed", "detail": str(exc)[:300]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "AI image edit failed", "detail": str(exc)[:300]}), 502

    return jsonify({"dataUrl": f"data:{out_mime};base64,{out_b64}"})


@app.route("/ai-image-annotate", methods=["POST"])
def ai_image_annotate():
    """Locate the text labels an instruction targets and compute their replacements, using the
    vision-capable TEXT model (no image-generation quota). Returns {edits:[{original,replacement,box}]}
    for the frontend to overlay on the canvas. Ideal for unit conversions / label fixes."""
    data = request.get_json(silent=True) or {}
    data_url = str(data.get("imageDataUrl", "")).strip()
    prompt = normalize_whitespace(str(data.get("prompt", "")))

    if not data_url.startswith("data:") or "," not in data_url:
        return jsonify({"error": "imageDataUrl must be a base64 data URL"}), 400
    if not prompt:
        return jsonify({"error": "A prompt describing the edit is required"}), 400
    if LLM_PROVIDER != "gemini":
        return jsonify({"error": "AI image edit requires LLM_PROVIDER=gemini"}), 400

    header, b64 = data_url.split(",", 1)
    mime_type = "image/png"
    if header.startswith("data:") and ";" in header:
        mime_type = header[len("data:"):header.index(";")] or "image/png"

    try:
        edits = _gemini_annotate_image(b64, mime_type, prompt)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status == 429:
            return jsonify({
                "error": "Rate limit",
                "detail": "The AI model is rate-limited (429). Wait a moment and try again, or enable billing on the key.",
            }), 429
        return jsonify({"error": "AI image edit failed", "detail": str(exc)[:300]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "AI image edit failed", "detail": str(exc)[:300]}), 502

    return jsonify({"edits": edits})


PRODUCT_NAME_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "product-names.json")


def _load_name_registry() -> "dict[str, Any]":
    try:
        with open(PRODUCT_NAME_STORE, encoding="utf-8") as handle:
            data = json.load(handle)
        return {"assigned": data.get("assigned") or {}, "used": data.get("used") or []}
    except Exception:
        return {"assigned": {}, "used": []}


def _save_name_registry(registry: "dict[str, Any]") -> None:
    try:
        os.makedirs(os.path.dirname(PRODUCT_NAME_STORE), exist_ok=True)
        with open(PRODUCT_NAME_STORE, "w", encoding="utf-8") as handle:
            json.dump(registry, handle)
    except Exception as exc:  # noqa: BLE001
        print(f"[names] save failed: {exc}", flush=True)


@app.route("/product-names/reserve", methods=["POST"])
def reserve_product_names():
    """Reserve globally-unique product names so no two products share a name. The frontend
    sends a product key + ordered candidate names; we hand back the first N not already used."""
    data = request.get_json(silent=True) or {}
    key = normalize_whitespace(str(data.get("key", "")))
    count = max(1, int(data.get("count", 3) or 3))
    candidates = [
        normalize_whitespace(str(item))
        for item in (data.get("candidates") if isinstance(data.get("candidates"), list) else [])
        if isinstance(item, str) and str(item).strip()
    ]

    registry = _load_name_registry()
    already = [name for name in (registry["assigned"].get(key) or []) if name]
    if key and len(already) >= count:
        return jsonify({"names": already[:count]})

    used_lower = {str(name).lower() for name in registry["used"]}
    chosen = already[:count]
    seen = {name.lower() for name in chosen}
    for candidate in candidates:
        if len(chosen) >= count:
            break
        low = candidate.lower()
        if low in seen or low in used_lower:
            continue
        chosen.append(candidate)
        seen.add(low)

    # Fallback when the distinct-codename candidates are all used: cycle THROUGH the candidate list
    # appending an increasing number, so the extra names keep DIFFERENT first words
    # ("Orion Linear 2", "Lyra Linear 2", "Vega Linear 2") instead of numbering a single base
    # ("Andromeda Linear 2/3/4").
    bases = candidates or ["Product"]
    attempt = 0
    while len(chosen) < count:
        base = bases[attempt % len(bases)]
        round_num = 2 + (attempt // len(bases))
        fallback = f"{base} {round_num}"
        low = fallback.lower()
        if low not in seen and low not in used_lower:
            chosen.append(fallback)
            seen.add(low)
        attempt += 1
        if attempt > len(bases) * 100:
            break

    if key:
        registry["assigned"][key] = chosen[:count]
    registry["used"] = sorted({*registry["used"], *chosen})
    _save_name_registry(registry)
    return jsonify({"names": chosen[:count]})


@app.route("/cache/purge", methods=["POST"])
def cache_purge():
    """Purge the cached extraction for an uploaded PDF so a future upload re-analyzes it fresh.
    Called when an extraction is deleted so nothing stale is served."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    pdf_bytes = request.files["file"].read()
    if not pdf_bytes:
        return jsonify({"error": "Empty file"}), 400
    purged = purge_cached_extraction(pdf_bytes)
    return jsonify({"purged": purged})


@app.route("/process-pdf", methods=["POST"])
def process_pdf():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400

    pdf_bytes = file.read()
    if not pdf_bytes:
        return jsonify({"error": "Empty file"}), 400

    # Return the saved result if this exact PDF was analyzed before (unless force=1).
    force = str(request.form.get("force") or request.args.get("force") or "").strip().lower() in {"1", "true", "yes"}
    if not force:
        cached = load_cached_extraction(pdf_bytes)
        if cached is not None:
            print(f"[cache] hit for {file.filename!r} — returning saved result (no re-analysis).", flush=True)
            cached["cached"] = True
            return jsonify(cached)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        pdf_path = tmp.name

    try:
        source_pages = render_pdf_pages(pdf_path)
        extracted_text, extraction_notes = extract_text_from_pdf(pdf_path)

        if not normalize_whitespace(extracted_text):
            return jsonify(
                {
                    "error": "Could not extract text from PDF",
                    "detail": "No readable vendor text was found. Install PaddleOCR or upload a text-based PDF.",
                }
            ), 422

        raw_result = call_llm(extracted_text, source_pages)
        # Second "reviewer agent" pass: cross-check and correct before mapping into the form.
        reviewed_result = review_extraction(raw_result, extracted_text)

        # Diagnostics: surface what the model returned (pre/post review) vs. text fed in.
        try:
            print(
                f"[extract] file={file.filename!r} text_chars={len(extracted_text)} "
                f"name={str(reviewed_result.get('productName',''))[:60]!r} "
                f"features={len(reviewed_result.get('productFeatures') or [])} "
                f"applications={len(reviewed_result.get('applicationAreas') or [])} "
                f"technicalSpecs={len(reviewed_result.get('technicalSpecs') or [])} "
                f"reviewed={reviewed_result is not raw_result} "
                f"text_head={normalize_whitespace(extracted_text)[:200]!r}",
                flush=True,
            )
        except Exception:
            pass

        result = post_process_extraction(reviewed_result, extracted_text, source_pages, extraction_notes)
        # Pull the vendor's embedded images (product photos, accessory/dimension diagrams) so the
        # editor can offer them as one-click suggested thumbnails (e.g. per accessory).
        try:
            # Scan ALL pages (capped generously) so accessory / mounting / photometric images on
            # later pages are captured too — not just the first few vision pages.
            result["sourceImages"] = extract_embedded_images(pdf_path)
        except Exception as exc:  # never fail an extraction because of image harvesting
            print(f"[images] embedded-image extraction skipped: {exc}", flush=True)
            result["sourceImages"] = []
        # Save so this exact PDF is never analyzed from scratch again.
        save_cached_extraction(pdf_bytes, result)
        return jsonify(result)

    except requests.exceptions.ConnectionError:
        if LLM_PROVIDER == "groq":
            return jsonify(
                {
                    "error": "Cannot connect to Groq",
                    "detail": f"Failed to reach the Groq API at {GROQ_URL}. Check your network connection.",
                }
            ), 503
        return jsonify(
            {
                "error": "Cannot connect to Ollama",
                "detail": f"Make sure Ollama is running at {OLLAMA_URL} with model {OLLAMA_MODEL} loaded.",
            }
        ), 503
    except requests.exceptions.HTTPError as exc:
        detail = ""
        if exc.response is not None:
            try:
                payload = exc.response.json()
                detail = normalize_whitespace(str(payload.get("error", "")))
            except Exception:
                detail = normalize_whitespace(exc.response.text)

        if not detail:
            detail = str(exc)

        return jsonify({"error": "Ollama request failed", "detail": detail}), exc.response.status_code if exc.response is not None else 502
    except requests.exceptions.Timeout:
        return jsonify({"error": "Ollama timed out", "detail": "The model took too long to respond."}), 504
    except json.JSONDecodeError as exc:
        return jsonify({"error": "Failed to parse model output as JSON", "detail": str(exc)}), 500
    except Exception as exc:  # pragma: no cover - surfaced to caller
        print(f"Error: {exc}", file=sys.stderr)
        return jsonify({"error": "Processing failed", "detail": str(exc)}), 500
    finally:
        try:
            os.unlink(pdf_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", "5005").strip())
    print(f"Starting Flask backend on port {port}")
    if LLM_PROVIDER == "gemini":
        print(f"Using Gemini model {GEMINI_MODEL}")
        if not GEMINI_API_KEY:
            print("WARNING: GEMINI_API_KEY is not set. Set it before processing PDFs.", file=sys.stderr)
    elif LLM_PROVIDER == "groq":
        print(f"Using Groq at {GROQ_URL} with model {GROQ_MODEL}")
        if not GROQ_API_KEY:
            print("WARNING: GROQ_API_KEY is not set. Set it before processing PDFs.", file=sys.stderr)
    else:
        print(f"Using Ollama at {OLLAMA_URL} with model {OLLAMA_MODEL}")
    app.run(host="0.0.0.0", port=port, debug=False)

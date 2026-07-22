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
ENABLE_PADDLE_OCR = os.environ.get("ENABLE_PADDLE_OCR", "1").strip().lower() not in {"0", "false", "no"}

# Cache extraction results by PDF content so the same file is never re-analyzed (saves
# LLM quota + time). Cache-busting: bump CACHE_VERSION when the pipeline output changes.
ENABLE_EXTRACTION_CACHE = os.environ.get("ENABLE_EXTRACTION_CACHE", "1").strip().lower() not in {"0", "false", "no"}
EXTRACTION_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "extraction_cache")
CACHE_VERSION = "v2"


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

Return ONLY valid JSON with this exact structure:
{
  "productName": "Vendor-source product name, cleaned for IKIO TDS use",
  "alternateName": "Alternate vendor/product naming if present",
  "productDescription": "One concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value. Grounded in the source PDF.",
  "productFeatures": ["Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars", "Full benefit sentence ~100 chars"],
  "applicationAreas": ["Area 1", "Area 2", "Area 3", "Area 4", "Area 5", "Area 6"],
  "productCategory": "panel/downlight/track/flood/street/high_bay/low_bay/linear/unknown",
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
- NEVER leave a field blank. Use "Not Specified" for missing scalar values.
- Preserve fixture availability. If different fixture sizes or SKUs have different power/lumen packages, keep those relationships intact in variantOverview.matrix and variants.
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
- BEST-EFFORT: Every form field should end up with SOMETHING. If the source doesn't state a value, infer the most likely value from the product type/specs rather than leaving it blank — the user will verify flagged values. Only use "Not Specified" when no reasonable inference exists.
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
- productDescription: write one concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value. Ground it in the source PDF.
- orderingInfo: Fill EVERY column with at least one {code, description} option. If the vendor PDF has a part-number / ordering decoder, copy its exact codes and meanings for each field. If it does NOT, best-effort DERIVE options from the real specs: Power codes from the wattage packages, CCT codes from the color temperatures, Voltage from the input voltage, etc. Use short codes (e.g. "50K" for 5000K, "MV" for 120-277V, "WH" for White, "D" for Dimmable). Never leave orderingInfo empty.
- orderingExample: assemble one concrete example part number by joining one chosen code from each column with "-".
- accessories: List any accessories, controllers, sensors, mounting/emergency kits mentioned. Each needs a product code (best-effort like "IK-ACC-...") and a short description. Return [] only if the PDF truly has none.
- dimensions: For each fixture size/variant, give a label and its width/height/depth in inches (convert mm using 1in=25.4mm, 2 decimals). Use "Not Specified" for any missing axis.
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
    return alpha_count < 120 and len(table_rows) < 3


def run_paddle_ocr_on_page(pdf_path: str, page_index: int) -> str:
    ocr = get_paddle_ocr()
    if ocr is None:
        return ""

    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        try:
            bitmap = page.render(scale=max(PDF_RENDER_SCALE, 1.8))
            try:
                image = bitmap.to_pil()
                results = ocr.ocr(image)
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        pdf.close()

    lines: list[str] = []
    for page_result in results or []:
        for item in page_result or []:
            if len(item) < 2:
                continue
            text = normalize_whitespace(item[1][0] if isinstance(item[1], (list, tuple)) else "")
            if text:
                lines.append(text)
    return "\n".join(lines)


def extract_text_from_pdf(pdf_path: str) -> tuple[str, list[str]]:
    text_parts: list[str] = []
    notes: list[str] = []

    with pdfplumber.open(pdf_path) as pdf:
        for index, page in enumerate(pdf.pages):
            page_text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            table_rows = extract_tables_from_page(page)
            ocr_text = ""

            if should_use_ocr(page_text, table_rows):
                ocr_text = run_paddle_ocr_on_page(pdf_path, index)
                if ocr_text:
                    notes.append(f"Used PaddleOCR on vendor page {index + 1}.")

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
    return bool(re.search(r"(?i)\b\d+(?:\.\d+)?\s*(?:w|watt|watts)\b", value))


def is_lumen_value(value: str) -> bool:
    return bool(re.search(r"(?i)\b\d[\d,]*(?:\.\d+)?\s*lm\b", value))


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


def derive_variant_overview(technical_specs: list[dict[str, str]], current: dict[str, Any]) -> dict[str, Any]:
    variant_overview = normalize_variant_overview(current.get("variantOverview"))
    if variant_overview["matrix"]:
        # Scrub SKU fragments from the Power column (index 2) that feeds the spec table.
        params = variant_overview.get("parameters", [])
        power_idx = params.index("Power") if "Power" in params else 2
        for row in variant_overview["matrix"]:
            if isinstance(row, list) and len(row) > power_idx:
                row[power_idx] = strip_catalog_code(str(row[power_idx]))
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


def build_user_message(document_text: str) -> str:
    return f"""Analyze this vendor lighting specification sheet content.

Source-first instructions:
- Understand the vendor PDF before mapping fields.
- Preserve fixture-specific availability and power/lumen relationships.
- Use the vendor product family/title, cleaned but not creatively renamed.
- Use only supported claims from the source text.

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


def _gemini_generate(system_prompt: str, user_message: str) -> dict[str, Any]:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Export GEMINI_API_KEY (get a key at "
            "https://aistudio.google.com/apikey) and set LLM_PROVIDER=gemini."
        )
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
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


def call_gemini(document_text: str) -> dict[str, Any]:
    return _gemini_generate(SYSTEM_PROMPT, build_user_message(document_text))


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
  aligned in order. If Lumen Output has 5 values but Power has 1, find the full wattage list in the source and
  expand Power to match.
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


def call_llm(document_text: str) -> dict[str, Any]:
    try:
        if LLM_PROVIDER == "gemini":
            return call_gemini(document_text)
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
    return _clean_code_entries(value)[:12]


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

    payload["variantOverview"] = derive_variant_overview(technical_specs, model_output)
    return payload


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


AI_DESCRIPTION_SYSTEM = (
    'You write IKIO lighting PRODUCT DESCRIPTIONS. Return ONLY JSON: {"text": "..."}. '
    "Write one concise paragraph covering what the product is, where it is used, its main performance "
    "or design advantage, and its broader project value. Ground it in the provided specs. "
    "Do not invent unsupported claims and never include vendor part numbers. Follow the user's instruction."
)
AI_FEATURES_SYSTEM = (
    'You write IKIO lighting product FEATURES. Return ONLY JSON: {"features": ["...", "...", "...", "..."]}. '
    "Exactly 4 benefit-oriented sentences, each about 100 characters (90-115), grounded in the provided specs. "
    "No part numbers, no bare fragments. Follow the user's instruction."
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
        else "One concise paragraph covering what the product is, where it is used, its main performance or design advantage, and its broader project value."
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

    suffix = 2
    base = candidates[0] if candidates else "Product"
    while len(chosen) < count:
        fallback = f"{base} {suffix}"
        if fallback.lower() not in seen and fallback.lower() not in used_lower:
            chosen.append(fallback)
            seen.add(fallback.lower())
        suffix += 1

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

        raw_result = call_llm(extracted_text)
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

import base64
import io
import json
import os
import re
import sys
import tempfile
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS
import pdfplumber
import pypdfium2 as pdfium
import requests

app = Flask(__name__)
CORS(app)

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama").strip().lower()

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").strip()
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b").strip()
OLLAMA_TIMEOUT_SECONDS = int(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "300").strip())

GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1").strip().rstrip("/")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_TIMEOUT_SECONDS = int(os.environ.get("GROQ_TIMEOUT_SECONDS", "120").strip())
PDF_RENDER_SCALE = float(os.environ.get("PDF_RENDER_SCALE", "1.35").strip())
MAX_PROMPT_CHARS = int(os.environ.get("MAX_PROMPT_CHARS", "36000").strip())
ENABLE_PADDLE_OCR = os.environ.get("ENABLE_PADDLE_OCR", "1").strip().lower() not in {"0", "false", "no"}

SYSTEM_PROMPT = """You are an expert lighting specification analyst building IKIO-style technical data sheet drafts from vendor PDFs.

Your job is to read the vendor source carefully, understand the real product family/fixture availability first, and then map the data into IKIO-standard fields without inventing unsupported claims.

Return ONLY valid JSON with this exact structure:
{
  "productName": "Vendor-source product name, cleaned for IKIO TDS use",
  "alternateName": "Alternate vendor/product naming if present",
  "productDescription": "Max 380 chars. Must reflect source PDF, key wattage/lumen/control details, and application intent.",
  "productFeatures": ["Feature 1", "Feature 2", "Feature 3", "Feature 4", "Feature 5"],
  "applicationAreas": ["Area 1", "Area 2", "Area 3", "Area 4", "Area 5", "Area 6"],
  "productCategory": "panel/downlight/track/flood/street/high_bay/low_bay/linear/unknown",
  "isProductFamily": true,
  "variantOverview": {
    "parameters": ["Fixture Type", "Power", "Lumen Output", "CCT", "Efficacy"],
    "matrix": [
      ["Variant label", "value", "value", "value", "value"]
    ]
  },
  "variants": [
    {
      "label": "Variant label",
      "fixtureType": "value",
      "power": "value",
      "lumenOutput": "value",
      "cct": "value",
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
- If a value is clearly selectable, format compactly, for example "20W/25W/30W" or "3000K/4000K/5000K".
- Keep descriptions and features grounded in the source PDF.
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
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


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
    return text


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
    segments = [
        re.sub(r"(?i)(\d{3,5})\s*k\b", r"\1K", normalize_unit_spacing(segment))
        for segment in re.split(r"(?:\r?\n|[|;])+", value)
        if normalize_whitespace(segment)
    ]
    unique_segments = unique_preserve_order(segments)
    return " | ".join(unique_segments) if unique_segments else "Not Specified"


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


def normalize_spec_value(parameter: str, value: str) -> str:
    text = normalize_unit_spacing(value)
    if parameter == "Color Temperature":
        return normalize_color_temperature_value(text)
    if parameter == "Beam Angle":
        return format_beam_angle(text)
    if "Temperature" in parameter:
        return normalize_temperature_value(text)
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
        return variant_overview

    lookup = {item["parameter"]: item["specification"] for item in technical_specs}
    power_lines = [line.strip() for line in re.split(r"[\r\n]+", lookup.get("Power", "")) if line.strip()]
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


def call_llm(document_text: str) -> dict[str, Any]:
    if LLM_PROVIDER == "groq":
        return call_groq(document_text)
    return call_ollama(document_text)


def post_process_extraction(model_output: dict[str, Any], source_text: str, source_pages: list[dict[str, Any]], notes: list[str]) -> dict[str, Any]:
    technical_specs = normalize_technical_specs(model_output.get("technicalSpecs"))

    product_name = normalize_whitespace(str(model_output.get("productName", ""))) or "Unknown Product"
    alternate_name = normalize_whitespace(str(model_output.get("alternateName", ""))) or "Not Specified"
    description = normalize_whitespace(str(model_output.get("productDescription", ""))) or "Not Specified"
    category = normalize_whitespace(str(model_output.get("productCategory", ""))) or infer_product_category(source_text)

    payload = {
        "productName": product_name,
        "alternateName": alternate_name,
        "productDescription": description,
        "productFeatures": normalize_string_list(model_output.get("productFeatures"), "See source vendor PDF for product features.", 5),
        "applicationAreas": normalize_string_list(model_output.get("applicationAreas"), "General commercial lighting", 6),
        "productCategory": category,
        "isProductFamily": bool(model_output.get("isProductFamily", False)),
        "technicalSpecs": technical_specs,
        "categorySpecificSpecs": normalize_technical_specs(model_output.get("categorySpecificSpecs")),
        "notes": normalize_string_list(model_output.get("notes"), "Generated from vendor PDF source.", 8) + notes,
        "vendorInfo": normalize_vendor_info(model_output.get("vendorInfo")),
        "sourceImages": [],
        "sourcePages": source_pages,
        "variants": normalize_variants(model_output.get("variants")),
    }

    payload["variantOverview"] = derive_variant_overview(technical_specs, model_output)
    return payload


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


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
        result = post_process_extraction(raw_result, extracted_text, source_pages, extraction_notes)
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
    if LLM_PROVIDER == "groq":
        print(f"Using Groq at {GROQ_URL} with model {GROQ_MODEL}")
        if not GROQ_API_KEY:
            print("WARNING: GROQ_API_KEY is not set. Set it before processing PDFs.", file=sys.stderr)
    else:
        print(f"Using Ollama at {OLLAMA_URL} with model {OLLAMA_MODEL}")
    app.run(host="0.0.0.0", port=port, debug=False)

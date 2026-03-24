import os
import json
import re
import sys
import tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS
import pdfplumber
import requests

app = Flask(__name__)
CORS(app)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "glm4.6:cloud")

SYSTEM_PROMPT = """You are an expert lighting specification analyst and product content generator.

Your job is to extract, interpret, and structure all data from vendor lighting specification sheets.

For every input spec sheet text, generate a complete structured JSON product package.

OUTPUT FORMAT - Return ONLY valid JSON, no other text:
{
  "productName": "IKIO-style product name (max 6 words, include type + wattage + key feature)",
  "alternateName": "Alternate product name 1 / Alternate name 2",
  "productDescription": "Max 380 char marketing+technical description including wattage, application, build quality, efficacy, controls",
  "productFeatures": [
    "Feature starting with action verb",
    "Feature starting with action verb",
    "Feature starting with action verb",
    "Feature starting with action verb",
    "Feature starting with action verb"
  ],
  "applicationAreas": [
    "Application area 1",
    "Application area 2",
    "Application area 3",
    "Application area 4",
    "Application area 5",
    "Application area 6"
  ],
  "technicalSpecs": [
    {"parameter": "Product Type", "specification": "value"},
    {"parameter": "Wattage", "specification": "value"},
    {"parameter": "Wattage Selectable", "specification": "Yes/No"},
    {"parameter": "Lumen Output", "specification": "value"},
    {"parameter": "Efficacy", "specification": "value lm/W"},
    {"parameter": "Input Voltage", "specification": "value"},
    {"parameter": "Current", "specification": "value or Not Specified"},
    {"parameter": "CCT", "specification": "value"},
    {"parameter": "CCT Selectable", "specification": "Yes/No"},
    {"parameter": "CRI", "specification": "value"},
    {"parameter": "Beam Angle", "specification": "value"},
    {"parameter": "Light Distribution", "specification": "value or Not Specified"},
    {"parameter": "IP Rating", "specification": "value or Not Specified"},
    {"parameter": "IK Rating", "specification": "value or Not Specified"},
    {"parameter": "Lifespan", "specification": "value Hours"},
    {"parameter": "Warranty", "specification": "X Years"},
    {"parameter": "Operating Temperature", "specification": "value"},
    {"parameter": "Power Factor", "specification": "value"},
    {"parameter": "THD", "specification": "value or Not Specified"},
    {"parameter": "Dimming", "specification": "value"},
    {"parameter": "Driver", "specification": "value or Not Specified"},
    {"parameter": "LED Source", "specification": "value"},
    {"parameter": "Housing", "specification": "value or Not Specified"},
    {"parameter": "Lens", "specification": "value or Not Specified"},
    {"parameter": "Mounting", "specification": "value or Not Specified"},
    {"parameter": "Finish", "specification": "value or Not Specified"},
    {"parameter": "Certifications", "specification": "value or Not Specified"},
    {"parameter": "Surge Protection", "specification": "value or Not Specified"},
    {"parameter": "Flicker", "specification": "value or Not Specified"},
    {"parameter": "Protection Class", "specification": "value or Not Specified"},
    {"parameter": "Weight", "specification": "value or Not Specified"},
    {"parameter": "Dimensions", "specification": "value or Not Specified"}
  ],
  "notes": [
    "Note about missing or estimated values"
  ],
  "vendorInfo": {
    "vendorName": "Vendor name from document",
    "vendorContact": "Email/phone/website if present"
  }
}

RULES:
- NEVER leave a field blank. Use "Not Specified" for missing values.
- For selectable wattage/CCT, show range like "20W/25W/30W" or "3000K/4000K/5000K"
- Normalize units: wattage as "100 W", voltage as "120-277 V", lumens as "15000 lm"
- Always output ONLY the JSON object, no markdown, no explanation
"""


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract all text from a PDF using pdfplumber."""
    text_parts = []
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        with pdfplumber.open(tmp_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if row:
                            cleaned = [str(cell).strip() if cell else "" for cell in row]
                            text_parts.append(" | ".join(cleaned))
    finally:
        os.unlink(tmp_path)

    return "\n".join(text_parts)


def call_ollama(text: str) -> dict:
    """Call Ollama with the extracted text and return parsed JSON."""
    user_message = f"Extract the lighting product specifications from this vendor spec sheet text and return structured JSON:\n\n{text[:12000]}"

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message}
        ],
        "stream": False,
        "format": "json"
    }

    response = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json=payload,
        timeout=300
    )
    response.raise_for_status()

    result = response.json()
    content = result.get("message", {}).get("content", "")

    json_str = content.strip()
    if json_str.startswith("```"):
        json_str = re.sub(r"^```(?:json)?\n?", "", json_str)
        json_str = re.sub(r"\n?```$", "", json_str)

    return json.loads(json_str)


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

    try:
        extracted_text = extract_text_from_pdf(pdf_bytes)
        if not extracted_text.strip():
            return jsonify({"error": "Could not extract text from PDF. The PDF may be image-only."}), 422

        result = call_ollama(extracted_text)
        return jsonify(result)

    except requests.exceptions.ConnectionError:
        return jsonify({
            "error": "Cannot connect to Ollama",
            "detail": f"Make sure Ollama is running at {OLLAMA_URL} with model {OLLAMA_MODEL} loaded."
        }), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Ollama timed out", "detail": "The model took too long to respond."}), 504
    except json.JSONDecodeError as e:
        return jsonify({"error": "Failed to parse model output as JSON", "detail": str(e)}), 500
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return jsonify({"error": "Processing failed", "detail": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5001))
    print(f"Starting Flask backend on port {port}")
    print(f"Using Ollama at {OLLAMA_URL} with model {OLLAMA_MODEL}")
    app.run(host="0.0.0.0", port=port, debug=False)

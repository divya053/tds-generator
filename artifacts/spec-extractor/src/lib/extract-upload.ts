import type { ExtractedSpec } from "@workspace/api-client-react";
import { HttpError, apiUrl } from "./http";

const EXTRACTION_DURATION_STORAGE_KEY = "ikio-tds-extraction-durations";
const MAX_DURATION_SAMPLES = 6;

export type ExtractionProgress = {
  percent: number;
  stage: string;
  etaMs: number | null;
  elapsedMs: number;
};

type ErrorPayload = {
  error?: string;
  detail?: string;
};

function getDurationSamples() {
  if (typeof window === "undefined") {
    return [] as number[];
  }

  try {
    const raw = window.localStorage.getItem(EXTRACTION_DURATION_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
  } catch {
    return [];
  }
}

function storeDurationSample(durationMs: number) {
  if (typeof window === "undefined") {
    return;
  }

  const next = [...getDurationSamples(), durationMs].slice(-MAX_DURATION_SAMPLES);
  window.localStorage.setItem(EXTRACTION_DURATION_STORAGE_KEY, JSON.stringify(next));
}

function getEstimatedTotalMs(file: File) {
  const samples = getDurationSamples();
  const historicalAverage =
    samples.length > 0 ? samples.reduce((total, value) => total + value, 0) / samples.length : 0;
  const sizeEstimate = 55000 + (file.size / (1024 * 1024)) * 7000;

  return Math.max(70000, Math.round(sizeEstimate), Math.round(historicalAverage));
}

function getStage(percent: number) {
  if (percent < 18) return "Uploading vendor PDF";
  if (percent < 38) return "Extracting document text";
  if (percent < 62) return "Mapping variants and technical specs";
  if (percent < 86) return "Building IKIO TDS fields";
  if (percent < 100) return "Finalizing review assets";
  return "Completed";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseErrorPayload(value: string) {
  try {
    return JSON.parse(value) as ErrorPayload;
  } catch {
    return value;
  }
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const error = typeof (payload as ErrorPayload).error === "string" ? (payload as ErrorPayload).error : "";
    const detail = typeof (payload as ErrorPayload).detail === "string" ? (payload as ErrorPayload).detail : "";
    if (error && detail) return `${error}: ${detail}`;
    if (detail) return detail;
    if (error) return error;
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  return fallback;
}

export function formatEta(etaMs: number | null) {
  if (etaMs == null) {
    return "Estimating...";
  }

  const totalSeconds = Math.max(0, Math.round(etaMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s remaining`;
  }

  return `${seconds}s remaining`;
}

export function uploadSpecExtraction(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void,
) {
  return new Promise<ExtractedSpec>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    const startedAt = Date.now();
    const estimatedTotalMs = getEstimatedTotalMs(file);
    let uploadRatio = 0;
    let analysisStartedAtMs: number | null = null;
    let lastPercent = 1;

    form.append("file", file);

    const emitProgress = () => {
      const elapsedMs = Date.now() - startedAt;
      let percent = 1;
      let etaMs = Math.max(estimatedTotalMs - elapsedMs, 0);

      if (uploadRatio < 1) {
        percent = clamp(Math.round(uploadRatio * 18), 1, 18);
      } else {
        if (analysisStartedAtMs == null) {
          analysisStartedAtMs = elapsedMs;
        }

        const analysisElapsedMs = Math.max(0, elapsedMs - analysisStartedAtMs);
        const baseAnalysisBudgetMs = Math.max(estimatedTotalMs - analysisStartedAtMs, 35000);
        const adaptiveAnalysisBudgetMs = Math.max(
          baseAnalysisBudgetMs,
          Math.round(analysisElapsedMs * 1.12),
        );

        const analysisRatio = clamp(analysisElapsedMs / adaptiveAnalysisBudgetMs, 0, 0.98);
        percent = clamp(Math.round(18 + analysisRatio * 79), 18, 97);
        etaMs = Math.max(analysisStartedAtMs + adaptiveAnalysisBudgetMs - elapsedMs, 0);
      }

      lastPercent = Math.max(lastPercent, percent);

      onProgress?.({
        percent: lastPercent,
        stage: getStage(lastPercent),
        etaMs,
        elapsedMs,
      });
    };

    const interval = window.setInterval(emitProgress, 250);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        uploadRatio = event.loaded / event.total;
        emitProgress();
      }
    });

    xhr.upload.addEventListener("load", () => {
      uploadRatio = 1;
      emitProgress();
    });

    xhr.addEventListener("error", () => {
      window.clearInterval(interval);
      reject(new Error("Network error while uploading the PDF."));
    });

    xhr.addEventListener("abort", () => {
      window.clearInterval(interval);
      reject(new Error("Upload cancelled."));
    });

    xhr.addEventListener("load", () => {
      window.clearInterval(interval);

      if (xhr.status >= 200 && xhr.status < 300) {
        storeDurationSample(Date.now() - startedAt);
        onProgress?.({
          percent: 100,
          stage: getStage(100),
          etaMs: 0,
          elapsedMs: Date.now() - startedAt,
        });
        resolve(JSON.parse(xhr.responseText) as ExtractedSpec);
        return;
      }

      const payload = parseErrorPayload(xhr.responseText);
      reject(new HttpError(xhr.status, getErrorMessage(payload, "Extraction failed"), payload));
    });

    xhr.open("POST", apiUrl("/api/extract"));
    xhr.withCredentials = true;
    xhr.send(form);
    emitProgress();
  });
}

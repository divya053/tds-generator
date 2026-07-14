export class HttpError<T = unknown> extends Error {
  readonly status: number;
  readonly data: T | null;

  constructor(status: number, message: string, data: T | null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.data = data;
  }
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getObjectField(data: unknown, key: string) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildErrorMessage(status: number, data: unknown) {
  const error = getObjectField(data, "error");
  const detail = getObjectField(data, "detail");
  const message = getObjectField(data, "message");

  if (error && detail) return `${error}: ${detail}`;
  if (detail) return detail;
  if (error) return error;
  if (message) return message;
  if (typeof data === "string" && data.trim()) return data.trim();

  return `Request failed with status ${status}`;
}

export async function fetchJson<T>(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers,
  });

  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw new HttpError(response.status, buildErrorMessage(response.status, data), data);
  }

  return data as T;
}

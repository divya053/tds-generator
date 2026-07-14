import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

const AUTH_COOKIE_NAME = "ikio_tds_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const AUTH_USERNAME = (process.env.IKIO_AUTH_USERNAME ?? "admin").trim();
const AUTH_PASSWORD = (process.env.IKIO_AUTH_PASSWORD ?? "admin123").trim();
const SESSION_SECRET = (
  process.env.IKIO_AUTH_SECRET ?? "ikio-tds-generator-dev-session-secret"
).trim();

type SessionPayload = {
  sub: string;
  exp: number;
  iat: number;
};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        username: string;
      };
    }
  }
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value: string) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateCredentials(username: string, password: string) {
  return safeCompare(username.trim(), AUTH_USERNAME) && safeCompare(password, AUTH_PASSWORD);
}

export function createSessionToken(username: string) {
  const now = Date.now();
  const payload: SessionPayload = {
    sub: username,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  const [encodedPayload, signature] = token.split(".", 2);
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signValue(encodedPayload);
  if (!safeCompare(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as SessionPayload;
    if (!payload?.sub || typeof payload.exp !== "number" || payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  };
}

export function setSessionCookie(res: Response, username: string) {
  res.cookie(AUTH_COOKIE_NAME, createSessionToken(username), getCookieOptions());
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export function getSession(req: Request) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== "string" || token.trim() === "") {
    return null;
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return null;
  }

  return { username: payload.sub };
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required", detail: "Please log in to continue." });
    return;
  }

  req.auth = session;
  next();
};

export function getAuthConfig() {
  return {
    defaultUsername: AUTH_USERNAME,
    sessionTtlMs: SESSION_TTL_MS,
  };
}

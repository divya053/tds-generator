import { Router, type IRouter } from "express";
import {
  clearSessionCookie,
  getAuthConfig,
  getSession,
  setSessionCookie,
  validateCredentials,
} from "../lib/auth";

const router: IRouter = Router();

router.get("/auth/session", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json({
    authenticated: true,
    username: session.username,
    sessionTtlMs: getAuthConfig().sessionTtlMs,
  });
});

router.post("/auth/login", (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!validateCredentials(username, password)) {
    clearSessionCookie(res);
    res.status(401).json({ error: "Invalid credentials", detail: "The username or password is incorrect." });
    return;
  }

  setSessionCookie(res, username.trim());
  res.json({
    authenticated: true,
    username: username.trim(),
    sessionTtlMs: getAuthConfig().sessionTtlMs,
  });
});

router.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ message: "Logged out" });
});

export default router;

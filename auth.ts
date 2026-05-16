import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "changeme";

const COOKIE_NAME = "admin_session";
const COOKIE_VALUE = `authenticated_${SESSION_SECRET}`;

function isAuthenticated(req: Request): boolean {
  return req.cookies?.[COOKIE_NAME] === COOKIE_VALUE;
}

export function requireAuth(req: Request, res: Response, next: () => void) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.post("/auth/login", (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.cookie(COOKIE_NAME, COOKIE_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ authenticated: true });
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ authenticated: false });
});

router.get("/auth/me", (req: Request, res: Response) => {
  res.json({ authenticated: isAuthenticated(req) });
});

export default router;

import { Hono } from "hono";
import { access } from "./access.ts";
import { api } from "./api.ts";
import { auth } from "./auth.ts";

export const app = new Hono();

// Better Auth's own: signing in, one-time codes, and the OAuth server with its metadata.
app.on(["GET", "POST"], ["/api/auth/*", "/.well-known/*"], (c) =>
	auth.handler(c.req.raw),
);
app.route("/api", api);
app.route("/agentwire", access);

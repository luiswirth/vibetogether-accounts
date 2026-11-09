import { Hono } from "hono";
import { access } from "./access.ts";
import { api } from "./api.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

export const app = new Hono();

/**
 * Better Auth's endpoints a request with a token may reach: an agent getting its token, and an
 * MCP client's OAuth. Every other one manages the account's sessions, consents and approvals,
 * which only the person does, in the browser: a token there would let one agent read the
 * others' tokens or mint new ones.
 */
const tokenEndpoints = new Set([
	"/api/auth/device/code",
	"/api/auth/device/token",
	"/api/auth/oauth2/token",
	"/api/auth/oauth2/register",
	"/api/auth/oauth2/revoke",
	"/api/auth/oauth2/userinfo",
]);

// Better Auth's own: signing in, one-time codes, and the OAuth server with its metadata.
app.on(["GET", "POST"], ["/api/auth/*", "/.well-known/*"], async (c) => {
	if (
		c.req.header("authorization") &&
		!c.req.path.startsWith("/.well-known/") &&
		!tokenEndpoints.has(c.req.path)
	)
		return c.text(
			"Only the person does this, signed in in the browser, never with a token.",
			403,
		);
	if (c.req.path === "/api/auth/device/code") return withRequester(c.req.raw);
	if (c.req.path === "/api/auth/device" && c.req.method === "GET")
		return withRequestOf(c.req.raw);
	return auth.handler(c.req.raw);
});

/** The address a request came from, which Caddy sets as X-Forwarded-For. */
function addressOf(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"an unknown address"
	);
}

/** Asks for a one-time code, and keeps when and from where, which the code's page shows. */
async function withRequester(request: Request): Promise<Response> {
	const from = addressOf(request);
	const response = await auth.handler(request);
	if (!response.ok) return response;
	const body = (await response.clone().json()) as { user_code?: string };
	if (body.user_code) {
		db.prepare("DELETE FROM device_request WHERE requested < ?").run(
			new Date(Date.now() - 86400_000).toISOString(),
		);
		db.prepare(
			'INSERT OR REPLACE INTO device_request (user_code, requested, "from") VALUES (?, ?, ?)',
		).run(body.user_code, new Date().toISOString(), from);
	}
	return response;
}

/** A one-time code as Better Auth gives it, with when and from where it was asked for. */
async function withRequestOf(request: Request): Promise<Response> {
	const response = await auth.handler(request);
	if (!response.ok) return response;
	const body = (await response.json()) as Record<string, unknown>;
	const code = new URL(request.url).searchParams
		.get("user_code")
		?.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase();
	const asked = db
		.prepare('SELECT requested, "from" FROM device_request WHERE user_code = ?')
		.get(code ?? "") as { requested: string; from: string } | undefined;
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(JSON.stringify({ ...body, ...asked }), {
		status: response.status,
		headers,
	});
}
app.route("/api", api);
app.route("/agentwire", access);

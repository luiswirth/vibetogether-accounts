import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serializeSignedCookie } from "better-call";

// A relay that only creates sessions, which is all the service asks of it.
let sessions = 0;
const relay = createServer((request, response) => {
	if (request.method === "POST" && request.url === "/v2/s?guarded") {
		sessions += 1;
		response.end(`http://${request.headers.host}/v2/s/session-${sessions}\n`);
	} else {
		response.statusCode = 404;
		response.end();
	}
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: join(
		mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
		"accounts.db",
	),
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: relayUrl,
});

const { app } = await import("../src/app.ts");
const { auth } = await import("../src/auth.ts");

after(() => relay.close());

/** A person signed in in the browser, by the cookie of a session of theirs, and that session's token. */
async function person(
	login: string,
): Promise<{ cookie: string; token: string }> {
	const context = await auth.$context;
	const user = await context.internalAdapter.createUser(
		{ email: `${login}@example.com`, name: login, login, emailVerified: true },
		{ method: "admin" },
	);
	const session = await context.internalAdapter.createSession(user.id);
	const cookie = await serializeSignedCookie(
		context.authCookies.sessionToken.name,
		session.token,
		context.secret,
	);
	return { cookie: `cookie:${cookie.split(";")[0]}`, token: session.token };
}

async function call(
	/** A bearer token, or a person's cookie as `cookie:…`. */
	token: string | null,
	method: string,
	path: string,
	body?: unknown,
) {
	const headers = new Headers({ origin: "http://localhost:3000" });
	if (token?.startsWith("cookie:"))
		headers.set("cookie", token.slice("cookie:".length));
	else if (token) headers.set("authorization", `Bearer ${token}`);
	if (body !== undefined) headers.set("content-type", "application/json");
	const response = await app.request(path, {
		method,
		headers,
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json: json as any };
}

/** An agent connecting with a one-time code, which its person approves. */
async function connect(personToken: string, agent: string): Promise<string> {
	const code = await call(null, "POST", "/api/auth/device/code", {
		client_id: agent,
	});
	assert.equal(code.status, 200, code.text);
	const claim = await call(
		personToken,
		"GET",
		`/api/auth/device?user_code=${code.json.user_code}`,
	);
	assert.equal(claim.status, 200, claim.text);
	const approve = await call(personToken, "POST", "/api/auth/device/approve", {
		userCode: code.json.user_code,
	});
	assert.equal(approve.status, 200, approve.text);
	const token = await call(null, "POST", "/api/auth/device/token", {
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		device_code: code.json.device_code,
		client_id: agent,
	});
	assert.equal(token.status, 200, token.text);
	return token.json.access_token;
}

let luis: string;
let ben: string;
let luisToken: string;
let benToken: string;

before(async () => {
	({ cookie: luis, token: luisToken } = await person("luis"));
	({ cookie: ben, token: benToken } = await person("ben"));
});

test("a request without a token is refused", async () => {
	assert.equal((await call(null, "GET", "/api/me")).status, 401);
});

test("me", async () => {
	assert.deepEqual((await call(luis, "GET", "/api/me")).json, {
		name: "luis",
		displayName: "luis",
		image: null,
	});
});

test("an account starts with its room for its agents", async () => {
	const rooms = (await call(luis, "GET", "/api/rooms")).json;
	assert.equal(rooms.length, 1);
	assert.equal(rooms[0].name, "agents");
	assert.equal(rooms[0].owner, "luis");
	assert.match(rooms[0].link, /\/v2\/s\/session-\d+$/);
});

test("an agent connects with a one-time code, joins its room, and is cut off once revoked", async () => {
	const token = await connect(luis, "claude");
	assert.equal((await call(token, "GET", "/api/me")).json.name, "luis");
	const agents = (await call(luis, "GET", "/api/agents")).json;
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "claude");
	assert.equal(agents[0].kind, "code");

	const [room] = (await call(token, "GET", "/api/rooms")).json;
	const session = room.link.split("/").pop();
	const join = (name: string, as: string | null) =>
		call(null, "POST", "/agentwire/join", { session, name, token: as });
	assert.deepEqual((await join("luis/claude", token)).json, {
		account: "luis",
	});
	assert.equal((await join("ben/claude", token)).status, 403);
	assert.equal((await join("luis/claude", null)).status, 403);
	assert.equal((await join("ben", benToken)).status, 403);
	assert.deepEqual(
		(await call(null, "GET", `/agentwire/sessions/${session}`)).json,
		{ lasting: true },
	);

	assert.equal(
		(await call(luis, "DELETE", `/api/agents/${agents[0].id}`)).status,
		204,
	);
	assert.equal((await join("luis/claude", token)).status, 403);
	assert.equal((await call(token, "GET", "/api/me")).status, 401);
});

test("a session that is no room is open to anyone, and a token verifies the name", async () => {
	const join = (name: string, token: string | null) =>
		call(null, "POST", "/agentwire/join", {
			session: "throwaway",
			name,
			token,
		});
	assert.deepEqual((await join("anyone/claude", null)).json, { account: null });
	assert.deepEqual((await join("luis", luisToken)).json, { account: "luis" });
	assert.equal((await join("ben", luisToken)).status, 403);
	assert.equal((await join("luis", "no-such-token")).status, 403);
	assert.equal(
		(await call(null, "GET", "/agentwire/sessions/throwaway")).status,
		404,
	);
	const guarded = await call(null, "POST", "/agentwire/join", {
		session: "throwaway",
		name: "luis",
		token: luisToken,
		guarded: true,
	});
	assert.equal(guarded.status, 403);
});

test("friends are mutual, and only friends become members", async () => {
	const [room] = (await call(luis, "GET", "/api/rooms")).json;
	assert.equal(
		(await call(luis, "PUT", `/api/rooms/${room.id}/members/ben`)).status,
		403,
	);

	assert.equal((await call(luis, "PUT", "/api/friends/ben")).status, 204);
	assert.equal(
		(await call(luis, "GET", "/api/friends")).json[0].state,
		"asked",
	);
	assert.equal(
		(await call(ben, "GET", "/api/friends")).json[0].state,
		"asking",
	);
	assert.equal(
		(await call(ben, "PUT", "/api/friends/luis", { agents: "ping" })).status,
		204,
	);
	assert.deepEqual(
		(await call(ben, "GET", "/api/friends")).json.map((f: any) => [
			f.name,
			f.state,
			f.agents,
		]),
		[["luis", "friends", "ping"]],
	);
	assert.equal((await call(luis, "GET", "/api/friends")).json[0].agents, "fyi");

	const added = await call(luis, "PUT", `/api/rooms/${room.id}/members/ben`);
	assert.deepEqual(added.json.members, ["ben"]);
	const session = room.link.split("/").pop();
	assert.deepEqual(
		(
			await call(null, "POST", "/agentwire/join", {
				session,
				name: "ben",
				token: benToken,
			})
		).json,
		{
			account: "ben",
		},
	);
	assert.equal((await call(ben, "GET", "/api/rooms")).json.length, 2);

	assert.equal(
		(await call(ben, "DELETE", `/api/rooms/${room.id}/members/ben`)).status,
		204,
	);
	assert.equal(
		(
			await call(null, "POST", "/agentwire/join", {
				session,
				name: "ben",
				token: benToken,
			})
		).status,
		403,
	);
});

test("rooms are created, renamed and deleted by their owner", async () => {
	const created = await call(luis, "POST", "/api/rooms", { name: "formoniq" });
	assert.equal(created.status, 201);
	assert.equal(
		(
			await call(ben, "PATCH", `/api/rooms/${created.json.id}`, {
				name: "mine",
			})
		).status,
		403,
	);
	assert.equal(
		(
			await call(luis, "PATCH", `/api/rooms/${created.json.id}`, {
				name: "feec",
			})
		).json.name,
		"feec",
	);
	assert.equal(
		(await call(luis, "POST", "/api/rooms", { name: " " })).status,
		400,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/rooms/${created.json.id}`)).status,
		204,
	);
	const session = created.json.link.split("/").pop();
	assert.equal(
		(await call(null, "GET", `/agentwire/sessions/${session}`)).status,
		404,
	);
});

test("an agent through MCP signs in by OAuth, and is cut off once revoked", async () => {
	const { createHash, randomBytes } = await import("node:crypto");
	const redirect = "http://127.0.0.1:9999/callback";
	const registered = await call(null, "POST", "/api/auth/oauth2/register", {
		client_name: "Claude Code",
		redirect_uris: [redirect],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	});
	assert.equal(registered.status, 201, registered.text);
	const clientId = registered.json.client_id;

	/** One authorization of the client, which asks for consent only the first time. */
	let consentAsked = false;
	async function authorizeOnce(): Promise<string> {
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const query = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirect,
			scope: "openid offline_access",
			state: "s",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: "http://localhost:3000/mcp",
		});
		const authorize = await app.request(`/api/auth/oauth2/authorize?${query}`, {
			headers: { cookie: luis.slice("cookie:".length) },
		});
		let next = new URL(
			authorize.headers.get("location") ?? "",
			"http://localhost:3000",
		);
		consentAsked = next.pathname === "/account/consent/";
		if (consentAsked) {
			const consent = await call(luis, "POST", "/api/auth/oauth2/consent", {
				accept: true,
				oauth_query: next.search.slice(1),
			});
			assert.equal(consent.status, 200, consent.text);
			next = new URL(consent.json.url);
		}
		const code = next.searchParams.get("code");
		assert.ok(code, next.toString());
		const response = await app.request("/api/auth/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirect,
				client_id: clientId,
				code_verifier: verifier,
				resource: "http://localhost:3000/mcp",
			}),
		});
		const tokens = (await response.json()) as any;
		assert.equal(response.status, 200, JSON.stringify(tokens));
		assert.match(tokens.access_token, /^vt_at_/);
		return tokens.access_token;
	}

	const first = await authorizeOnce();
	const second = await authorizeOnce();
	assert.equal((await call(first, "GET", "/api/me")).json.name, "luis");

	const join = (token: string) =>
		call(null, "POST", "/agentwire/join", {
			session: "throwaway",
			name: "luis/claude",
			token,
		});
	assert.deepEqual((await join(first)).json, { account: "luis" });

	const agents = (await call(luis, "GET", "/api/agents")).json.filter(
		(a: any) => a.kind === "oauth",
	);
	assert.equal(agents.length, 2);
	assert.equal(agents[0].name, "Claude Code");
	assert.match(agents[0].id, /^[A-Za-z0-9_-]+$/);
	assert.equal(
		(await call(luis, "DELETE", `/api/agents/${agents[0].id}`)).status,
		204,
	);
	// Both sign-ins can share a second, so either may be listed first: exactly one is cut off.
	const cut = (await join(first)).status === 403 ? first : second;
	const kept = cut === first ? second : first;
	assert.equal((await join(cut)).status, 403);
	assert.equal((await call(cut, "GET", "/api/me")).status, 401);
	assert.deepEqual((await join(kept)).json, { account: "luis" });
	// Revoking took the consent too, so the client asks the person again.
	await authorizeOnce();
	assert.ok(consentAsked);
});

test("the OAuth server and the MCP resource are discoverable", async () => {
	const server = await call(
		null,
		"GET",
		"/.well-known/oauth-authorization-server/api/auth",
	);
	assert.equal(server.status, 200, server.text);
	assert.equal(server.json.issuer, "http://localhost:3000/api/auth");
	const resource = await call(
		null,
		"GET",
		"/.well-known/oauth-protected-resource/mcp",
	);
	assert.equal(resource.status, 200, resource.text);
	assert.equal(resource.json.resource, "http://localhost:3000/mcp");
});

test("a token reaches none of Better Auth's endpoints for sessions, the user, consent or approval", async () => {
	const token = await connect(luis, "walker");
	const routes: [string, string, unknown?][] = [
		["GET", "/api/auth/get-session"],
		["GET", "/api/auth/list-sessions"],
		["POST", "/api/auth/revoke-session", { token: luisToken }],
		["POST", "/api/auth/revoke-sessions", {}],
		["POST", "/api/auth/revoke-other-sessions", {}],
		["POST", "/api/auth/update-user", { name: "someone else" }],
		["POST", "/api/auth/delete-user", {}],
		["GET", "/api/auth/list-accounts"],
		["POST", "/api/auth/unlink-account", { providerId: "github" }],
		["POST", "/api/auth/sign-out", {}],
		["GET", "/api/auth/device?user_code=ABCDEFGH"],
		["POST", "/api/auth/device/approve", { userCode: "ABCDEFGH" }],
		["POST", "/api/auth/device/deny", { userCode: "ABCDEFGH" }],
		["POST", "/api/auth/oauth2/consent", { accept: true, oauth_query: "" }],
		["POST", "/api/auth/oauth2/continue", { postLogin: true }],
		["GET", "/api/auth/oauth2/get-consents"],
		[
			"POST",
			"/api/auth/oauth2/create-client",
			{ redirect_uris: ["https://evil.example/cb"] },
		],
	];
	for (const [method, path, body] of routes)
		assert.equal(
			(await call(token, method, path, body)).status,
			403,
			`${method} ${path}`,
		);
	assert.equal(
		(await call(luis, "GET", "/api/auth/list-sessions")).status,
		200,
	);
	assert.equal((await call(token, "GET", "/api/me")).status, 200);
});

test("only the person adds friends and members, never an agent's token", async () => {
	const token = await connect(ben, "helper");
	assert.equal((await call(token, "PUT", "/api/friends/luis")).status, 403);
	const [room] = (await call(token, "GET", "/api/rooms")).json;
	assert.equal(
		(await call(token, "PUT", `/api/rooms/${room.id}/members/luis`)).status,
		403,
	);
});

test("unfriending takes each out of the other's rooms", async () => {
	const { cookie: carol } = await person("carol");
	await call(luis, "PUT", "/api/friends/carol");
	await call(carol, "PUT", "/api/friends/luis");
	const [room] = (await call(luis, "GET", "/api/rooms")).json;
	assert.deepEqual(
		(await call(luis, "PUT", `/api/rooms/${room.id}/members/carol`)).json
			.members,
		["carol"],
	);
	assert.equal((await call(carol, "DELETE", "/api/friends/luis")).status, 204);
	assert.deepEqual((await call(luis, "GET", "/api/rooms")).json[0].members, []);
});

test("an account owns at most 20 rooms", async () => {
	const { cookie: dora } = await person("dora");
	for (let i = 1; i < 20; i++)
		assert.equal(
			(await call(dora, "POST", "/api/rooms", { name: `r${i}` })).status,
			201,
		);
	assert.equal(
		(await call(dora, "POST", "/api/rooms", { name: "one too many" })).status,
		403,
	);
});

test("a one-time code's page says when and from where it was asked for", async () => {
	const response = await app.request("/api/auth/device/code", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": "203.0.113.7",
		},
		body: JSON.stringify({ client_id: "stranger" }),
	});
	const code = (await response.json()) as any;
	const page = await call(
		luis,
		"GET",
		`/api/auth/device?user_code=${code.user_code}`,
	);
	assert.equal(page.json.client_id, "stranger");
	assert.equal(page.json.from, "203.0.113.7");
	assert.ok(Date.now() - Date.parse(page.json.requested) < 10_000);
});

test("asking for one-time codes is rate limited", async () => {
	const ask = () =>
		app.request("/api/auth/device/code", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "198.51.100.9",
			},
			body: JSON.stringify({ client_id: "flood" }),
		});
	const statuses = [];
	for (let i = 0; i < 12; i++) statuses.push((await ask()).status);
	assert.ok(statuses.includes(429), statuses.join(" "));
});

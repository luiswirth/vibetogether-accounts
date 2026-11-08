import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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

/** A person signed in, by the token of a session of theirs. */
async function person(login: string): Promise<string> {
	const context = await auth.$context;
	const user = await context.internalAdapter.createUser(
		{ email: `${login}@example.com`, name: login, login, emailVerified: true },
		{ method: "admin" },
	);
	const session = await context.internalAdapter.createSession(user.id);
	return session.token;
}

async function call(
	token: string | null,
	method: string,
	path: string,
	body?: unknown,
) {
	const headers = new Headers({ origin: "http://localhost:3000" });
	if (token) headers.set("authorization", `Bearer ${token}`);
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

before(async () => {
	luis = await person("luis");
	ben = await person("ben");
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
	assert.equal((await join("ben", ben)).status, 403);
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
	assert.deepEqual((await join("luis", luis)).json, { account: "luis" });
	assert.equal((await join("ben", luis)).status, 403);
	assert.equal((await join("luis", "no-such-token")).status, 403);
	assert.equal(
		(await call(null, "GET", "/agentwire/sessions/throwaway")).status,
		404,
	);
	const guarded = await call(null, "POST", "/agentwire/join", {
		session: "throwaway",
		name: "luis",
		token: luis,
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
				token: ben,
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
				token: ben,
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
		headers: { authorization: `Bearer ${luis}` },
	});
	const consentUrl = new URL(
		authorize.headers.get("location") ?? (await authorize.text()),
		"http://localhost:3000",
	);
	assert.equal(consentUrl.pathname, "/account/consent/", consentUrl.toString());
	const consent = await call(luis, "POST", "/api/auth/oauth2/consent", {
		accept: true,
		oauth_query: consentUrl.search.slice(1),
	});
	assert.equal(consent.status, 200, consent.text);
	const code = new URL(
		consent.json.url ?? consent.json.redirect_uri,
	).searchParams.get("code");
	assert.ok(code, consent.text);

	const tokenResponse = await app.request("/api/auth/oauth2/token", {
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
	const tokens = (await tokenResponse.json()) as any;
	assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
	assert.match(tokens.access_token, /^vt_at_/);
	assert.equal(
		(await call(tokens.access_token, "GET", "/api/me")).json.name,
		"luis",
	);

	const join = () =>
		call(null, "POST", "/agentwire/join", {
			session: "throwaway",
			name: "luis/claude",
			token: tokens.access_token,
		});
	assert.deepEqual((await join()).json, { account: "luis" });

	const agent = (await call(luis, "GET", "/api/agents")).json.find(
		(a: any) => a.kind === "oauth",
	);
	assert.equal(agent.name, "Claude Code");
	assert.equal(
		(await call(luis, "DELETE", `/api/agents/${agent.id}`)).status,
		204,
	);
	assert.equal((await join()).status, 403);
	assert.equal((await call(tokens.access_token, "GET", "/api/me")).status, 401);
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

import { Hono } from "hono";
import { type Caller, callerOf } from "./caller.ts";
import { db } from "./db.ts";
import { addressOf, createRoom, type RoomRow, sessionOf } from "./rooms.ts";

type Env = { Variables: { caller: Caller } };

type Person = { id: string; login: string; name: string; image: string | null };

function personByLogin(login: string): Person | undefined {
	return db
		.prepare("SELECT id, login, name, image FROM user WHERE login = ?")
		.get(login) as Person | undefined;
}

function loginOf(id: string): string {
	return (
		db.prepare("SELECT login FROM user WHERE id = ?").get(id) as {
			login: string;
		}
	).login;
}

function areFriends(a: string, b: string): boolean {
	return (
		(
			db
				.prepare(
					`SELECT count(*) AS n FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
				)
				.get(a, b, b, a) as { n: number }
		).n === 2
	);
}

async function roomJson(room: RoomRow) {
	const members = db
		.prepare(
			"SELECT u.login FROM member m JOIN user u ON u.id = m.user WHERE m.room = ? ORDER BY u.login",
		)
		.all(room.id) as { login: string }[];
	let address: string | null = null;
	try {
		address = addressOf(await sessionOf(room));
	} catch (error) {
		console.error(`room ${room.id} has no session yet:`, error);
	}
	return {
		id: room.id,
		name: room.name,
		owner: loginOf(room.owner),
		members: members.map((m) => m.login),
		open: room.open,
		address,
	};
}

type RoomInput = { name?: string; open?: RoomRow["open"] };

const roomInputHelp =
	'The body is {"name":"…","open":"members"|"link"}, each optional where the room exists, with a name of at most 100 characters.';

/** A room's name and who it is open to, as a request gives them, or undefined where they are malformed. */
function roomInput(body: unknown): RoomInput | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const { name, open } = body as { name?: unknown; open?: unknown };
	const input: RoomInput = {};
	if (name !== undefined) {
		if (typeof name !== "string") return undefined;
		const trimmed = name.trim();
		if (trimmed.length === 0 || trimmed.length > 100) return undefined;
		input.name = trimmed;
	}
	if (open !== undefined) {
		if (open !== "members" && open !== "link") return undefined;
		input.open = open;
	}
	return input;
}

async function bodyOf(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export const api = new Hono<Env>();

/** The most rooms one account owns, since every room it owns lasts. */
const maxRooms = 20;

/**
 * Whether the request is the person's, signed in in the browser, rather than an agent's with a token.
 * Letting others in, as friends, members or by opening a room to its address, is the person's
 * alone, so that an agent told to by someone else can't give them a seat in its person's rooms.
 */
function isPerson(request: Request): boolean {
	return !request.headers.has("authorization");
}

const onlyThePerson =
	"Only the person does this, signed in in the browser, never with a token.";

api.use(async (c, next) => {
	const caller = await callerOf(c.req.raw.headers);
	if (!caller)
		return c.text(
			"Sign in, or send a token as Authorization: Bearer <token>.",
			401,
		);
	c.set("caller", caller);
	await next();
});

api.get("/me", (c) => {
	const person = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(c.var.caller.id) as Person;
	return c.json({
		name: person.login,
		displayName: person.name,
		image: person.image,
	});
});

// Rooms

function roomOf(id: string): RoomRow | undefined {
	return db.prepare("SELECT * FROM room WHERE id = ?").get(id) as
		| RoomRow
		| undefined;
}

api.get("/rooms", async (c) => {
	const rooms = db
		.prepare(
			`SELECT * FROM room WHERE owner = ? OR id IN (SELECT room FROM member WHERE user = ?) ORDER BY created`,
		)
		.all(c.var.caller.id, c.var.caller.id) as RoomRow[];
	return c.json(await Promise.all(rooms.map(roomJson)));
});

api.post("/rooms", async (c) => {
	const owned = (
		db
			.prepare("SELECT count(*) AS n FROM room WHERE owner = ?")
			.get(c.var.caller.id) as { n: number }
	).n;
	if (owned >= maxRooms)
		return c.text(
			`An account owns at most ${maxRooms} rooms: delete one first.`,
			403,
		);
	const input = roomInput(await bodyOf(c.req.raw));
	if (!input?.name) return c.text(roomInputHelp, 400);
	if (input.open === "link" && !isPerson(c.req.raw))
		return c.text(onlyThePerson, 403);
	return c.json(
		await roomJson(
			await createRoom(c.var.caller.id, input.name, input.open ?? "members"),
		),
		201,
	);
});

api.patch("/rooms/:id", async (c) => {
	const room = roomOf(c.req.param("id"));
	if (!room) return c.text("No such room.", 404);
	if (room.owner !== c.var.caller.id)
		return c.text("Only the room's owner changes it.", 403);
	const input = roomInput(await bodyOf(c.req.raw));
	if (!input) return c.text(roomInputHelp, 400);
	if (input.open === "link" && !isPerson(c.req.raw))
		return c.text(onlyThePerson, 403);
	const changed = { ...room, ...input };
	db.prepare("UPDATE room SET name = ?, open = ? WHERE id = ?").run(
		changed.name,
		changed.open,
		room.id,
	);
	return c.json(await roomJson(changed));
});

api.delete("/rooms/:id", (c) => {
	const room = roomOf(c.req.param("id"));
	if (!room) return c.text("No such room.", 404);
	if (room.owner !== c.var.caller.id)
		return c.text("Only the room's owner deletes it.", 403);
	db.prepare("DELETE FROM room WHERE id = ?").run(room.id);
	return c.body(null, 204);
});

api.put("/rooms/:id/members/:name", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const room = roomOf(c.req.param("id"));
	if (!room) return c.text("No such room.", 404);
	if (room.owner !== c.var.caller.id)
		return c.text("Only the room's owner adds members.", 403);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === room.owner)
		return c.text("The owner is in the room already.", 400);
	if (!areFriends(room.owner, person.id))
		return c.text("Only friends of the owner become members.", 403);
	db.prepare("INSERT OR IGNORE INTO member (room, user) VALUES (?, ?)").run(
		room.id,
		person.id,
	);
	return c.json(await roomJson(room));
});

api.delete("/rooms/:id/members/:name", (c) => {
	const room = roomOf(c.req.param("id"));
	if (!room) return c.text("No such room.", 404);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (room.owner !== c.var.caller.id && person.id !== c.var.caller.id)
		return c.text("Only the owner removes others from a room.", 403);
	db.prepare("DELETE FROM member WHERE room = ? AND user = ?").run(
		room.id,
		person.id,
	);
	return c.body(null, 204);
});

// Friends

api.get("/friends", (c) => {
	const me = c.var.caller.id;
	const rows = db
		.prepare(
			`SELECT u.login, u.name, u.image, mine."from" IS NOT NULL AS added, theirs."from" IS NOT NULL AS addedBy
			 FROM user u
			 LEFT JOIN friend mine ON mine."from" = ? AND mine."to" = u.id
			 LEFT JOIN friend theirs ON theirs."from" = u.id AND theirs."to" = ?
			 WHERE mine."from" IS NOT NULL OR theirs."from" IS NOT NULL
			 ORDER BY u.login`,
		)
		.all(me, me) as {
		login: string;
		name: string;
		image: string | null;
		added: number;
		addedBy: number;
	}[];
	return c.json(
		rows.map((row) => ({
			name: row.login,
			displayName: row.name,
			image: row.image,
			state:
				row.added && row.addedBy ? "friends" : row.added ? "asked" : "asking",
		})),
	);
});

api.put("/friends/:name", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === me)
		return c.text("You can't add yourself as a friend.", 400);
	db.prepare(
		`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
	).run(me, person.id, new Date().toISOString());
	return c.body(null, 204);
});

api.delete("/friends/:name", (c) => {
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	db.prepare(
		`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
	).run(me, person.id, person.id, me);
	// Members are friends of the owner, so they leave each other's rooms too.
	db.prepare(
		"DELETE FROM member WHERE (user = ? AND room IN (SELECT id FROM room WHERE owner = ?)) OR (user = ? AND room IN (SELECT id FROM room WHERE owner = ?))",
	).run(person.id, me, me, person.id);
	return c.body(null, 204);
});

// Tokens: each from an OTP, a Better Auth session named after its machine, or from one sign-in of
// an MCP client, an OAuth grant named after the client.

type AgentSession = { id: string; agent: string; createdAt: string | number };
/** One OAuth grant: the tokens that one authorization issued, refreshed ones included. */
type AgentGrant = {
	grant: string;
	name: string | null;
	createdAt: string | number;
};

// The tokens of one grant, by the authorization code that started it, which refreshing keeps.
const grantKey = "coalesce(t.authorizationCodeId, 'client:' || t.clientId)";

function iso(time: string | number): string {
	return new Date(time).toISOString();
}

api.get("/tokens", (c) => {
	const me = c.var.caller.id;
	const sessions = db
		.prepare(
			"SELECT id, agent, createdAt FROM session WHERE userId = ? AND agent IS NOT NULL AND expiresAt > ?",
		)
		.all(me, Date.now()) as AgentSession[];
	const grants = db
		.prepare(
			`SELECT ${grantKey} AS grant, c.name, min(t.createdAt) AS createdAt
			 FROM (SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthRefreshToken
			       UNION ALL SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthAccessToken) t
			 LEFT JOIN oauthClient c ON c.clientId = t.clientId
			 WHERE t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ?
			 GROUP BY grant ORDER BY createdAt`,
		)
		.all(me, Date.now()) as AgentGrant[];
	return c.json(
		[
			...sessions.map((s) => ({
				id: `s_${s.id}`,
				name: s.agent,
				via: "otp",
				created: iso(s.createdAt),
			})),
			...grants.map((o) => ({
				id: `o_${Buffer.from(o.grant).toString("base64url")}`,
				name: o.name ?? "an MCP client",
				via: "mcp",
				created: iso(o.createdAt),
			})),
		].sort((a, b) => a.created.localeCompare(b.created)),
	);
});

api.delete("/tokens/:id", (c) => {
	const me = c.var.caller.id;
	const id = c.req.param("id");
	if (id.startsWith("s_")) {
		const result = db
			.prepare(
				"DELETE FROM session WHERE id = ? AND userId = ? AND agent IS NOT NULL",
			)
			.run(id.slice(2), me);
		return result.changes ? c.body(null, 204) : c.text("No such token.", 404);
	}
	if (id.startsWith("o_")) {
		const grant = Buffer.from(id.slice(2), "base64url").toString();
		// The consent goes too, so that the client asks the person again rather than getting a token silently.
		const clients = db
			.prepare(
				`SELECT DISTINCT clientId FROM (SELECT authorizationCodeId, clientId, userId FROM oauthRefreshToken
				 UNION ALL SELECT authorizationCodeId, clientId, userId FROM oauthAccessToken) t
				 WHERE ${grantKey} = ? AND userId = ?`,
			)
			.all(grant, me) as { clientId: string }[];
		for (const { clientId } of clients)
			db.prepare(
				"DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
			).run(clientId, me);
		const tokens = db
			.prepare(
				`DELETE FROM oauthAccessToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		const refresh = db
			.prepare(
				`DELETE FROM oauthRefreshToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		return tokens.changes || refresh.changes
			? c.body(null, 204)
			: c.text("No such token.", 404);
	}
	return c.text("No such token.", 404);
});

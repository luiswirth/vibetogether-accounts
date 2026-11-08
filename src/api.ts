import { Hono } from "hono";
import { type Caller, callerOf } from "./caller.ts";
import { db } from "./db.ts";
import { createRoom, linkOf, type RoomRow, sessionOf } from "./rooms.ts";

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
	let link: string | null = null;
	try {
		link = linkOf(await sessionOf(room));
	} catch (error) {
		console.error(`room ${room.id} has no session yet:`, error);
	}
	return {
		id: room.id,
		name: room.name,
		owner: loginOf(room.owner),
		members: members.map((m) => m.login),
		link,
	};
}

function roomName(body: unknown): string | undefined {
	const name = (body as { name?: unknown } | null)?.name;
	if (typeof name !== "string") return undefined;
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : undefined;
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
	const name = roomName(await bodyOf(c.req.raw));
	if (!name)
		return c.text(
			'A room needs a name: {"name":"…"}, of at most 100 characters.',
			400,
		);
	return c.json(await roomJson(await createRoom(c.var.caller.id, name)), 201);
});

api.patch("/rooms/:id", async (c) => {
	const room = roomOf(c.req.param("id"));
	if (!room) return c.text("No such room.", 404);
	if (room.owner !== c.var.caller.id)
		return c.text("Only the room's owner renames it.", 403);
	const name = roomName(await bodyOf(c.req.raw));
	if (!name)
		return c.text(
			'A room needs a name: {"name":"…"}, of at most 100 characters.',
			400,
		);
	db.prepare("UPDATE room SET name = ? WHERE id = ?").run(name, room.id);
	return c.json(await roomJson({ ...room, name }));
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
			`SELECT u.login, u.name, u.image, mine.agents AS agents,
			        mine."from" IS NOT NULL AS added, theirs."from" IS NOT NULL AS addedBy
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
		agents: string | null;
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
			agents: row.agents ?? "fyi",
		})),
	);
});

api.put("/friends/:name", async (c) => {
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === me)
		return c.text("You can't add yourself as a friend.", 400);
	const body = await bodyOf(c.req.raw);
	const agents = (body as { agents?: unknown } | null)?.agents;
	if (
		body === undefined ||
		(agents !== undefined && agents !== "ping" && agents !== "fyi")
	)
		return c.text(
			'The body is empty, or {"agents":"ping"} or {"agents":"fyi"}.',
			400,
		);
	db.prepare(
		`INSERT INTO friend ("from", "to", agents, created) VALUES (?, ?, ?, ?)
		 ON CONFLICT ("from", "to") DO UPDATE SET agents = coalesce(?, agents)`,
	).run(
		me,
		person.id,
		agents ?? "fyi",
		new Date().toISOString(),
		agents ?? null,
	);
	return c.body(null, 204);
});

api.delete("/friends/:name", (c) => {
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	db.prepare(
		`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
	).run(me, person.id, person.id, me);
	return c.body(null, 204);
});

// Agents

type AgentSession = { id: string; agent: string; createdAt: string | number };
type AgentClient = {
	clientId: string;
	name: string | null;
	createdAt: string | number;
};

function iso(time: string | number): string {
	return new Date(time).toISOString();
}

api.get("/agents", (c) => {
	const me = c.var.caller.id;
	const sessions = db
		.prepare(
			"SELECT id, agent, createdAt FROM session WHERE userId = ? AND agent IS NOT NULL AND expiresAt > ?",
		)
		.all(me, Date.now()) as AgentSession[];
	const clients = db
		.prepare(
			`SELECT t.clientId, c.name, min(t.createdAt) AS createdAt FROM oauthRefreshToken t
			 LEFT JOIN oauthClient c ON c.clientId = t.clientId
			 WHERE t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ?
			 GROUP BY t.clientId`,
		)
		.all(me, Date.now()) as AgentClient[];
	return c.json([
		...sessions.map((s) => ({
			id: `s_${s.id}`,
			name: s.agent,
			kind: "code",
			created: iso(s.createdAt),
		})),
		...clients.map((o) => ({
			id: `o_${o.clientId}`,
			name: o.name ?? o.clientId,
			kind: "oauth",
			created: iso(o.createdAt),
		})),
	]);
});

api.delete("/agents/:id", (c) => {
	const me = c.var.caller.id;
	const id = c.req.param("id");
	if (id.startsWith("s_")) {
		const result = db
			.prepare(
				"DELETE FROM session WHERE id = ? AND userId = ? AND agent IS NOT NULL",
			)
			.run(id.slice(2), me);
		return result.changes ? c.body(null, 204) : c.text("No such agent.", 404);
	}
	if (id.startsWith("o_")) {
		const client = id.slice(2);
		const tokens = db
			.prepare("DELETE FROM oauthAccessToken WHERE clientId = ? AND userId = ?")
			.run(client, me);
		const refresh = db
			.prepare(
				"DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?",
			)
			.run(client, me);
		db.prepare(
			"DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
		).run(client, me);
		return tokens.changes || refresh.changes
			? c.body(null, 204)
			: c.text("No such agent.", 404);
	}
	return c.text("No such agent.", 404);
});

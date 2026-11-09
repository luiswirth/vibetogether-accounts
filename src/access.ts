import { Hono } from "hono";
import { callerOfToken } from "./caller.ts";
import { db } from "./db.ts";
import { isAgentOf } from "./names.ts";

/**
 * The relay's access service: whether a name may join a session, with a token or without,
 * and whether an owned session is still a room. Reached on the loopback only.
 */
export const access = new Hono();

type Room = { id: string; owner: string; open: "members" | "link" };

function roomBySession(session: string): Room | undefined {
	return db
		.prepare("SELECT id, owner, open FROM room WHERE session = ?")
		.get(session) as Room | undefined;
}

function isInRoom(room: Room, user: string): boolean {
	return (
		room.owner === user ||
		db
			.prepare("SELECT 1 FROM member WHERE room = ? AND user = ?")
			.get(room.id, user) !== undefined
	);
}

access.post("/join", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		session?: unknown;
		name?: unknown;
		token?: unknown;
		owned?: unknown;
	} | null;
	const session = body?.session;
	const name = body?.name;
	const token = body?.token ?? null;
	if (
		typeof session !== "string" ||
		typeof name !== "string" ||
		(token !== null && typeof token !== "string")
	)
		return c.text(
			'The body is {"session":"…","name":"…","token":"…"|null,"owned":true|false}.',
			400,
		);
	const caller = token ? await callerOfToken(token) : undefined;
	if (token && !caller)
		return c.text(
			"The token is no valid token: it was revoked, or it expired.",
			403,
		);
	if (caller && !isAgentOf(name, caller.login))
		return c.text(
			`The token is ${caller.login}'s, so it joins only as ${caller.login}/<agent>.`,
			403,
		);
	const room = roomBySession(session);
	// The service owns every owned session as a room, so one it doesn't know was deleted.
	if (!room && body?.owned === true)
		return c.text("This room was deleted.", 403);
	if (room?.open === "members") {
		if (!caller)
			return c.text(
				"This room is open to its members only: join with a token of your account, as Authorization: Bearer <token>.",
				403,
			);
		if (!isInRoom(room, caller.id))
			return c.text(`${caller.login} is no member of this room.`, 403);
	}
	return c.json({ account: caller?.login ?? null });
});

access.get("/sessions/:session", (c) =>
	roomBySession(c.req.param("session"))
		? c.json({})
		: c.text("No such room.", 404),
);

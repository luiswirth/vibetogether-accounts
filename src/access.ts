import { Hono } from "hono";
import { callerOfToken } from "./caller.ts";
import { db } from "./db.ts";
import { isUnder } from "./names.ts";

/**
 * The relay's access service: whether a token may take part in a session under a name,
 * and whether a session lasts. Reached on the loopback only.
 */
export const access = new Hono();

type Room = { id: string; owner: string };

function roomBySession(session: string): Room | undefined {
	return db
		.prepare("SELECT id, owner FROM room WHERE session = ?")
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
		guarded?: unknown;
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
			'The body is {"session":"…","name":"…","token":"…"|null}.',
			400,
		);
	const caller = token ? await callerOfToken(token) : undefined;
	if (token && !caller)
		return c.text(
			"The token is no valid token: it was revoked, or it expired.",
			403,
		);
	if (caller && !isUnder(name, caller.login))
		return c.text(
			`The token is ${caller.login}'s, so it joins as ${caller.login} or ${caller.login}/<agent>.`,
			403,
		);
	const room = roomBySession(session);
	// A guarded session is meant to be a room, so one that is none lets no one in.
	if (!room && body?.guarded === true)
		return c.text("This session is guarded, but it is no room.", 403);
	if (room && !caller)
		return c.text(
			"This room is only for its members: join with a token of your account, as Authorization: Bearer <token>.",
			403,
		);
	if (room && caller && !isInRoom(room, caller.id))
		return c.text(`${caller.login} is no member of this room.`, 403);
	return c.json({ account: caller?.login ?? null });
});

access.get("/sessions/:session", (c) => {
	const room = roomBySession(c.req.param("session"));
	return room ? c.json({ lasting: true }) : c.json({ lasting: false }, 404);
});

import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db } from "./db.ts";

export type RoomRow = {
	id: string;
	name: string;
	owner: string;
	session: string | null;
	created: string;
};

export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** A new guarded session on the relay, so that the relay asks this service about it, by the token in its link. */
async function createSession(): Promise<string> {
	const response = await fetch(`${config.relay}/v2/s?guarded`, {
		method: "POST",
	});
	if (!response.ok)
		throw new Error(
			`the relay answered ${response.status} to creating a session`,
		);
	const link = (await response.text()).trim();
	const token = link.split("/").pop();
	if (!token) throw new Error(`the relay returned no link: ${link}`);
	return token;
}

/**
 * The room's session, created on the relay where it has none yet,
 * such as when the relay could not be reached as the room was created.
 */
export async function sessionOf(room: RoomRow): Promise<string> {
	if (room.session) return room.session;
	const session = await createSession();
	db.prepare(
		"UPDATE room SET session = ? WHERE id = ? AND session IS NULL",
	).run(session, room.id);
	const stored = db
		.prepare("SELECT session FROM room WHERE id = ?")
		.get(room.id) as { session: string } | undefined;
	return stored?.session ?? session;
}

export async function createRoom(
	owner: string,
	name: string,
): Promise<RoomRow> {
	const room: RoomRow = {
		id: newId("r"),
		name,
		owner,
		session: null,
		created: new Date().toISOString(),
	};
	db.prepare(
		"INSERT INTO room (id, name, owner, session, created) VALUES (?, ?, ?, ?, ?)",
	).run(room.id, room.name, room.owner, room.session, room.created);
	try {
		room.session = await sessionOf(room);
	} catch (error) {
		console.error(`room ${room.id} has no session yet:`, error);
	}
	return room;
}

export function linkOf(session: string): string {
	return `${config.relay}/v2/s/${session}`;
}

import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** One database, shared with Better Auth, whose tables are its own. */
export const db = new DatabaseSync(config.database);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
`);

/** The tables of rooms and friends, which refer to Better Auth's users. */
export function migrate(): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS room (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			session TEXT UNIQUE,
			created TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS member (
			room TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY (room, user)
		);
		-- Who asked for a one-time code, for the person to judge before approving it.
		CREATE TABLE IF NOT EXISTS device_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL
		);
		-- One row per side: "from" added "to", and decides whether the agents of "to" ping its own.
		-- Two people are friends where both rows exist.
		CREATE TABLE IF NOT EXISTS friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			agents TEXT NOT NULL CHECK (agents IN ('ping', 'fyi')),
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
	`);
}

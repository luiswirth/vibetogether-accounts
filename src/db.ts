import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** One database, shared with Better Auth, whose tables are its own. */
export const db = new DatabaseSync(config.database);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
`);

function hasColumn(table: string, column: string): boolean {
	return (
		db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
			name: string;
		}[]
	).some((c) => c.name === column);
}

/** The tables of rooms and friends, which refer to Better Auth's users. */
export function migrate(): void {
	db.exec(`
		-- "session" is the token of the room's session on the relay, the secret part of its address.
		-- "open" is who may join: its members only, or anyone with its address.
		CREATE TABLE IF NOT EXISTS room (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			session TEXT UNIQUE,
			created TEXT NOT NULL,
			open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link'))
		);
		CREATE TABLE IF NOT EXISTS member (
			room TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY (room, user)
		);
		-- Who asked for an OTP, for the person to judge before approving it.
		CREATE TABLE IF NOT EXISTS device_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL
		);
		-- One row per side: "from" added "to". Two people are friends where both rows exist.
		CREATE TABLE IF NOT EXISTS friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
	`);
	// Databases from before a room could be open by link, and before friends had no setting.
	if (!hasColumn("room", "open"))
		db.exec(
			"ALTER TABLE room ADD COLUMN open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link'))",
		);
	if (hasColumn("friend", "agents"))
		db.exec("ALTER TABLE friend DROP COLUMN agents");
}

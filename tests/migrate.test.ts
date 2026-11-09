import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database as production's was before rooms had `open` and friends lost their setting (accounts a7dcf2a).
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec(`
	CREATE TABLE user (id TEXT PRIMARY KEY);
	CREATE TABLE room (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		session TEXT UNIQUE,
		created TEXT NOT NULL
	);
	CREATE TABLE friend (
		"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		agents TEXT NOT NULL CHECK (agents IN ('ping', 'fyi')),
		created TEXT NOT NULL,
		PRIMARY KEY ("from", "to")
	);
	INSERT INTO user VALUES ('a'), ('b');
	INSERT INTO room VALUES ('r_1', 'ben', 'a', 'secret', '2026-11-09T00:00:00Z');
	INSERT INTO friend VALUES ('a', 'b', 'ping', '2026-11-09T00:00:00Z');
`);
old.close();

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: database,
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: "http://127.0.0.1:1",
});

test("an existing room stays open to its members only, and friends keep each other", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	assert.deepEqual(
		db
			.prepare("SELECT id, session, open FROM room")
			.all()
			.map((r) => ({ ...r })),
		[{ id: "r_1", session: "secret", open: "members" }],
	);
	assert.deepEqual(
		db
			.prepare("SELECT * FROM friend")
			.all()
			.map((r) => ({ ...r })),
		[{ from: "a", to: "b", created: "2026-11-09T00:00:00Z" }],
	);
});

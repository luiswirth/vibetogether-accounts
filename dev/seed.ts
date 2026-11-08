// Signs a person in on a local instance, where GitHub can't call back:
// creates the account where it doesn't exist, and prints a session's token and its cookie.
import { serializeSignedCookie } from "better-call";
import { auth } from "../src/auth.ts";
import { db } from "../src/db.ts";

const login = process.argv[2];
if (!login) throw new Error("usage: seed <login>");

const context = await auth.$context;
const existing = db.prepare("SELECT id FROM user WHERE login = ?").get(login) as
	| { id: string }
	| undefined;
const userId =
	existing?.id ??
	(
		await context.internalAdapter.createUser(
			{ email: `${login}@localhost`, name: login, login, emailVerified: true },
			{ method: "admin" },
		)
	).id;
const session = await context.internalAdapter.createSession(userId);
const cookie = await serializeSignedCookie(
	context.authCookies.sessionToken.name,
	session.token,
	context.secret,
);
console.log(`token: ${session.token}`);
console.log(`cookie: ${cookie.split(";")[0]}`);

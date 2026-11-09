import { auth, oauthAccessTokenPrefix, tokenHash } from "./auth.ts";
import { db } from "./db.ts";

export type Caller = { id: string; login: string };

type UserRow = { id: string; login: string };

function bearerOf(headers: Headers): string | undefined {
	const header = headers.get("authorization");
	const match = header?.match(/^bearer\s+(.+)$/i);
	return match?.[1]?.trim();
}

/** An OAuth access token's account, while the token is neither expired nor revoked. */
function oauthCaller(token: string): Caller | undefined {
	const row = db
		.prepare(
			`SELECT u.id, u.login FROM oauthAccessToken t JOIN user u ON u.id = t.userId
			 WHERE t.token = ? AND t.expiresAt > ? AND t.revoked IS NULL`,
		)
		.get(tokenHash(token.slice(oauthAccessTokenPrefix.length)), Date.now()) as
		| UserRow
		| undefined;
	return row && { id: row.id, login: row.login };
}

/**
 * The account a request is from: by the session cookie, or a bearer token,
 * which is a session token from an OTP or an OAuth access token.
 */
export async function callerOf(headers: Headers): Promise<Caller | undefined> {
	const bearer = bearerOf(headers);
	if (bearer?.startsWith(oauthAccessTokenPrefix)) return oauthCaller(bearer);
	const session = await auth.api.getSession({ headers });
	if (!session) return undefined;
	return {
		id: session.user.id,
		login: (session.user as { login: string }).login,
	};
}

/** The account a token belongs to, as the relay presents it. */
export function callerOfToken(token: string): Promise<Caller | undefined> {
	return callerOf(new Headers({ authorization: `Bearer ${token}` }));
}

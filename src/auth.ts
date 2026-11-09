import { createHash } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { config } from "./config.ts";
import { db, migrate } from "./db.ts";
import { isNamePart } from "./names.ts";
import { createRoom } from "./rooms.ts";

/** The hash under which the OAuth provider stores a token, which `caller` looks tokens up by. */
export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

export const oauthAccessTokenPrefix = "vt_at_";

const day = 24 * 60 * 60;

const options = {
	baseURL: config.url,
	basePath: "/api/auth",
	secret: config.secret,
	database: db,
	trustedOrigins: [config.url],
	// On everywhere, not only where NODE_ENV is production. Caddy sets X-Forwarded-For to the client.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		customRules: {
			"/device/code": { window: 60, max: 10 },
			"/oauth2/register": { window: 3600, max: 20 },
			"/sign-in/social": { window: 60, max: 10 },
		},
	},
	socialProviders: {
		github: {
			clientId: config.github.clientId,
			clientSecret: config.github.clientSecret,
			mapProfileToUser: (profile) => ({ login: profile.login.toLowerCase() }),
		},
	},
	user: {
		additionalFields: {
			// The person's name in agentwire, from their GitHub login.
			login: { type: "string", required: true, unique: true, input: false },
		},
	},
	session: {
		// A session from a one-time code is an agent's token, which lives while it is used.
		expiresIn: 90 * day,
		updateAge: day,
		additionalFields: {
			agent: { type: "string", required: false, input: false },
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await createRoom(user.id, "agents");
				},
			},
		},
		session: {
			create: {
				before: async (session, ctx) => {
					if (ctx?.path !== "/device/token") return;
					return { data: { ...session, agent: ctx.body.client_id } };
				},
			},
		},
	},
	plugins: [
		bearer(),
		deviceAuthorization({
			verificationUri: `${config.url}/account/device/`,
			validateClient: isNamePart,
			expiresIn: "15m",
		}),
		mcp({
			resource: `${config.url}/mcp`,
			loginPage: "/account/sign-in/",
			consentPage: "/account/consent/",
			// Opaque tokens only, so that revoking one cuts its agent off at once.
			disableJwtPlugin: true,
			storeTokens: { hash: async (token) => tokenHash(token) },
			prefix: {
				opaqueAccessToken: oauthAccessTokenPrefix,
				refreshToken: "vt_rt_",
			},
			scopes: ["openid", "profile", "offline_access"],
			// MCP clients that predate Client ID Metadata Documents still register themselves.
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			clientRegistrationDefaultApplicationType: "infer",
		}),
		cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
	],
} satisfies BetterAuthOptions;

// Before Better Auth starts, since it checks the schema as it does.
await (await getMigrations(options)).runMigrations();
migrate();

export const auth = betterAuth(options);

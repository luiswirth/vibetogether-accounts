import { readFileSync } from "node:fs";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** A secret, from the file that `<name>_FILE` names, or from `<name>` itself. */
function secret(name: string): string {
	const file = process.env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trim() : required(name);
}

export const config = {
	/** Where the service is reached from outside, such as `https://vibetogether.agentics.lwirth.com`. */
	url: required("ACCOUNTS_URL").replace(/\/$/, ""),
	port: Number(process.env.ACCOUNTS_PORT ?? 3000),
	database: required("ACCOUNTS_DATABASE"),
	secret: secret("ACCOUNTS_SECRET"),
	github: {
		clientId: required("GITHUB_CLIENT_ID"),
		clientSecret: secret("GITHUB_CLIENT_SECRET"),
	},
	/** The relay the rooms live on, as its participants reach it. */
	relay: required("AGENTWIRE_RELAY").replace(/\/$/, ""),
};

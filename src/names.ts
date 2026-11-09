/** One part of an agentwire name: `a` to `z`, digits and hyphens, starting with a letter or digit. */
export function isNamePart(part: string): boolean {
	return part.length <= 256 && /^[a-z0-9][a-z0-9-]*$/.test(part);
}

/**
 * Whether `name` is one of the person `login`'s agents, as `<login>/<agent>`.
 * A token is always an agent's, so it never takes the person's own name: that is the person's alone.
 */
export function isAgentOf(name: string, login: string): boolean {
	const [person, agent, ...rest] = name.split("/");
	return (
		person === login &&
		agent !== undefined &&
		isNamePart(agent) &&
		rest.length === 0
	);
}

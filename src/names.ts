/** One part of an agentwire name: `a` to `z`, digits and hyphens, starting with a letter or digit. */
export function isNamePart(part: string): boolean {
	return part.length <= 256 && /^[a-z0-9][a-z0-9-]*$/.test(part);
}

/** Whether `name` is the person `login` or one of their agents, as `<login>/<agent>`. */
export function isUnder(name: string, login: string): boolean {
	if (name === login) return true;
	const [person, agent, ...rest] = name.split("/");
	return (
		person === login &&
		agent !== undefined &&
		isNamePart(agent) &&
		rest.length === 0
	);
}

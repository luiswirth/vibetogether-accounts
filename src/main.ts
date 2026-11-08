import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { config } from "./config.ts";

serve(
	{ fetch: app.fetch, hostname: "127.0.0.1", port: config.port },
	(info) => {
		console.log(`listening on 127.0.0.1:${info.port}, for ${config.url}`);
	},
);

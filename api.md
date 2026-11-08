# Vibe Together accounts

The account service of Vibe Together: people sign in with GitHub, and their account holds their rooms, their friends and their agents' tokens.
It is served under `https://vibetogether.agentics.lwirth.com/api/`.
A person through the account page and an agent through `curl` use the same requests.

## Who calls

Every request under `/api/` is from an account, by one of:

- the session cookie, which signing in sets, for the account page;
- `Authorization: Bearer <token>`, for everything else.

A request without either is answered with 401.

A token is an agent's.
An agent gets one in one of two ways:

- With a one-time code, for an agent with only a shell, or a messenger: see "Connecting an agent".
- With OAuth, for an agent through the MCP server, whose MCP client does it on its own.

A token acts for the whole account, as the person does.
It lasts until it is revoked; one from a code also ends after 90 days unused.

## The account

A person's name is their GitHub login in lower case, such as `luiswirth`.
It is their name in agentwire, and their agents take part as `<name>/<agent>`, such as `luiswirth/claude`.

`GET /api/me`

```json
{"name":"luiswirth","displayName":"Luis Wirth","image":"https://avatars.githubusercontent.com/u/…"}
```

## Rooms

A room is a lasting agentwire session, with a name, an owner and members.
Only its owner and its members join it, each as themselves or as one of their agents.
Its first room, `agents`, is created with the account, for the person's own agents.

`GET /api/rooms`: the rooms the caller owns or is a member of.

```json
[{"id":"r_8f2k…","name":"agents","owner":"luiswirth","members":[],"link":"https://agentwire.agentics.lwirth.com/v2/s/<token>"}]
```

`members` holds everyone but the owner.
`link` is the session's link: join it as the transport says, with the token as `Authorization: Bearer <token>` on the join.

- `POST /api/rooms` with `{"name":"…"}`: creates a room, owned by the caller, and returns it.
- `PATCH /api/rooms/<id>` with `{"name":"…"}`: renames it. Owner only.
- `DELETE /api/rooms/<id>`: deletes it. Owner only. The session is deleted once it is idle, as any other session is.
- `PUT /api/rooms/<id>/members/<name>`: adds a friend of the owner. Owner only.
- `DELETE /api/rooms/<id>/members/<name>`: removes a member. The owner removes anyone, a member themselves.

## Friends

Friends are mutual: two people are friends once each has added the other.
Each sets, for each friend, whether the friend's agents may wake their own agents (`ping`) or only inform them (`fyi`).

`GET /api/friends`

```json
[{"name":"benarmstrong","displayName":"Benedict Armstrong","image":"…","state":"friends","agents":"ping"}]
```

`state` is `friends`, `asked` (the caller added them, they haven't added the caller yet) or `asking` (they added the caller).
`agents` is the caller's setting for them.

- `PUT /api/friends/<name>`, with `{"agents":"ping"|"fyi"}` or no body: adds them, which accepts where they asked first, or changes the setting. `agents` is `fyi` where never set.
- `DELETE /api/friends/<name>`: removes them, which also declines or withdraws.

The setting is for the clients of the caller's agents to honour:
a chat message from a friend's agent that pings one of the caller's agents counts as an fyi where the setting is `fyi`.

## Agents

`GET /api/agents`: the agents holding a token of the caller's.

```json
[{"id":"s_…","name":"claude","kind":"code","created":"2026-11-09T00:10:00Z"},
 {"id":"o_…","name":"Claude Code","kind":"oauth","created":"2026-11-09T00:12:00Z"}]
```

`name` is the name the agent connected with (`code`) or the name of its MCP client (`oauth`).

- `DELETE /api/agents/<id>`: revokes the token. The agent is cut off at once, in its rooms too.

## Connecting an agent

An agent with a shell connects with a one-time code, RFC 8628's device authorization:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"client_id":"<agent>"}' https://vibetogether.agentics.lwirth.com/api/auth/device/code
```

`<agent>` is the agent's own part of its name, such as `claude`.
It returns `user_code`, `verification_uri_complete`, `device_code` and `interval`.
The agent gives its person the link in `verification_uri_complete`, where they sign in and approve the code.
Meanwhile it asks for the token every `interval` seconds:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"<agent>"}' \
  https://vibetogether.agentics.lwirth.com/api/auth/device/token
```

Until the person approves, it answers 400 with `{"error":"authorization_pending"}`; then with `{"access_token":"<token>",…}`.

## Signing in

These are Better Auth's own endpoints, under `/api/auth/`; the account page calls them.

- Sign in: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/"}`, which returns `{"url":…,"redirect":true}`: go to `url`.
- Sign out: `POST /api/auth/sign-out`.
- The one-time code: `GET /api/auth/device?user_code=<code>` claims it for the signed-in caller, and returns the agent that asks as `client_id`.
  Then `POST /api/auth/device/approve` or `/api/auth/device/deny` with `{"userCode":"<code>"}`.
  The page is `/account/device/?user_code=<code>`.
- OAuth, for MCP clients: the authorization server's endpoints are under `/api/auth/oauth2/`, its metadata at `/.well-known/oauth-authorization-server/api/auth`.
  It sends the person to two pages, each with a signed query, which the page passes on whole as `oauth_query` (the query string without its `?`):
  - `/account/sign-in/?…`: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/","oauth_query":"…"}`, then go to `url`. After GitHub, Better Auth goes on with the authorization by itself.
  - `/account/consent/?…`, whose query names the asking client as `client_id` and the scopes as `scope`. `GET /api/auth/oauth2/public-client?client_id=<id>` gives its `client_name`.
    `POST /api/auth/oauth2/consent` with `{"accept":true|false,"oauth_query":"…"}` returns `{"redirect":true,"url":…}`: go to `url`.

## The MCP server

The MCP server is the protected resource `https://vibetogether.agentics.lwirth.com/mcp`.
Its metadata, per RFC 9728, is served by this service at `/.well-known/oauth-protected-resource/mcp`.
It answers a request without a valid token with 401 and `WWW-Authenticate: Bearer resource_metadata="https://vibetogether.agentics.lwirth.com/.well-known/oauth-protected-resource/mcp"`.
It checks a token with `GET /api/me`, and joins rooms with the agent's token as the bearer.

## The relay

The relay asks this service, as its access service, on the loopback only:

- `POST /agentwire/join` with `{"session":"<token in the link>","name":"<name>","token":"<token>"|null}`:
  200 with `{"account":"<name>"|null}` where the name may take part, 403 with one line of text where not.
  A token, where one is given, must be valid, and the name that person's or one of their agents', and `account` is that person's name.
  A session that is no room is open to anyone, a name without a token included, as without accounts: the account is what verifies a name.
  A room is open only to a token of its owner or of a member.
  The relay asks this again for every request of a participant that joined with a token, so a revoked token is cut off.
- `GET /agentwire/sessions/<token in the link>`: `{"lasting":true}` for a room, 404 for any other session.

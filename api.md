# Vibe Together accounts

The account service of Vibe Together: people sign in with GitHub, and their account holds their rooms, their friends and their tokens.
It is served under `https://vibetogether.agentics.lwirth.com/api/`.
A person through the account page and an agent through `curl` use the same requests.

## Who calls

Every request under `/api/` is from an account, by one of:

- the session cookie, which signing in sets, for the account page;
- `Authorization: Bearer <token>`, for everything else.

A request without either is answered with 401.

A token acts for the whole account, as the person does, held by an agent or its harness.
It is created in one of two ways:

- With an OTP, which the person approves, for an agent with a shell, or a messenger: see "Getting a token".
- By an MCP client signing in, for an agent through the MCP server, which its client does on its own.

It lasts until it is revoked; one from an OTP also ends after 90 days unused.

## The account

A person's name is their GitHub login in lower case, such as `luiswirth`.
It is their name in agentwire, and their agents take part as `<name>/<agent>`, such as `luiswirth/claude`.

`GET /api/me`

```json
{"name":"luiswirth","displayName":"Luis Wirth","image":"https://avatars.githubusercontent.com/u/…"}
```

## Rooms

A room is an agentwire session. One an account owns lasts, with a name and members.
Its address is hard to guess: it identifies the room, and is its secret.
A room is open to its members only, the owner included, or to anyone with its address, as its owner sets; members only by default.
In either, a token verifies the name it joins under, which is one of the person's agents', `<name>/<agent>`: a token is always an agent's, so it never joins as the person.
An account starts with no room.

`GET /api/rooms`: the rooms the caller owns or is a member of.

```json
[{"id":"r_8f2k…","name":"ben","owner":"luiswirth","members":["benarmstrong"],"open":"members","address":"https://agentwire.agentics.lwirth.com/v2/s/<secret>"}]
```

`members` holds everyone but the owner.
`open` is `members` or `link`.
Join a room at its `address` as the transport says, with the token as `Authorization: Bearer <token>` on the join.

- `POST /api/rooms` with `{"name":"…"}`, and `"open"` where it isn't `members`: creates a room, owned by the caller, and returns it.
- `PATCH /api/rooms/<id>` with `{"name":"…"}`, `{"open":"members"|"link"}` or both: changes it. Owner only.
- `DELETE /api/rooms/<id>`: deletes it. Owner only. Nobody joins it any more, and the relay deletes it once nobody is in it.
- `PUT /api/rooms/<id>/members/<name>`: adds a friend of the owner. Owner only.
- `DELETE /api/rooms/<id>/members/<name>`: removes a member. The owner removes anyone, a member themselves.

## Friends

Friends are mutual: two people are friends once each has added the other.
Only friends of a room's owner become its members.

`GET /api/friends`

```json
[{"name":"benarmstrong","displayName":"Benedict Armstrong","image":"…","state":"friends"}]
```

`state` is `friends`, `asked` (the caller added them, they haven't added the caller yet) or `asking` (they added the caller).
- `PUT /api/friends/<name>`: adds them, which accepts where they asked first.
- `DELETE /api/friends/<name>`: removes them, which also declines or withdraws, and takes each out of the other's rooms.

Adding friends and members, and opening a room to its address, is the person's alone, signed in in the browser: a token gets 403.

## Tokens

`GET /api/tokens`: the caller's tokens, oldest first.

```json
[{"id":"s_…","name":"lwirth-server","via":"otp","created":"2026-11-09T00:10:00Z"},
 {"id":"o_…","name":"Claude Code","via":"mcp","created":"2026-11-09T00:12:00Z"}]
```

A token from an OTP (`via` is `otp`) is its machine's, which every agent on it uses under whatever name it joins with: `name` is the machine's name, which the agent asked for the OTP with.
One from an MCP client signing in (`via` is `mcp`) is that client's: `name` is the client's name, so two Claude Codes signed in are two tokens.
`id` needs no encoding in a path.

- `DELETE /api/tokens/<id>`: revokes the token. The service refuses it at once, and the relay cuts its agent off within a few seconds, a receive already waiting included.
  An MCP client then asks the person again before it gets another.

## Getting a token

An agent with a shell gets a token with an OTP, RFC 8628's device authorization:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"client_id":"<machine>"}' https://vibetogether.agentics.lwirth.com/api/auth/device/code
```

`<machine>` is the machine's hostname, in lower case, such as `lwirth-server`: the token is the machine's, kept in a file there for every agent on it.
It returns `user_code`, `verification_uri_complete`, `device_code` and `interval`.
The agent gives its person the link in `verification_uri_complete`, where they sign in and approve the OTP.
Meanwhile it asks for the token every `interval` seconds:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"<machine>"}' \
  https://vibetogether.agentics.lwirth.com/api/auth/device/token
```

Until the person approves, it answers 400 with `{"error":"authorization_pending"}`; then with `{"access_token":"<token>",…}`.

## Signing in

These are Better Auth's own endpoints, under `/api/auth/`; the account page calls them.

- Sign in: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/"}`, which returns `{"url":…,"redirect":true}`: go to `url`.
- Sign out: `POST /api/auth/sign-out`.
- The OTP: `GET /api/auth/device?user_code=<code>` claims it for the signed-in caller, and returns the machine that asks as `client_id`, and when and from which address it asked as `requested` and `from`.
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
It checks a token with `GET /api/me`, lists rooms with `GET /api/rooms`, and joins rooms with the agent's token as the bearer.

## The relay

The relay asks this service, as its access service, on the loopback only:

- `POST /agentwire/join` with `{"session":"<the secret in the address>","name":"<name>","token":"<token>"|null,"owned":true|false}`:
  200 with `{"account":"<name>"|null}` where the name may take part, 403 with one line of text where not.
  A token, where one is given, must be valid, and the name one of that person's agents', `<name>/<agent>`, never the person's own; `account` is that person's name.
  A room open to its members takes only a token of its owner or of a member; any other session takes anyone.
  Rooms are the owned sessions, which this service creates with `POST <relay>/v2/s?owned`; an owned session that is no room any more was deleted, and takes no one.
  The relay asks this again for every request of a participant in an owned session or with a token, so a revoked token is cut off.
- `GET /agentwire/sessions/<the secret in the address>`: 200 for a room, which keeps it, and 404 for any other session.

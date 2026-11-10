# Running the pool controller with Docker

Four containers, defined in `docker-compose.yml`:

- **caddy** serves https on 443 (and redirects 80 to it), with a certificate from Let's Encrypt.
  The REST API is at `/rhbroberg/pool-api/1.0.0` there, through the web service, so the iOS app
  needs only the hostname.
- **web** is the web page; it forwards the REST API to the pool server, so the page and the iOS
  app use the same address. It forwards the live updates too: socket.io's WebSocket at
  `/socket.io/`, which shows changes as the controller reports them. Caddy passes WebSocket
  upgrades on without any setting of its own.
- **pool** is the pool server, talking to the controller over the RS-485 adapter.
- **mongo** keeps history and accounts in `/data/db` on the host. No port is published; only the
  pool server reaches it.

The web and pool images are [distroless](https://github.com/GoogleContainerTools/distroless):
Node and the app, with no shell or package manager, so `docker compose exec pool sh` doesn't work.
Node does, though it isn't on the `PATH`:
`docker compose exec pool /nodejs/bin/node -e 'console.log(process.version)'`. For a shell, put
the base image's `:debug` tag, which adds busybox, on the Dockerfile's last `FROM` and rebuild.

Settings are in `.env`. The two secrets come from the shell that runs `docker compose`, never a
committed file:

- `POOL_JWT_SECRET` signs login tokens.
- `POOL_HE_DDNS_KEY` is the dynamic DNS key of the `_acme-challenge` TXT record (below).

On the Pi:

    export POOL_JWT_SECRET=... POOL_HE_DDNS_KEY=...
    make up        # docker compose build --pull, then up -d
    make logs
    make down

The containers restart with the Pi, keeping the secrets they were created with; export them again
only to recreate a container, after changing `.env` or pulling a new version.

`make` also passes the git commit of the checkout, with `-dirty` if it has uncommitted changes, into
the images as `POOL_GIT_COMMIT`; the page's and the app's Settings show it, and so does
`GET /system/info`. Running `docker compose` directly builds images that report `unknown` unless
`POOL_GIT_COMMIT` is exported first.

## Checking the images for vulnerabilities

    make scout

builds the images the compose file builds (pool, web and caddy, on freshly pulled base images)
and fails if [Docker Scout](https://docs.docker.com/scout/) finds a critical or high CVE in any
of them that has a fix available. CVEs nobody has fixed yet don't fail it, since there's nothing
to update to. Mongo isn't checked: it's pulled rather than built, and pinned for the Pi 4 (below).
It needs Docker running and signed in to Docker Hub (`docker login`), and `jq`.

The git pre-commit hook runs it whenever a commit changes what goes into an image: the
Dockerfiles, `server/.dockerignore`, the package files, `docker/caddy`, the compose files, or the check
itself. It builds from the working tree, not the staged files. For a commit:

    POOL_SCOUT=always git commit ...   # scan even though no image changed
    POOL_SCOUT=skip git commit ...     # don't scan
    git commit --no-verify ...         # skip the lint as well

New CVEs are published every day, so an image that passed can fail later without any change;
run `make scout` now and then, and before deploying.

When a finding can't be fixed yet and doesn't matter here, record why in an
[OpenVEX](https://openvex.dev) file in `docker/scout/` (any `*.json`), and the check stops
counting it:

    {
      "@context": "https://openvex.dev/ns/v0.2.0",
      "@id": "https://github.com/rhbroberg/pool-controller/vex/2026-11-09",
      "author": "rhbroberg",
      "timestamp": "2026-11-09T00:00:00Z",
      "version": 1,
      "statements": [{
        "vulnerability": { "name": "CVE-2026-82560" },
        "products": [{ "@id": "pkg:docker/rhbroberg/pool-web" }],
        "status": "not_affected",
        "justification": "vulnerable_code_not_in_execute_path",
        "impact_statement": "why it doesn't apply"
      }]
    }

Remove the statement once the fix is in, so the check covers that CVE again.

## The certificate

Caddy proves the name in `POOL_HOSTNAME` to Let's Encrypt with a DNS TXT record (the DNS-01
challenge) rather than over port 80, so no port has to be open to the internet for the
certificate, only for whoever uses the page or the app. It renews when the CA advises (ACME
Renewal Information), which keeps it ahead of Let's Encrypt's move to 64-day (February 2027) and
45-day (February 2028) certificates.

Hurricane Electric's DNS can't give a program access to a whole zone, only a key for one record,
so the TXT record has to exist before Caddy can update it.

### Setting it up from nothing

For each name (here `pool.mystic.onthegrid.net`):

1. **The name.** At [dns.he.net](https://dns.he.net), give the name an A record pointing at the
   site's public address (kept current by the dynamic DNS cron job in `Environment.md`). The CA
   never connects to it; only the people using the page and the app do.

2. **The challenge record.** In the same zone, add a TXT record named
   `_acme-challenge.pool.mystic.onthegrid.net`, with:
   - any value at all, such as `placeholder`; Caddy replaces it with each challenge
   - a TTL of 5 minutes
   - **Enable entry for dynamic DNS** checked

3. **The key.** Click the refresh icon in that record's DDNS column, then **Generate a DDNS key**
   (or type one), and save it. This key, not the record's value, is `POOL_HE_DDNS_KEY`.

4. **Check the key** before involving Let's Encrypt. he.net answers `good` or `nochg` for the
   right key and `badauth` for anything else:

       curl https://dyn.dns.he.net/nic/update -d hostname=_acme-challenge.pool.mystic.onthegrid.net \
           -d password='<the DDNS key>' -d txt=placeholder

5. **Settings.** In `.env`, set `POOL_HOSTNAME` to the name, `POOL_ACME_EMAIL`, and, for the first
   try, `POOL_ACME_CA` to Let's Encrypt's staging CA,
   `https://acme-staging-v02.api.letsencrypt.org/directory`. Staging has no meaningful rate
   limits but its certificates aren't trusted; production allows 5 failed validations an hour
   and 5 identical certificates a week.

6. **Start it**, with the key in single quotes, since a hand-typed key can contain spaces or
   shell characters:

       export POOL_JWT_SECRET='...' POOL_HE_DDNS_KEY='<the DDNS key>'
       make up
       make logs

   Within a minute or two caddy logs `trying to solve challenge` with `challenge_type: dns-01`,
   then `certificate obtained successfully` naming the staging issuer.

7. **Switch to production.** Set `POOL_ACME_CA` back to
   `https://acme-v02.api.letsencrypt.org/directory` and run `make up` again, with the key still
   exported. Caddy keeps each CA's certificates apart in the `caddy_data` volume, so it requests a
   new one from production rather than reusing the staging one.

8. **Check it** from outside the network, such as a phone on cellular, or from inside with the
   name pinned to the Pi:

       curl -v https://pool.mystic.onthegrid.net/
       curl -v --resolve pool.mystic.onthegrid.net:443:<the Pi's LAN address> https://pool.mystic.onthegrid.net/

   The issuer should be `Let's Encrypt`, without `(STAGING)`, and curl should need no `-k`.

After that Caddy renews on its own; the key only has to be exported again to recreate the caddy
container.

### When it doesn't work

| What you see | Why, and what to do |
|---|---|
| caddy keeps restarting; its log says `missing API key` | `POOL_HE_DDNS_KEY` wasn't exported in the shell that ran `make up`. Export it and run `make up` again. |
| caddy logs `badauth: incorrect authentication key provided` | The key isn't the record's DDNS key: often the record's value was used instead, or an old value is still exported in the shell. Check the key with step 4, export the right one, and run `make up` again. `docker inspect` shows what a container was given. |
| curl reports `tlsv1 alert internal error`, or a browser can't make a secure connection | Caddy has no certificate yet for that name from the configured CA, as just after switching from staging to production. `make logs` says why; the handshake works once it logs `certificate obtained successfully`. |
| curl reports an unknown or untrusted issuer | It's the staging certificate. Do step 7. |
| the name reaches some other device | The name resolves to a router whose 443 is forwarded elsewhere. Fix the forward, or test with `curl --resolve` as in step 8. |

Failures at he.net happen before Let's Encrypt validates anything, so they don't count against
its limits; caddy retries on its own, waiting longer between tries, and starts again at once when
the container is recreated.

Let's Encrypt no longer emails before a certificate expires, so watch it from outside, for
example with one of the services on its
[monitoring page](https://letsencrypt.org/docs/monitoring-options/).

## Signing in with Google, Microsoft or Apple

Out of the box, accounts sign in with a name and password, as always. An admin can also offer
any OpenID Connect service (Google, Microsoft, Apple, Auth0, Okta, Keycloak, ...) under
Settings → Sign-In, on the web page or in the app. People then sign in with the service, and the
server keeps no password for them. Nothing else needs installing; the services only need the
public https name, since they send the browser back to it. Signing in through the LAN address
works only with passwords.

**Who gets in, and as what:**

- **An invitation** lets an email address in with a role, ahead of time: Accounts → + →
  Signs In With: A Service. The first sign-in with that address, verified by a service marked
  *Trust Email Addresses*, creates the account. Google and Apple are trusted out of the box.
  Microsoft personal accounts don't vouch for their addresses, so they don't redeem invitations.
- **A request**: anyone else who signs in with a service waits in Accounts under *Waiting for
  Approval*. Approve them as a Viewer, Operator or Admin, or Deny them. A denied person is turned
  away without asking again until the request is forgotten. Settings → Sign-In → Newcomers →
  *Turn Away* makes the server invitation-only, with no requests.
- **Roles** are the same as for password accounts and change the same way, in the account's
  page. Removing an account takes effect at once. Removing someone at Google doesn't, since the
  server only asks the service at sign-in.

### Setting up a service

Settings → Sign-In shows the redirect address to register with each service:
`https://<POOL_HOSTNAME>/rhbroberg/pool-api/1.0.0/auth/<id>/callback`, where `<id>` is the
service's id (`google`, `microsoft`, `apple`, ...).

- **Google** (free): in [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
  create a project, set up the OAuth consent screen (External, Testing is fine for up to 100
  people, and add each person as a test user, or publish it), then create an OAuth client ID of
  type *Web application*. Add the redirect address under *Authorized redirect URIs*. Paste the
  client ID and secret into Add Service → Google.
- **Microsoft** (free): in [Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade),
  register an app for *personal Microsoft accounts*, add a *Web* redirect URI, and create a client
  secret under Certificates & secrets. Paste the Application (client) ID and the secret's value
  into Add Service → Microsoft.
- **Apple** (needs the Apple Developer membership): under Certificates, Identifiers & Profiles,
  create a *Services ID* with Sign in with Apple, with the pool's name as a domain and the
  redirect address as a return URL. Then create a *Key* with Sign in with Apple. Add Service →
  Apple takes the Services ID, your team ID, the key's ID and the contents of its `.p8` file; the
  server makes Apple's short-lived client secret from the key itself.
- **Anything else**: Add Service → Other OpenID Connect, with the issuer address (the one whose
  `/.well-known/openid-configuration` exists), a client ID and a secret.

Saving reads the issuer's discovery document, so a mistyped issuer is caught then.

### Turning passwords off

1. Add a service, then in Settings → Sign-In Methods, **Link** it to your own admin account.
2. Settings → Sign-In → Password Sign-In → Off. The server refuses while no admin has a linked
   service.

To get back in with a password, as after losing access to the service, export
`POOL_FORCE_PASSWORD_SIGNIN=1` and run `make up`. Passwords then work whatever the setting
says. A factory reset also turns them back on.

The server works out the redirect address from Caddy's `X-Forwarded-Host` and
`X-Forwarded-Proto` headers. If a different proxy in front gets it wrong, set
`POOL_PUBLIC_URL=https://<name>` in `.env`.

## MongoDB on a Raspberry Pi 4

MongoDB 5.0 and later need an ARMv8.2 CPU, which a Pi 4 lacks, and 4.4 releases after 4.4.18 stop
on it with an illegal instruction, so the compose file pins `mongo:4.4.18`. On a Pi 5, or any
other ARMv8.2 or x86-64 host, a current release can be chosen with `POOL_MONGO_IMAGE` in `.env`.

A database directory written by another major version can't be opened directly; move the data
with `mongodump` and `mongorestore`, or start with an empty directory.

## Trying it without the controller

`docker-compose.sim.yml`, layered over the main file, replays recorded controller traffic instead
of using the RS-485 adapter, keeps the database in a volume, and runs as its own compose project,
`pool-controller-sim`, on ports 8080 and 8443 (`SIM_HTTP_PORT` and `SIM_HTTPS_PORT` change them).

    make sim              # https://localhost:8443, certificate from Caddy's own CA
    make sim-root-cert    # writes caddy-local-root.crt, that CA's root
    make sim-logs
    make sim-down

To trust that root in a simulator, so the iOS app can use `https://localhost:8443`:

    xcrun simctl keychain <simulator> add-root-cert caddy-local-root.crt

A fresh database has one account, `admin` / `admin`, which must be renamed before it can change
anything; the web page and the app both offer to do that on first sign-in.

To try a real certificate on a development machine, set up a test name the same way as steps 1
to 4 above (for example `pooltest.brobasino.onthegrid.net` and its own `_acme-challenge` record),
then:

    export POOL_HE_DDNS_KEY='<the test record's DDNS key>'
    make sim-letsencrypt TEST_HOSTNAME=pooltest.brobasino.onthegrid.net    # staging
    make sim-letsencrypt TEST_HOSTNAME=pooltest.brobasino.onthegrid.net \
        TEST_ACME_CA=https://acme-v02.api.letsencrypt.org/directory        # then production
    make sim-logs

The stack answers only for that name, on port 8443; `https://localhost:8443` fails the handshake
in this mode. The name normally resolves to the router, so to reach this machine by name, add it
to `/etc/hosts` while testing:

    127.0.0.1 pooltest.brobasino.onthegrid.net

then use `https://pooltest.brobasino.onthegrid.net:8443` in a browser, curl or the simulator. To
check without touching `/etc/hosts`:

    curl -v --resolve pooltest.brobasino.onthegrid.net:8443:127.0.0.1 https://pooltest.brobasino.onthegrid.net:8443/

Forwarding the router's 8443 to this machine makes the name work from outside as well. Remove the
`/etc/hosts` line when done.

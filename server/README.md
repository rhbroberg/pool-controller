Hayward AquaLogic pool controller

There have been a few other implementations of "connect a server to your AquaLogic"; I wanted one which was a single piece of hardware (raspberry pi which could parse the protocol, store events in a database, and serve web pages).  Most of the protocol reverse-engineering has been done by others; I am standing on their shoulders as I make this.

A raspberry pi zero is not quite fast enough to reliably send the control signals without collision; I'm using a rpi 3+, along with a usb rs485 connector.

Hayward command documentation is here: https://commerce.hayward-pool-assets.com/magento/2025/AQ-CO-SERIAL/092329C_RevB_6861.pdf

A REST api is generated/maintained by swagger. The server listens on port 3000; the api is present at

http://localhost:3000/docs

Under docker compose the service is only reachable through Caddy, which serves it as https on port 443 through the web service, with a Let's Encrypt certificate proved through DNS; see ../docker/README.md.

## Web front end

`../web` is a separate service with the iOS app's features as a web page: the dashboard,
setpoints, water flow, panel control, temperature and salt history, the event log, accounts and
server maintenance. It serves the page on port 80 and forwards the REST API (and `/docs`) to the
pool server, so the page needs no CORS and the iOS app can use the same address. It has no
dependencies beyond Node.

    cd ../web
    npm start                                          # port 80, pool server at localhost:3000
    PORT=8080 POOL_API_URL=http://pi.local:3000 npm start
    npm test

Under docker compose Caddy sends the public hostname to the web service, which forwards the API
to the pool service.

## Tests

The REST API tests start the real server with the simulated controller, each test file on its
own port and its own database (PoolRestTest-*, dropped afterwards), and drive it over HTTP.
They need MongoDB running on localhost.

    npm test              # run them
    npm run coverage      # run them and write coverage/lcov.info and coverage/index.html

The iOS app's models, stores and API client live in a Swift package, PoolStatusCore, beside the
app; open ios/PoolStatus/PoolStatus.xcworkspace to work on both. Its unit tests run on a
simulator of their own, "PoolStatus Tests", created on first use, so your everyday simulator and
its sign-in are left alone. A stub network layer stands in for the server.

    ../ios/scripts/test.sh    # writes ../ios/coverage/lcov.info

The same tests also run on the Mac, without a simulator, which is quicker while working on them:

    cd ../ios/PoolStatus/PoolStatusCore && swift test

In Cursor, run the "Test everything with coverage" task (Tasks: Run Test Task), then click
Watch in the status bar; the Coverage Gutters extension marks covered and missed lines in
the editor and updates whenever a test run rewrites lcov.info.

To find servers on your local network:

    npm run find-servers                  # port 3000
    npm run find-servers -- --port 8080   # another port

The apps get changes the moment the controller reports them from socket.io, on the same port
at `/socket.io/`. Two events, each without signing in:

 - `readings` `{ readings: [...] }`: entries as `GET /status` reports them; every switch when one
   changes, or the display readings that changed
 - `heating`: what `GET /heating` answers, once something it depends on changes

The apps still poll, every minute while these arrive and every 15 seconds otherwise.

## Heating estimates

While the pump runs and a heat source is calling for heat, `GET /heating` carries an `estimate`:
the time until the water reaches the highest setpoint calling for heat, from the water and air
temperatures now and a model learned from history.

The model is, for each body of water, in °F per hour

    dT/dt = H·heater + (a + b·(air − 60))·heat pump − k·(T − air) + S·sun

the heater and heat pump add heat (the heat pump less in cold air), the water loses heat to the
air in proportion to how much warmer it is, and the sun warms it in the daytime. The numbers
come from windows of history: stretches in which the pump ran and the heat sources on stayed the
same, each with how fast the water's temperature changed and the average water and air
temperatures. A least-squares fit that keeps every number non-negative gives H, a, b, k and S;
a source the windows can't tell about is reported as not known instead of made up. The time to
the setpoint then follows from the closed form (the water approaches where heat in equals heat
out exponentially), in stages when the heater and heat pump have different setpoints, and says
"unreachable" when the air is too cold for them to get there. The sun is worked out again for
the time the estimate came to, so an estimate late in the day allows for sunset. The air
temperature is the one stored with the water's.

An admin finds the windows, previews the model, and saves it, from the apps' server maintenance:

    POST /heating/model/scan              look through history (by default, all of it before 2026,
                                          when the simulator began) for windows; goes on in the job queue
    GET  /heating/model/scan              progress, and what was found
    GET  /heating/model/scan/windows      each window, suitable or why not
    POST /heating/model/preview           fit the windows left ticked; nothing is kept
    PUT  /heating/model                   keep exactly what was previewed
    GET  /heating/model                   the model in use, and the default range

Whether apps show the minutes left or the time it will be ready is the server's setting
`heatingEstimateDisplay` (`remaining` or `readyAt`), shared by every app. Right after the pump
starts the sensor still shows what was in the plumbing, so the estimate waits (`settling`) for
15 minutes; `POOL_ESTIMATE_SETTLE_MINUTES` changes that for testing.

This project is still in its infancy.  Some features I intend to add are:

 - full REST api control of all pool devices
 - full REST api visibility into current status and information from the pool controller
 + streaming (socketIO) updates of events
 - logging of unrecognized messages to a specific location for study
 - web authentication and authorization
 - name mapping from generic (aux1, aux2, ...) to specific (yard lights, low-speed, etc.)
 + temperature visualization
 - notification (temperature ranges, freeze pump activation, no-flow during pump operation, etc.)
 - native ios application
 + basic web interface to control devices


To try the whole stack in Docker on a machine without the controller, with the simulated
controller and https://localhost:8443:

    cd ../docker && make sim


# Swagger generated server

## Overview
This server was generated by the [swagger-codegen](https://github.com/swagger-api/swagger-codegen) project.  By using the [OpenAPI-Spec](https://github.com/OAI/OpenAPI-Specification) from a remote server, you can easily generate a server stub.


The API is described by the OpenAPI 3 document in `api/openapi.yaml`.
[express-openapi-validator](https://github.com/cdimascio/express-openapi-validator) checks each request
against it and enforces the OAuth2 scopes; `index.js` then hands the request to the controller named by the
operation's `x-swagger-router-controller` and `operationId`.

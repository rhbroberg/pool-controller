'use strict';

var fs = require('fs'),
    path = require('path'),
    http = require('http');
var { authenticate } = require('./utils/authenticate');
var app = require('connect')();
var swaggerTools = require('swagger-tools');
var jsyaml = require('js-yaml');
var serverPort = process.env.PORT;

// swaggerRouter configuration
var options = {
    swaggerUi: path.join(__dirname, '/swagger.json'),
    controllers: path.join(__dirname, './controllers'),
    useStubs: process.env.NODE_ENV === 'development' // Conditionally turn on stubs (mock mode)
};

// The Swagger document (require it, build it programmatically, fetch it from a URL, ...)
var spec = fs.readFileSync(path.join(__dirname, 'api/swagger.yaml'), 'utf8');
var swaggerDoc = jsyaml.safeLoad(spec);

var initializeServer = (async (cb) => {
    // Initialize the Swagger middleware
    await swaggerTools.initializeMiddleware(swaggerDoc, function(middleware) {

        // Interpret Swagger resources and attach metadata to request - must be first in swagger-tools middleware chain
        app.use(middleware.swaggerMetadata());

        // enforce authentication and authorization
        app.use(middleware.swaggerSecurity({ OAuth2: (req, def, scopes, callback) => authenticate(req, def, scopes, callback) }));

        // Validate Swagger requests
        app.use(middleware.swaggerValidator());

        // Route validated requests to appropriate controller
        app.use(middleware.swaggerRouter(options));

        // Serve the Swagger documents and Swagger UI
        app.use(middleware.swaggerUi());

        // create server and app in this order for callback
        var server = http.createServer(app);
        cb(app, server);

        // Start the server
        server.listen(serverPort, function() {
            console.log('Your server is listening on port %d (http://localhost:%d)', serverPort, serverPort);
            console.log('Swagger-ui is available on http://localhost:%d/docs', serverPort);

        });

    });
});

module.exports = { initializeServer };

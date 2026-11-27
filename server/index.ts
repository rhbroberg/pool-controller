'use strict';

import type { Request, Response, NextFunction } from 'express';
import type { AuthedRequest } from './types/domain';
import { ApiError } from './utils/writer';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jsyaml = require('js-yaml');
const OpenApiValidator = require('express-openapi-validator');
const swaggerUi = require('swagger-ui-express');
const log4js = require('log4js');
const { authenticate } = require('./utils/authenticate');
const { writeJson } = require('./utils/writer');

const logger = log4js.getLogger();
const serverPort = process.env.PORT;
const specPath = path.join(__dirname, 'api/openapi.yaml');
const apiDoc = jsyaml.safeLoad(fs.readFileSync(specPath, 'utf8'));

// resolves a parameter that refers to #/components/parameters
var resolveParameter = (parameter: any) => {
    if (!parameter.$ref) {
        return parameter;
    }
    return parameter.$ref.split('/').slice(1).reduce((node: any, key: any) => node[key], apiDoc);
};

// controllers read their inputs as req.swagger.params[name].value, the validated and coerced values
var operationParams = (req: AuthedRequest, operation: any) => {
    const sources: Record<string, any> = { path: req.openapi?.pathParams, query: req.query, header: req.headers };
    const params: any = {};
    for (const parameter of (operation.parameters || []).map(resolveParameter)) {
        const source = sources[parameter.in] || {};
        params[parameter.name] = { value: source[parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name] };
    }
    if (operation.requestBody) {
        params[operation['x-codegen-request-body-name'] || 'body'] = { value: req.body };
    }
    return params;
};

// sends each validated request to the export named by its operationId in the controller module
// named by x-swagger-router-controller
var routeToController = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const operation = req.openapi && req.openapi.schema;
    if (!operation) {
        next();
        return;
    }
    const controller = require(path.join(__dirname, 'controllers', operation['x-swagger-router-controller']));
    const handler = controller[operation.operationId!];
    if (typeof handler !== 'function') {
        next({ status: 501, message: `${operation.operationId} is not implemented` });
        return;
    }
    req.swagger = { operation, params: operationParams(req, operation) };
    handler(req, res, next);
};

// API errors are answered in the same { code, message } form the services use
var sendError = (err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    if (err instanceof ApiError) {
        writeJson(res, err.body, err.code);
        return;
    }
    const code = err.status || err.statusCode || 500;
    if (code >= 500) {
        logger.error(`REST ${req.method} ${req.originalUrl} failed:`, err);
    }
    for (const [name, value] of Object.entries(err.headers || {})) {
        res.setHeader(name, value as string);
    }
    let message = err.message;
    if (code === 415) {
        message = 'send the request body as application/json';
    } else if (code >= 500) {
        message = 'the server could not complete the request';
    }
    writeJson(res, { code, message }, code);
};

var initializeServer = (cb: (app: any, server: any) => void) => {
    const app = express();
    app.disable('x-powered-by');

    app.get('/api-docs', (req: any, res: any) => res.json(apiDoc));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(apiDoc));

    app.use(express.json());
    // some sign-in services, Apple's among them, post their answer back as a form
    app.use(express.urlencoded({ extended: false }));
    app.use(OpenApiValidator.middleware({
        apiSpec: specPath,
        validateRequests: { allowUnknownQueryParameters: true },
        validateResponses: false,
        validateSecurity: { handlers: { OAuth2: authenticate } }
    }));
    app.use(routeToController);
    app.use(sendError);

    // create server and app in this order for callback
    const server = http.createServer(app);
    cb(app, server);

    server.listen(serverPort, function() {
        console.log('Your server is listening on port %d (http://localhost:%d)', serverPort, serverPort);
        console.log('Swagger-ui is available on http://localhost:%d/docs', serverPort);
    });
};

module.exports = { initializeServer };

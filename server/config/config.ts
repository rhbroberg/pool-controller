const env = process.env.NODE_ENV || 'development';

const config = require('./config.json') as Record<string, Record<string, string>>;
const envConfig = config[env];

// a variable already set in the environment wins, so a deployment or a test can choose its own
// port, database or secret
Object.keys(envConfig).forEach((key) => {
    if (typeof process.env[key] === 'undefined') {
        process.env[key] = envConfig[key];
    }
});

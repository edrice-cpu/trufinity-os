"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("./src/config/env");
const config = {
    development: {
        client: 'pg',
        connection: {
            host: env_1.env.DB_HOST,
            port: env_1.env.DB_PORT,
            user: env_1.env.DB_USER,
            password: env_1.env.DB_PASSWORD,
            database: env_1.env.DB_NAME,
        },
        migrations: {
            directory: './migrations',
            extension: 'ts',
        },
    },
    production: {
        client: 'pg',
        connection: {
            host: env_1.env.DB_HOST,
            port: env_1.env.DB_PORT,
            user: env_1.env.DB_USER,
            password: env_1.env.DB_PASSWORD,
            database: env_1.env.DB_NAME,
            ssl: { rejectUnauthorized: false }, // Useful for managed DBs
        },
        migrations: {
            directory: './migrations',
            extension: 'js',
        },
    },
};
exports.default = config;

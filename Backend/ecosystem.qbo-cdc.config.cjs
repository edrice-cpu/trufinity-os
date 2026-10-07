module.exports = {
  apps: [{
    name: 'trufinity-qbo-cdc',
    cwd: __dirname,
    script: 'dist/workers/qbo-cdc.worker.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    kill_timeout: 900000,
    env_production: { NODE_ENV: 'production' },
  }],
};

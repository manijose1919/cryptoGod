module.exports = {
  apps: [
    {
      name: 'canuck-node',
      script: 'server.js',
      node_args: '--experimental-strip-types',
      cwd: '/opt/trading-bot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 3033,
      },
      // Logging
      error_file: '/opt/trading-bot/logs/error.log',
      out_file: '/opt/trading-bot/logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart policy
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      restart_delay: 3000,
    }
  ]
};

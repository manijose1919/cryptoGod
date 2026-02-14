module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: 'canuck-trader-pro/backend/main.py',
      interpreter: '/opt/trading-bot/venv/bin/python3',
      cwd: '/opt/trading-bot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        PYTHONUNBUFFERED: '1',
        HTTP_PORT: 3033,
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

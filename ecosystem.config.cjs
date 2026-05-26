module.exports = {
  apps: [
    {
      name: 'canuck-node',
      script: 'serverV2.ts',
      interpreter: 'node',
      node_args: '--experimental-strip-types',
      cwd: '/opt/trading-bot',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 3033,
        V2_MODE: 'paper',
        // Pairs trading: paper mode only. Live requires both PAIRS_MODE=live
        // AND PAIRS_LIVE_CONFIRMED=yes (safety interlock). Phase A = 30 days
        // paper. Plan: docs/plans/2026-05-26-pairs-deployment-plan.md
        PAIRS_MODE: 'paper',
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

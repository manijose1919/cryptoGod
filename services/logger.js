/**
 * Structured Logger
 * Provides leveled, structured logging for the backend.
 * Replaces scattered console.log with consistent format.
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLevel = LOG_LEVELS.INFO;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, module, message, data) {
  const entry = {
    time: formatTimestamp(),
    level,
    module,
    msg: message,
  };
  if (data !== undefined) {
    entry.data = data;
  }
  return JSON.stringify(entry);
}

export function setLogLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    currentLevel = LOG_LEVELS[level];
  }
}

export function debug(module, message, data) {
  if (currentLevel <= LOG_LEVELS.DEBUG) {
    console.log(formatMessage('DEBUG', module, message, data));
  }
}

export function info(module, message, data) {
  if (currentLevel <= LOG_LEVELS.INFO) {
    console.log(formatMessage('INFO', module, message, data));
  }
}

export function warn(module, message, data) {
  if (currentLevel <= LOG_LEVELS.WARN) {
    console.warn(formatMessage('WARN', module, message, data));
  }
}

export function error(module, message, data) {
  if (currentLevel <= LOG_LEVELS.ERROR) {
    console.error(formatMessage('ERROR', module, message, data));
  }
}

/** Create a module-scoped logger */
export function createLogger(moduleName) {
  return {
    debug: (msg, data) => debug(moduleName, msg, data),
    info: (msg, data) => info(moduleName, msg, data),
    warn: (msg, data) => warn(moduleName, msg, data),
    error: (msg, data) => error(moduleName, msg, data),
  };
}

export default { setLogLevel, debug, info, warn, error, createLogger };

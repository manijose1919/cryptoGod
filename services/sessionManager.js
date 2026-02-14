/**
 * Session Manager (Backend)
 *
 * Manages trading sessions, credentials, and persistent state.
 * Supports session reconnection and recovery after disconnection or restart.
 *
 * Requirements 4, 32, 33
 */

import crypto from 'node:crypto';
import { setSetting, getSetting } from './database.js';

const sessions = new Map();

class TradingSession {
    constructor(apiKey, secretKey) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.id = crypto.randomBytes(32).toString('hex');
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    isExpired(maxAgeMs = 24 * 60 * 60 * 1000) { // 24 hours default for VPS operation
        return Date.now() - this.lastActivity > maxAgeMs;
    }
}

/**
 * Create a new trading session
 */
export function createSession(apiKey, secretKey) {
    const session = new TradingSession(apiKey, secretKey);
    sessions.set(session.id, session);
    return session.id;
}

/**
 * Retrieve an active session
 */
export function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.updateActivity();
        return session;
    }
    return null;
}

/**
 * Terminate a session
 */
export function deleteSession(sessionId) {
    return sessions.delete(sessionId);
}

/**
 * Cleanup expired sessions (intended to be called via setInterval)
 */
export function cleanExpiredSessions() {
    let count = 0;
    for (const [id, session] of sessions.entries()) {
        if (session.isExpired()) {
            sessions.delete(id);
            count++;
        }
    }
    return count;
}

/**
 * Persist global bot state to database
 */
export function persistBotState(state) {
    try {
        setSetting('bot_state_persistent', JSON.stringify({
            ...state,
            updatedAt: Date.now()
        }));
        return true;
    } catch (e) {
        console.error('[SessionManager] Persist state error:', e.message);
        return false;
    }
}

/**
 * Restore global bot state from database
 */
export function restoreBotState() {
    try {
        const raw = getSetting('bot_state_persistent');
        if (!raw) return null;
        
        const state = JSON.parse(raw);
        // Check age of state (don't restore if older than 7 days)
        if (Date.now() - state.updatedAt > 7 * 24 * 60 * 60 * 1000) {
            return null;
        }
        return state;
    } catch (e) {
        console.error('[SessionManager] Restore state error:', e.message);
        return null;
    }
}

/**
 * Get all active session IDs
 */
export function getActiveSessionIds() {
    return Array.from(sessions.keys());
}

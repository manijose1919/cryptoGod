

import type { ApiCredentials, CryptoHolding, PortfolioState, SystemEvent, TradingStrategy } from '../types';

/**
 * Real Backend API Service Client
 */
interface BotStatus {
    portfolio: PortfolioState;
    logs: SystemEvent[];
    isBotActive?: boolean;
}

interface BotSettings {
    strategy: TradingStrategy;
    riskAmount: number;
    profitGoal: number;
    sessionProfitGoal: number;
    maxConcurrentTrades: number;
    ticker: string;
}

const API_BASE_URL = '/api'; 

class TradingBotService {
  
  private async makeRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        // Try to get a meaningful error message from the backend's JSON response
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.message) errorMessage = errorData.message;
        } catch {
          // Response wasn't JSON, use generic message
        }
        throw new Error(errorMessage);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      // This catch block handles network errors (e.g., server not running)
      if (error instanceof TypeError) { // Network errors are often TypeErrors in the browser
         throw new Error(`Network Error: Could not connect to the backend at ${API_BASE_URL}. Please ensure the server is running.`);
      }
      // Re-throw other errors (like the ones we threw manually above)
      throw error;
    }
  }

  public async testConnection(): Promise<{ message: string; ip?: string }> {
      return this.makeRequest('/test-connection', { method: 'POST' });
  }

  public async login(creds: ApiCredentials): Promise<{ balance: number; holdings?: Record<string, CryptoHolding>; resumed?: boolean; botActive?: boolean; botSettings?: Record<string, unknown>; portfolio?: PortfolioState }> {
    return this.makeRequest('/login', {
        method: 'POST',
        body: JSON.stringify(creds),
    });
  }

  public async toggleBot(start: boolean, settings: BotSettings): Promise<{ status: string }> {
    return this.makeRequest('/bot/toggle', {
        method: 'POST',
        body: JSON.stringify({ start, settings }),
    });
  }

  public async closeAllPositions(): Promise<{ message: string; closed: number; failed: number; results: Array<{ ticker: string; status: string }> }> {
    return this.makeRequest('/bot/close-all', { method: 'POST' });
  }

  public async getStatus(): Promise<BotStatus> {
    return this.makeRequest('/status');
  }
}

export const tradingBotService = new TradingBotService();


import React, { useState } from 'react';
import type { ApiCredentials } from '../types';
import { tradingBotService } from '../services/tradingBotService';

interface RealTradingModalProps {
  onClose: () => void;
  onAuthenticate: (credentials: ApiCredentials) => void;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

const parseWhitelistError = (errorMessage: string | null) => {
    if (!errorMessage || !errorMessage.includes("IP_ILLEGAL")) {
        return { isWhitelistError: false, ip: null };
    }
    const ipMatch = errorMessage.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    return { isWhitelistError: true, ip: ipMatch ? ipMatch[0] : 'not found' };
};

export const RealTradingModal: React.FC<RealTradingModalProps> = ({ onClose, onAuthenticate }) => {
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isIpCopied, setIsIpCopied] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState<string>('');
  const [serverIp, setServerIp] = useState<string | null>(null);
  
  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    setLoginError(null);
    setServerIp(null);
    try {
        const result = await tradingBotService.testConnection();
        setTestStatus('success');
        setTestMessage(result.message);
        if (result.ip) {
            setServerIp(result.ip);
        }
    } catch (error: any) {
        setTestStatus('error');
        setTestMessage(error.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setTestStatus('idle');
    setTestMessage('');
    setIsConnecting(true);
    try {
      await onAuthenticate({ apiKey, secretKey, twoFactorCode });
    } catch (error: any) {
      setLoginError(error.message);
    } finally {
      setIsConnecting(false);
    }
  };
  
  const handleClose = () => {
    setLoginError(null);
    setTestStatus('idle');
    setTestMessage('');
    setIsConnecting(false);
    setIsIpCopied(false);
    setServerIp(null);
    onClose();
  }
  
  const handleCopyIp = (ip: string) => {
    navigator.clipboard.writeText(ip);
    setIsIpCopied(true);
    setTimeout(() => setIsIpCopied(false), 2000);
  };

  const { isWhitelistError, ip: whitelistIp } = parseWhitelistError(loginError);
  const ipToDisplay = serverIp || (isWhitelistError ? whitelistIp : null);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gray-800 border border-red-500/50 rounded-2xl shadow-2xl p-8 max-w-md w-full m-4">
        <h2 className="text-2xl font-bold text-red-400 mb-2">Connect to Crypto.com</h2>
        <p className="text-gray-400 text-sm mb-4">Enter your API credentials to enable real trading. Keys are sent to your secure backend only.</p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300">API Key</label>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className="mt-1 w-full bg-gray-900 border border-gray-600 rounded-md p-2 text-white focus:ring-red-500 focus:border-red-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300">Secret Key</label>
            <input type="password" value={secretKey} onChange={e => setSecretKey(e.target.value)} className="mt-1 w-full bg-gray-900 border border-gray-600 rounded-md p-2 text-white focus:ring-red-500 focus:border-red-500" />
          </div>
           <div>
            <label className="block text-sm font-medium text-gray-300">2FA Code (if enabled)</label>
            <input type="text" value={twoFactorCode} onChange={e => setTwoFactorCode(e.target.value)} className="mt-1 w-full bg-gray-900 border border-gray-600 rounded-md p-2 text-white focus:ring-red-500 focus:border-red-500" placeholder="e.g., 123456" />
          </div>
          
          <div className="pt-3 space-y-3">
             {ipToDisplay && (
                <div className={`p-4 rounded-lg ${isWhitelistError ? 'bg-yellow-900/50 border border-yellow-500/50 text-yellow-200' : 'bg-gray-900/50 border border-gray-600 text-gray-200'}`}>
                    <h4 className={`font-bold ${isWhitelistError ? 'text-yellow-300' : 'text-gray-100'}`}>
                        {isWhitelistError ? 'Action Required: Whitelist IP' : 'Server IP for Whitelisting'}
                    </h4>
                    <p className="text-xs mt-1 mb-2">
                        {isWhitelistError 
                            ? "The API is rejecting connections. You must add the IP below to your API key's whitelist on Crypto.com."
                            : "Add this IP to your API key's whitelist on Crypto.com to enable trading."}
                    </p>
                    <div className="flex items-center gap-2 my-1">
                        <p className="font-mono flex-grow text-center bg-gray-800 py-1 px-2 rounded-md text-white tracking-widest">{ipToDisplay}</p>
                        <button type="button" onClick={() => handleCopyIp(ipToDisplay)} className="py-1 px-3 text-xs bg-gray-600 hover:bg-gray-500 rounded-md transition-colors">{isIpCopied ? 'Copied!' : 'Copy'}</button>
                    </div>
                    <p className="text-xs mt-2">
                        {isWhitelistError && <strong>Important:</strong>} It may take up to 30 minutes for API changes to take effect. 
                        <a href="https://crypto.com/exchange/user/settings/api-management" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline ml-1">
                            Go to API settings &rarr;
                        </a>
                    </p>
                </div>
            )}
             {loginError && !isWhitelistError && (
                  <div className="p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-sm text-red-200 text-center">
                    <strong>Connection Failed:</strong> {loginError}
                  </div>
              )}
              {testStatus !== 'idle' && (
                 <div className={`p-2 rounded-md text-xs text-center ${testStatus === 'success' ? 'bg-green-900/50 text-green-300' : testStatus === 'error' ? 'bg-red-900/50 text-red-300' : 'bg-yellow-900/50 text-yellow-300'}`}>
                    {testStatus === 'testing' ? 'Testing...' : testMessage}
                 </div>
              )}
          </div>
          
          <div className="flex justify-between items-center gap-4 pt-4">
            <button type="button" onClick={handleTestConnection} className="py-2 px-4 text-xs text-cyan-300 bg-gray-700 hover:bg-gray-600 rounded-lg transition" disabled={testStatus === 'testing' || isConnecting}>
              {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>
            <div className="flex-grow flex justify-end gap-4">
              <button type="button" onClick={handleClose} className="py-2 px-4 text-gray-300 bg-gray-600 hover:bg-gray-500 rounded-lg transition">Cancel</button>
              <button type="submit" className="py-2 px-4 text-white bg-red-600 hover:bg-red-500 rounded-lg transition disabled:bg-red-800 disabled:cursor-not-allowed" disabled={isConnecting}>
                {isConnecting ? 'Connecting...' : 'Connect Securely'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
    
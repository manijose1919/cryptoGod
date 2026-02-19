import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

type ToastType = 'success' | 'error' | 'warning' | 'info' | 'trade';

interface Toast {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
  exiting?: boolean;
}

interface ToastContextValue {
  addToast: (type: ToastType, title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_DURATION = 4000;
const EXIT_DURATION = 300;

const typeStyles: Record<ToastType, { border: string; icon: string; iconColor: string }> = {
  success: { border: 'border-l-green-500', icon: '\u2713', iconColor: 'text-green-400' },
  error:   { border: 'border-l-red-500',   icon: '\u2717', iconColor: 'text-red-400' },
  warning: { border: 'border-l-yellow-500', icon: '\u26A0', iconColor: 'text-yellow-400' },
  info:    { border: 'border-l-blue-500',  icon: '\u2139', iconColor: 'text-blue-400' },
  trade:   { border: 'border-l-cyan-500',  icon: '\u21C5', iconColor: 'text-cyan-400' },
};

const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({ toast, onDismiss }) => {
  const style = typeStyles[toast.type];
  return (
    <div
      className={`toast-item ${toast.exiting ? 'toast-exit' : 'toast-enter'} flex items-start gap-2 p-3 rounded-lg border-l-4 ${style.border} bg-gray-900/90 backdrop-blur-md shadow-lg max-w-xs cursor-pointer`}
      onClick={() => onDismiss(toast.id)}
    >
      <span className={`text-base ${style.iconColor} mt-0.5`}>{style.icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-white">{toast.title}</div>
        {toast.message && <div className="text-[11px] text-gray-400 mt-0.5 truncate">{toast.message}</div>}
      </div>
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), EXIT_DURATION);
  }, []);

  const addToast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = ++nextId.current;
    setToasts(prev => [...prev.slice(-4), { id, type, title, message }]);
    setTimeout(() => dismiss(id), TOAST_DURATION);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {createPortal(
        <div className="fixed top-3 right-3 z-[100] flex flex-col gap-2 pointer-events-none">
          {toasts.map(t => (
            <div key={t.id} className="pointer-events-auto">
              <ToastItem toast={t} onDismiss={dismiss} />
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};

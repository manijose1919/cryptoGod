
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./*.{tsx,ts,jsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./containers/**/*.{js,ts,jsx,tsx}",
    "./contexts/**/*.{js,ts,jsx,tsx}",
    "./hooks/**/*.{js,ts,jsx,tsx}",
    "./services/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          cyan: '#06b6d4',
          blue: '#3b82f6',
          purple: '#8b5cf6',
          indigo: '#6366f1',
          dark: '#0f172a',
          darker: '#020617',
          card: 'rgba(15, 23, 42, 0.6)',
          'card-hover': 'rgba(15, 23, 42, 0.8)',
          border: 'rgba(99, 102, 241, 0.2)',
          'border-hover': 'rgba(99, 102, 241, 0.4)',
        },
        profit: {
          DEFAULT: '#22c55e',
          light: '#4ade80',
          glow: 'rgba(34, 197, 94, 0.3)',
        },
        loss: {
          DEFAULT: '#ef4444',
          light: '#f87171',
          glow: 'rgba(239, 68, 68, 0.3)',
        },
        neutral: {
          DEFAULT: '#94a3b8',
          light: '#cbd5e1',
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'slide-in': 'slide-in 0.3s ease-out',
        'fade-up': 'fade-up 0.4s ease-out',
        'fade-in': 'fade-in 0.3s ease-out',
        'spin-slow': 'spin 3s linear infinite',
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'glow-green': 'glow-green 2s ease-in-out infinite',
        'glow-red': 'glow-red 2s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 5px rgba(99, 102, 241, 0.3)' },
          '50%': { opacity: '0.85', boxShadow: '0 0 20px rgba(99, 102, 241, 0.6)' },
        },
        'slide-in': {
          '0%': { transform: 'translateX(-10px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-up': {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(1.5)' },
        },
        'glow-green': {
          '0%, 100%': { boxShadow: '0 0 5px rgba(34, 197, 94, 0.3)' },
          '50%': { boxShadow: '0 0 15px rgba(34, 197, 94, 0.6)' },
        },
        'glow-red': {
          '0%, 100%': { boxShadow: '0 0 5px rgba(239, 68, 68, 0.3)' },
          '50%': { boxShadow: '0 0 15px rgba(239, 68, 68, 0.6)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3)',
        'glass-sm': '0 4px 16px rgba(0, 0, 0, 0.2)',
        'glow-cyan': '0 0 15px rgba(6, 182, 212, 0.4)',
        'glow-blue': '0 0 15px rgba(59, 130, 246, 0.4)',
        'glow-purple': '0 0 15px rgba(139, 92, 246, 0.4)',
        'glow-profit': '0 0 10px rgba(34, 197, 94, 0.3)',
        'glow-loss': '0 0 10px rgba(239, 68, 68, 0.3)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-brand': 'linear-gradient(135deg, #06b6d4, #3b82f6, #8b5cf6)',
        'gradient-dark': 'linear-gradient(180deg, #0f172a, #020617)',
        'gradient-card': 'linear-gradient(135deg, rgba(15, 23, 42, 0.8), rgba(30, 41, 59, 0.4))',
      },
      borderRadius: {
        'xl': '1rem',
        '2xl': '1.5rem',
      },
    },
  },
  plugins: [],
}

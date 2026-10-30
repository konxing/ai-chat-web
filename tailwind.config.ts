import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090f',
          900: '#0b0e17',
          850: '#10141f',
          800: '#151a27',
          700: '#1e2536',
          600: '#2a3348'
        },
        aurora: {
          300: '#8ff0d0',
          400: '#4fe0b4',
          500: '#22c99a',
          600: '#12a57c'
        },
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6'
        }
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Noto Sans SC',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      animation: {
        'orb-pulse': 'orbPulse 3.2s ease-in-out infinite',
        'ring-spin': 'ringSpin 8s linear infinite',
        'ring-spin-rev': 'ringSpin 12s linear infinite reverse',
        float: 'float 5s ease-in-out infinite',
        'fade-up': 'fadeUp .7s cubic-bezier(.2,.8,.2,1) both',
        shimmer: 'shimmer 2.2s linear infinite',
        blink: 'blink 1s step-end infinite'
      },
      keyframes: {
        orbPulse: {
          '0%,100%': { transform: 'scale(1)', filter: 'brightness(1)' },
          '50%': { transform: 'scale(1.06)', filter: 'brightness(1.25)' }
        },
        ringSpin: { to: { transform: 'rotate(360deg)' } },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } }
      }
    }
  },
  plugins: []
};

export default config;

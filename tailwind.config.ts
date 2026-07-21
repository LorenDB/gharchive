import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f4f6f8',
          100: '#e4e9ef',
          200: '#c5ced9',
          300: '#9aabbc',
          400: '#6d8198',
          500: '#52667d',
          600: '#415166',
          700: '#364354',
          800: '#2e3847',
          850: '#232b37',
          900: '#1a2029',
          950: '#0d1117',
          975: '#090c10',
        },
        amber: {
          300: '#f5c96a',
          400: '#e8b44a',
          500: '#d49a1a',
        },
        mint: {
          400: '#5ecf9a',
          500: '#3db87a',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 40px -12px rgba(232, 180, 74, 0.25)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.55)',
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(232,180,74,0.12), transparent 55%), radial-gradient(ellipse 60% 40% at 100% 0%, rgba(94,207,154,0.06), transparent 45%)',
      },
    },
  },
  plugins: [],
};

export default config;

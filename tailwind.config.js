/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          200: '#bcd3ff',
          300: '#8eb6ff',
          400: '#598cff',
          500: '#3563eb',
          600: '#2447d6',
          700: '#1e39ad',
          800: '#1f338a',
          900: '#1f306e',
        },
      },
    },
  },
  plugins: [],
};

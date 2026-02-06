/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // Commander 风格配色
                commander: {
                    bg: '#1a1f2e',
                    panel: '#242938',
                    header: '#2d3346',
                    border: '#3d4458',
                    selected: '#3b82f6',
                    selectedBg: '#1e3a5f',
                    hover: '#2a3147',
                    accent: '#3b82f6',
                    text: '#e2e8f0',
                    'text-dim': '#94a3b8',
                    textMuted: '#94a3b8',
                    directory: '#60a5fa',
                    file: '#e2e8f0',
                    executable: '#4ade80',
                    archive: '#f472b6',
                    image: '#a78bfa',
                },
            },
            fontFamily: {
                mono: ['Consolas', 'Monaco', 'Courier New', 'monospace'],
            },
            fontSize: {
                'xs': ['11px', '16px'],
                'sm': ['12px', '18px'],
            },
        },
    },
    plugins: [],
}

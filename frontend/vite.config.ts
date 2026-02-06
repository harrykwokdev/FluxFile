import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/stores': path.resolve(__dirname, './src/stores'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/types': path.resolve(__dirname, './src/types'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/services': path.resolve(__dirname, './src/services'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api/signaling/ws': {
                target: 'ws://localhost:8000',
                ws: true,
            },
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
            '/webdav': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
})

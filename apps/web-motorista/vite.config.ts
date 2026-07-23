import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        // Fotos de referência (RF-21) vistas com rede ficam no cache do SW e
        // aparecem offline — na zona rural sem sinal é onde mais importam.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fotos-referencia',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Rota Grupo Alcina Maria — Motorista',
        short_name: 'Rota',
        description: 'Rota do dia, navegação e confirmação de entregas — offline-first',
        theme_color: '#1c1c1e',
        background_color: '#1c1c1e',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5174 },
  // O worker do maplibre-gl não resolve dentro do cache do otimizador do Vite;
  // servir o pacote direto corrige o carregamento em dev (o build não é afetado).
  optimizeDeps: { exclude: ['maplibre-gl'] },
});

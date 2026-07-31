import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // O SW assume assim que instala (skipWaiting+clientsClaim) — a troca de
      // versão não exige limpeza manual. Quem avisa a PESSOA é a faixa de
      // `useAtualizacao`, com registro MANUAL: o módulo virtual do plugin, em
      // autoUpdate, embute um reload forçado no 'activated' que recarregaria a
      // página no meio do trabalho (conferido no bundle). Por isso o registro
      // não é injetado nem importado do plugin.
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Rota Grupo Alcina Maria — Painel',
        short_name: 'Rota Painel',
        description: 'Importação de NF-e, montagem e publicação de rotas',
        theme_color: '#1c1c1e',
        background_color: '#1c1c1e',
        display: 'standalone',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5173 },
  // O worker do maplibre-gl não resolve dentro do cache do otimizador do Vite;
  // servir o pacote direto corrige o carregamento em dev (o build não é afetado).
  optimizeDeps: { exclude: ['maplibre-gl'] },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // O SW assume assim que instala — e quem avisa a PESSOA é a faixa de
      // `useAtualizacao` (o app não recarrega sozinho, para não perder trabalho
      // em andamento). Trocar para 'prompt' deixaria o SW novo em espera, e os
      // aparelhos que já têm o SW antigo instalado precisariam de uma limpeza
      // manual de cache para entrar no esquema novo — exatamente o problema que
      // isto veio resolver.
      registerType: 'autoUpdate',
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

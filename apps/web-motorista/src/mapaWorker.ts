import { setWorkerUrl } from 'maplibre-gl';
// O MapLibre v6 não embute o worker: em runtime ele o resolve num caminho
// relativo ao módulo que não existe no dist do Vite — o worker nunca sobe e
// tudo que depende dele (tiles vetoriais, camadas GeoJSON) espera em
// silêncio. `?worker&url` faz o Vite empacotar o worker com o chunk
// compartilhado que ele importa e devolve a URL do asset final, que também
// entra no precache do SW (o mapa precisa dele offline).
import urlWorkerMapa from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(urlWorkerMapa);

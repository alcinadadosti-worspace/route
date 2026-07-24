import { setWorkerUrl } from 'maplibre-gl';
// O MapLibre v6 não embute o worker: em runtime ele o resolve num caminho
// relativo ao módulo que não existe no dist do Vite — o worker nunca sobe e
// as camadas GeoJSON (traçado da rota) esperam em silêncio, sem erro.
// `?worker&url` faz o Vite empacotar o worker com o chunk compartilhado que
// ele importa e devolve a URL do asset final.
import urlWorkerMapa from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(urlWorkerMapa);

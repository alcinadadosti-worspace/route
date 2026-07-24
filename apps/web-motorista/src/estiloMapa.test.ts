import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estiloMapa } from './estiloMapa.js';

test('sem mapa embarcado, cai no basemap raster online', () => {
  const estilo = estiloMapa('galpao', null);
  assert.equal(estilo.sources.osm?.type, 'raster');
  assert.equal(estilo.layers.length, 1);
});

test('com mapa embarcado, source vetorial local e assets do bundle', () => {
  const estilo = estiloMapa('galpao', 'pmtiles://alagoas.pmtiles');
  const fonte = estilo.sources.basemap;
  assert.ok(fonte);
  assert.equal(fonte.type, 'vector');
  assert.equal('url' in fonte && fonte.url, 'pmtiles://alagoas.pmtiles');
  // Glyphs e sprites servidos pelo próprio app (precache do SW), nunca CDN.
  assert.match(estilo.glyphs ?? '', /\/basemap\/fonts\/\{fontstack\}\/\{range\}\.pbf$/);
  assert.match(String(estilo.sprite ?? ''), /\/basemap\/sprites\/v4\/dark$/);
  // O estilo gerado precisa ter camadas de verdade sobre o source local.
  assert.ok(estilo.layers.length > 10, `só ${estilo.layers.length} camadas`);
  assert.ok(estilo.layers.every((c) => !('source' in c) || c.source === 'basemap'));
});

test('temas trocam o flavor: Galpão escuro, Pátio claro', () => {
  const galpao = estiloMapa('galpao', 'pmtiles://alagoas.pmtiles');
  const patio = estiloMapa('patio', 'pmtiles://alagoas.pmtiles');
  assert.match(String(patio.sprite ?? ''), /light$/);
  const fundo = (estilo: ReturnType<typeof estiloMapa>) => {
    const camada = estilo.layers.find((c) => c.id === 'background');
    return camada && 'paint' in camada
      ? String((camada.paint as { 'background-color'?: string })['background-color'])
      : '';
  };
  assert.notEqual(fundo(galpao), fundo(patio));
});

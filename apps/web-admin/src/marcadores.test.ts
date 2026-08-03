import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guarda contra o crash que apagava o painel inteiro.
 *
 * `new Marker(...).addTo(mapa)` SEM coordenada derruba a aba: `addTo` projeta a
 * posição na hora, lê `.lng` de `undefined` e a exceção sobe pelo React, que
 * desmonta a árvore toda. Aconteceu no marcador do motorista no acompanhamento
 * — tela preta assim que a primeira posição chegava.
 *
 * O erro não aparece em nenhum teste de unidade (é MapLibre com WebGL, dentro
 * de componente) e o TypeScript não pega: `setLngLat` é opcional na API. Sobra
 * ler o fonte, que é o que este teste faz, nos cinco mapas dos dois apps.
 *
 * LIMITE CONHECIDO: só enxerga a cadeia direta `new Marker(...).addTo(...)`.
 * Quando o marcador é guardado numa ref e adicionado depois (`MapaNavegacao`
 * faz isso), não há como seguir sem análise de fluxo — lá o `setLngLat` vem na
 * linha imediatamente anterior ao `addTo`, verificado na leitura.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APPS = ['apps/web-admin/src', 'apps/web-motorista/src'];

function fontesTsx(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...fontesTsx(caminho));
    else if (entrada.name.endsWith('.tsx')) achados.push(caminho);
  }
  return achados;
}

/** Recorta cada `new Marker(` até o fim da instrução (o `;` seguinte). */
function instrucoesComMarcador(fonte: string): string[] {
  const trechos: string[] = [];
  let de = fonte.indexOf('new Marker(');
  while (de !== -1) {
    const fim = fonte.indexOf(';', de);
    trechos.push(fonte.slice(de, fim === -1 ? fonte.length : fim));
    de = fonte.indexOf('new Marker(', de + 1);
  }
  return trechos;
}

test('todo marcador recebe coordenada ANTES de entrar no mapa', () => {
  const faltando: string[] = [];
  let conferidos = 0;

  for (const app of APPS) {
    for (const arquivo of fontesTsx(join(RAIZ, app))) {
      const fonte = readFileSync(arquivo, 'utf8');
      for (const trecho of instrucoesComMarcador(fonte)) {
        // Sem `addTo` na mesma instrução é o padrão adiado — fora do alcance.
        if (!trecho.includes('.addTo(')) continue;
        conferidos++;
        if (!trecho.includes('.setLngLat(')) {
          const linha = fonte.slice(0, fonte.indexOf(trecho)).split('\n').length;
          faltando.push(`${arquivo.slice(RAIZ.length + 1)}:${linha}`);
        }
      }
    }
  }

  assert.equal(
    faltando.length,
    0,
    `marcador entra no mapa sem setLngLat (derruba a tela): ${faltando.join(', ')}`,
  );
  // Se a contagem cair a zero, o teste passou a não olhar nada — provável
  // renomeação ou mudança de biblioteca, e a guarda precisa ser refeita.
  assert.ok(conferidos >= 6, `esperava conferir os marcadores dos mapas, conferi ${conferidos}`);
});

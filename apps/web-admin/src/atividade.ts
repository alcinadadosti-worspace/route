/**
 * Ações esperando o servidor (toda chamada que não é leitura: apagar,
 * publicar, dar baixa, decidir, salvar…). Com a API do plano free elas levam
 * de 1 s a 1 min (servidor acordando), e o clique sem retorno parecia não ter
 * pegado — o Admin clicava de novo. O painel mostra um aviso enquanto houver
 * alguma em curso.
 */
let emCurso = 0;
const ouvintes = new Set<(quantas: number) => void>();

/** Marca o começo de uma ação; a função devolvida marca o fim (uma vez só). */
export function comecarAtividade(): () => void {
  emCurso += 1;
  avisar();
  let terminou = false;
  return () => {
    if (terminou) return;
    terminou = true;
    emCurso -= 1;
    avisar();
  };
}

export function atividadesEmCurso(): number {
  return emCurso;
}

export function ouvirAtividade(ouvinte: (quantas: number) => void): () => void {
  ouvintes.add(ouvinte);
  return () => void ouvintes.delete(ouvinte);
}

function avisar() {
  for (const ouvinte of ouvintes) ouvinte(emCurso);
}

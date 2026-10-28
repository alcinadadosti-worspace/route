/**
 * Formulários com algo digitado e ainda não salvo (o de completar dados do
 * cliente). Um registro só, de fora dos componentes, porque quem DESCARTA o
 * que foi digitado não é o formulário: é trocar de aba (a tela inteira
 * desmonta), soltar outra importação, abrir outro cliente, fechar a página. Em
 * cada um desses o que o Admin digitou sumia calado — e a própria tela manda
 * "completar depois, na aba Clientes".
 */
const pendentes = new Set<string>();

export function marcarAlteracao(id: string, alterado: boolean): void {
  if (alterado) pendentes.add(id);
  else pendentes.delete(id);
}

export function alteracoesPendentes(): number {
  return pendentes.size;
}

/** O texto da pergunta — separado para o teste conferir que não vaza placeholder. */
export function perguntaDeDescarte(quantos: number): string {
  return (
    `Há dados digitados e não salvos em ${quantos} formulário(s). ` +
    'Sair agora descarta o que foi digitado (os clientes continuam na aba Clientes, para completar depois). Continuar?'
  );
}

/**
 * Pergunta antes de descartar; sem nada pendente, segue direto. `confirmar` é
 * o `window.confirm` — parâmetro para o teste não precisar de navegador.
 */
export function confirmarDescarte(confirmar: (texto: string) => boolean = (t) => window.confirm(t)): boolean {
  if (pendentes.size === 0) return true;
  if (!confirmar(perguntaDeDescarte(pendentes.size))) return false;
  pendentes.clear();
  return true;
}

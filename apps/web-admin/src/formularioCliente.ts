import { telefoneLegivel, type ClienteACompletar, type RevendedoraCandidata } from '@rota/shared';
import type { DadosDoCliente } from './api';

/**
 * As regras do formulário de completar dados (`CompletarDados.tsx`), fora do
 * componente para terem teste: as três erravam em silêncio e o erro só
 * aparecia no WhatsApp da pessoa errada ou no dossiê apagado.
 */

export interface CamposDoFormulario {
  telefone: string;
  observacoes: string;
}

/** Como o formulário abre: telefone legível ("(82) 99999-1234", não "+5582…"). */
export function camposIniciais(c: Pick<ClienteACompletar, 'telefone' | 'observacoes'>): CamposDoFormulario {
  return { telefone: telefoneLegivel(c.telefone) ?? '', observacoes: c.observacoes };
}

/**
 * Troca a revendedora escolhida no "É ela" — ou desfaz a escolha (`nova`
 * null). O que a escolha ANTERIOR pôs no formulário sai com ela: trocar da A
 * (com telefone) para a B (sem) deixava o telefone da A ao lado do código da
 * B, e o aviso pelo WhatsApp ia para outra pessoa. O que o Admin digitou fica.
 */
export function trocarEscolhida(
  atual: CamposDoFormulario,
  inicial: CamposDoFormulario,
  anterior: RevendedoraCandidata | null,
  nova: RevendedoraCandidata | null,
): CamposDoFormulario {
  const telefoneDaAnterior = telefoneLegivel(anterior?.telefone);
  let telefone = telefoneDaAnterior && atual.telefone === telefoneDaAnterior ? inicial.telefone : atual.telefone;
  let observacoes =
    anterior?.referencia && atual.observacoes === anterior.referencia ? inicial.observacoes : atual.observacoes;
  if (nova) {
    if (nova.telefone) telefone = telefoneLegivel(nova.telefone) ?? nova.telefone;
    // A referência da base só preenche o VAZIO: o que já foi escrito aqui (ou
    // pelo motorista, no dossiê) conhece o lugar melhor que o cadastro.
    if (nova.referencia && !observacoes.trim()) observacoes = nova.referencia;
  }
  return { telefone, observacoes };
}

/**
 * O corpo do POST: só o que MUDOU desde que o formulário abriu. Mandar tudo
 * gravava de volta o texto que a tela leu ao abrir — ela fica aberta por
 * horas, e o "como chegar" que o motorista escreveu nesse meio-tempo sumia.
 * Corpo vazio é "não tenho mais dados" (só tira da lista).
 */
export function corpoDoFormulario(
  inicial: CamposDoFormulario,
  atual: CamposDoFormulario,
  escolhida: RevendedoraCandidata | null,
): DadosDoCliente {
  const corpo: DadosDoCliente = {};
  if (atual.telefone.trim() !== inicial.telefone.trim()) corpo.telefone = atual.telefone;
  if (atual.observacoes.trim() !== inicial.observacoes.trim()) corpo.observacoes = atual.observacoes;
  if (escolhida) {
    corpo.codigo = escolhida.codigo;
    // Papel vazio na base não apaga o que o cliente já tinha.
    if (escolhida.papel) corpo.papel = escolhida.papel;
  }
  return corpo;
}

/** Algo digitado ou escolhido que ainda não foi salvo? */
export function formularioAlterado(
  inicial: CamposDoFormulario,
  atual: CamposDoFormulario,
  escolhida: RevendedoraCandidata | null,
): boolean {
  return Object.keys(corpoDoFormulario(inicial, atual, escolhida)).length > 0;
}

/** O que a tela da importação diz depois de salvar — o que foi gravado de fato. */
export function resumoDoSalvo(corpo: DadosDoCliente, telefoneFinal: string | null): string {
  if (Object.keys(corpo).length === 0) {
    return 'sem mais dados — a entrega segue com o nome e o endereço da folha.';
  }
  const partes: string[] = [];
  if (corpo.telefone !== undefined) {
    partes.push(telefoneFinal ? `telefone ${telefoneLegivel(telefoneFinal)}` : 'telefone apagado');
  }
  if (corpo.observacoes !== undefined) partes.push('referência');
  if (corpo.codigo) partes.push(`ligado ao cód. ${corpo.codigo}`);
  return `${partes.join(', ')} — salvo.`;
}

import { createHash } from 'node:crypto';
import { chaveDeMunicipio, normalizar, numeroDaCasa, type Cliente } from '@rota/shared';

/**
 * Qual cliente do cadastro é a destinatária de uma linha do ROMANEIO.
 *
 * O romaneio do Boticário não traz o código da revendedora — só nome, cidade e
 * endereço. O cadastro (`ConsultaRevendedores`, importado à parte) traz o código,
 * que é o id do cliente aqui. Casar errado é o pior resultado possível: o pedido
 * herdaria o ponto e o telefone de OUTRA pessoa, e o motorista iria à porta
 * errada com cara de certa. Por isso a regra só aceita casamento sem dúvida:
 *
 * 1. código colado no nome ("ANTONIA … 98.765" — a plataforma às vezes
 *    imprime assim), se o cliente desse código tem o mesmo nome;
 * 2. nome + cidade com UMA revendedora só — menos no pedido do SITE
 *    (Consumidor Final, código com hífen), que não é revendedora: a
 *    consumidora com o nome de uma revendedora da cidade herdava o telefone e
 *    o ponto dela. O do site só casa se a porta (rua + nº) também bater;
 * 3. nome repetido na cidade (15 casos em 5744 no cadastro real): desempata
 *    pela rua e pelo número da casa;
 * 4. qualquer dúvida que sobre → cliente NOVO, nunca um dos homônimos no chute.
 *
 * Medido no romaneio real (rota 1673300, Quebrangulo): 10 das 11 linhas casam
 * pela regra 2, todas com a mesma rua do cadastro; a 11ª é pedido do site
 * (Consumidor Final), que não é revendedora.
 */

export interface Destinataria {
  nome: string;
  cidade: string;
  logradouro: string;
  /** Texto com o número da casa ("43", "43 CASA", "S/N"). */
  numero: string;
  /** Pedido do site (Consumidor Final): ver a regra 2. */
  doSite?: boolean;
}

export type Casamento =
  /**
   * Achada na base. `codigo` é o código do ERP de onde vêm telefone, papel e
   * GPS; `id`, o cliente que fica com o pedido — o próprio código, ou o
   * cliente do romaneio que já era ela (ver `criarCasador`).
   */
  | { id: string; nome: string; noCadastro: true; codigo: string }
  /** Fora do cadastro: cliente criado (ou já criado antes) a partir do romaneio. */
  | { id: string; nome: string; noCadastro: false; motivo: 'sem-cadastro' | 'nome-repetido' };

type ClienteCasavel = { id: string } & Pick<Cliente, 'nome' | 'enderecoFiscal'> & {
  /** Já é cliente (e não só revendedora da base). */
  ehCliente?: boolean;
  /** Código do ERP que o Admin Estoque reconheceu ("É ela"). */
  codigoErp?: string | null;
};

/** Nome para comparar: sem acento, caixa, pontuação nem números ("98.765"). */
export function chaveDeNome(nome: string): string {
  return normalizar(nome).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Nome + cidade, como o cadastro GUARDA (campo `chave` de `revendedoras`) e
 * como o romaneio PROCURA — a mesma função dos dois lados, ou a consulta por
 * igualdade não acha ninguém. */
export function chaveDeRevendedora(nome: string, cidade: string): string {
  return `${chaveDeNome(nomeSemCodigo(nome))}|${chaveDeMunicipio(cidade)}`;
}

/** "ANTONIA PEREIRA DA SILVA 98.765" → "98765"; sem código no fim, null. */
export function codigoNoNome(nome: string): string | null {
  const m = /\s(\d{1,3}(?:\.\d{3})+|\d{4,})\s*$/.exec(nome);
  return m ? m[1]!.replace(/\D/g, '') : null;
}

/** O nome sem o código colado no fim, para gravar no cliente novo. */
export function nomeSemCodigo(nome: string): string {
  return nome.replace(/\s(\d{1,3}(?:\.\d{3})+|\d{4,})\s*$/, '').trim();
}

/**
 * Id do cliente que NÃO está no cadastro: hash do nome + cidade + rua + nº da
 * casa, 64 hex — o mesmo formato dos ids antigos (era da NF-e), que as telas e
 * a guarda do "refazer ponto" já aceitam. Determinístico: o próximo romaneio da
 * mesma pessoa, na mesma porta, cai no mesmo cliente e herda o que foi
 * aprendido em campo.
 *
 * O endereço entra SEMPRE. Só com nome + cidade, duas "MARIA JOSÉ DA SILVA"
 * de fora da base viravam um cliente só: o endereço da segunda sobrescrevia o
 * da primeira, as duas paradas saíam no mesmo ponto e uma casa nunca era
 * visitada. Quem se muda vira cliente novo — que é o certo: o pin e o "como
 * chegar" aprendidos eram da casa antiga.
 */
export function idSemCadastro(d: Destinataria): string {
  const partes = [
    'romaneio',
    chaveDeNome(nomeSemCodigo(d.nome)),
    chaveDeMunicipio(d.cidade),
    normalizar(d.logradouro),
    numeroDaCasa(d.numero),
  ];
  return createHash('sha256').update(partes.join('|')).digest('hex');
}

const DO_ERP = /^\d{1,20}$/;

/**
 * `candidatos`: os clientes do banco E as revendedoras do cadastro consultadas
 * para esta folha (no formato de cliente). A mesma pessoa pode vir dos dois
 * lados — e até em cidades diferentes, se mudou: cada chave guarda UMA entrada
 * por id, senão ela seria a própria homônima e cairia em "nome repetido". A
 * primeira ocorrência de um id vale: passe os clientes antes.
 */
export function criarCasador(candidatos: ClienteCasavel[]): (d: Destinataria) => Casamento {
  const porId = new Map<string, ClienteCasavel>();
  const porNomeCidade = new Map<string, Map<string, ClienteCasavel>>();
  const clientes = new Set<string>();
  const ligados = new Map<string, ClienteCasavel>();
  for (const c of candidatos) {
    if (!porId.has(c.id)) porId.set(c.id, c);
    if (c.ehCliente) clientes.add(c.id);
    if (c.ehCliente && c.codigoErp && !ligados.has(c.codigoErp)) ligados.set(c.codigoErp, c);
    const chave = chaveDeRevendedora(c.nome, c.enderecoFiscal?.municipio ?? '');
    const daChave = porNomeCidade.get(chave) ?? new Map<string, ClienteCasavel>();
    if (!daChave.has(c.id)) daChave.set(c.id, c);
    porNomeCidade.set(chave, daChave);
  }

  /**
   * Casou com o código `codigo` do ERP: qual CLIENTE fica com o pedido. O do
   * próprio código, se já existe. Senão, o cliente do romaneio que já era ela
   * — ligado pelo Admin ("É ela") ou criado na mesma porta antes de ela entrar
   * na base: sem isto, carregar os pedidos do ano criava um cliente novo, sem
   * ponto, e o pin, a trilha e o "como chegar" aprendidos ficavam órfãos.
   */
  const daBase = (codigo: string, nome: string, d: Destinataria): Casamento => {
    if (clientes.has(codigo)) return { id: codigo, nome, noCadastro: true, codigo };
    const jaEra = ligados.get(codigo) ?? porId.get(idSemCadastro(d));
    if (jaEra && clientes.has(jaEra.id)) return { id: jaEra.id, nome: jaEra.nome, noCadastro: true, codigo };
    return { id: codigo, nome, noCadastro: true, codigo };
  };
  const mesmaPorta = (c: ClienteCasavel, d: Destinataria) =>
    normalizar(c.enderecoFiscal.logradouro) === normalizar(d.logradouro) &&
    numeroDaCasa(c.enderecoFiscal.numero) === numeroDaCasa(d.numero);

  return (d) => {
    const nome = nomeSemCodigo(d.nome);
    const codigo = codigoNoNome(d.nome);
    const peloCodigo = codigo ? porId.get(codigo) : undefined;
    if (peloCodigo && chaveDeNome(peloCodigo.nome) === chaveDeNome(nome)) {
      return daBase(peloCodigo.id, peloCodigo.nome, d);
    }

    const candidatos = [...(porNomeCidade.get(chaveDeRevendedora(nome, d.cidade))?.values() ?? [])];
    // O cliente do cadastro (id numérico) vale mais que um criado antes a partir
    // de um romaneio: importado o cadastro depois, a revendedora passa a casar
    // com o registro dela, que tem telefone.
    const doErp = candidatos.filter((c) => DO_ERP.test(c.id));
    // Pedido do site: só a mesma porta prova que é a revendedora.
    if (doErp.length === 1 && !d.doSite) return daBase(doErp[0]!.id, doErp[0]!.nome, d);
    if (doErp.length >= 1) {
      const naPorta = doErp.filter((c) => mesmaPorta(c, d));
      if (naPorta.length === 1) return daBase(naPorta[0]!.id, naPorta[0]!.nome, d);
    }
    // Ninguém da base (ou dúvida): o mesmo cliente de um romaneio anterior na
    // mesma porta, se houver.
    const id = idSemCadastro(d);
    const anterior = porId.get(id);
    return {
      id,
      nome: anterior?.nome ?? nome,
      noCadastro: false,
      motivo: doErp.length > 1 ? 'nome-repetido' : 'sem-cadastro',
    };
  };
}

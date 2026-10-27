import {
  celulas,
  descompactarXlsx,
  normalizar,
  somenteDigitos,
  textosCompartilhados,
  varrerLinhas,
  type BlocoEndereco,
} from './planilha.js';

/**
 * Leitura do cadastro de revendedoras do ERP (`ConsultaRevendedores_*.xlsx`):
 * é ele que dá ao ROMANEIO do Boticário — que só traz nome e endereço — o
 * código da revendedora (o id do cliente aqui) e o telefone.
 *
 * Formato verificado no export real de 26/10/2026: duas abas ("1048Penedo" e
 * "1515Palmeira", 5744 revendedoras), texto em `sharedStrings.xml` (ao
 * contrário do export de pedidos), 69 colunas. `CodigoRevendedor` vem com
 * pontos ("70.000.002") e é o mesmo código Pessoa da planilha de pedidos: 884
 * dos 890 clientes do banco casaram por ele, todos com o mesmo nome. Lat/long
 * vêm vazios em todas as linhas — o ponto continua saindo da busca ou do campo.
 *
 * LGPD: o arquivo traz CPF, aniversário e e-mail. Só as colunas de
 * `USADAS` são lidas — o resto nem entra no mapa de valores da linha. O CPF é
 * a exceção, e só para COMPARAR, sem nunca sair daqui: no cadastro real ele
 * aparece digitado no lugar do telefone (2 linhas) e do nome (1), e sem a
 * comparação ia parar no telefone do cliente que o motorista lê.
 */

export interface LinhaCadastro {
  /** `CodigoRevendedor` só dígitos — o id do cliente. */
  codigo: string;
  nome: string;
  papel: string | null;
  /** Celular, ou o residencial quando não houver; bruto, como veio. */
  telefone: string | null;
  endereco: BlocoEndereco;
  /** "Ativo", "Cadastrado", "Desativado"… (o completo tem 15 mil desativadas). */
  situacao: string | null;
}

export type ResultadoCadastro =
  | { ok: true; linhas: LinhaCadastro[] }
  /** `naoEhCadastro`: o xlsx é outro relatório (o de pedidos) — quem chama
   * manda para o leitor certo em vez de recusar. */
  | { ok: false; motivo: string; naoEhCadastro?: boolean };

const USADAS = new Set([
  'codigorevendedor',
  'nome',
  'situacao',
  'papel',
  'telcelular',
  'telresidencial',
  'ruaentrega',
  'complementoentrega',
  'cepentrega',
  'referenciaentrega',
  'bairroentrega',
  'cidadeentrega',
  'estadoentrega',
  'ruaresidencial',
  'complementoresidencial',
  'cepresidencial',
  'referenciaresidencial',
  'bairroresidencial',
  'cidaderesidencial',
  'estadoresidencial',
  // Só para comparar (ver o topo): nunca vai para `LinhaCadastro`.
  'cpfcnpj',
]);
const OBRIGATORIAS = ['codigorevendedor', 'nome', 'ruaentrega', 'cidadeentrega'];

const ABA = /^xl\/worksheets\/sheet(\d+)\.xml$/;

export function lerCadastro(conteudo: Uint8Array): ResultadoCadastro {
  const pacote = descompactarXlsx(
    conteudo,
    (nome) => ABA.test(nome) || nome === 'xl/sharedStrings.xml',
  );
  if (!pacote.ok) return pacote;
  return cadastroDasPartes(pacote.partes);
}

/**
 * As linhas a partir das partes JÁ descompactadas do pacote. Separado da
 * descompactação porque o cadastro COMPLETO (40 mil revendedoras, uma aba de
 * 130 MB) passa do teto do servidor — a instância tem 512 MB — e é carregado
 * uma vez por script, na máquina do escritório, com este mesmo leitor.
 */
export function cadastroDasPartes(partes: Record<string, string>): ResultadoCadastro {
  const compartilhadas = textosCompartilhados(partes['xl/sharedStrings.xml'] ?? '');
  // Todas as abas, em ordem: o cadastro vem com uma por CD (ou uma só, no completo).
  const abas = Object.keys(partes)
    .filter((n) => ABA.test(n))
    .sort((a, b) => Number(ABA.exec(a)![1]) - Number(ABA.exec(b)![1]));

  const linhas: LinhaCadastro[] = [];
  let algumCabecalho = false;
  for (const aba of abas) {
    const colunas = new Map<string, string>();
    let viuCabecalho = false;
    for (const bruta of varrerLinhas(partes[aba]!)) {
      if (!viuCabecalho) {
        for (const [letra, valor] of celulas(bruta, compartilhadas)) {
          const nome = normalizar(valor);
          if (USADAS.has(nome)) colunas.set(letra, nome);
        }
        const presentes = new Set(colunas.values());
        if (presentes.size === 0) continue; // linha em branco antes do cabeçalho
        viuCabecalho = true;
        if (!presentes.has('codigorevendedor')) {
          // Primeira aba sem o código: não é este relatório (é o de pedidos).
          if (!algumCabecalho) {
            return { ok: false, motivo: 'Não é o cadastro de revendedoras', naoEhCadastro: true };
          }
          break;
        }
        const faltando = OBRIGATORIAS.filter((c) => !presentes.has(c));
        if (faltando.length > 0) {
          return { ok: false, motivo: `Cadastro de revendedoras sem as colunas: ${faltando.join(', ')}` };
        }
        algumCabecalho = true;
        continue;
      }

      const valores = new Map<string, string>();
      for (const [letra, valor] of celulas(bruta, compartilhadas)) {
        const nome = colunas.get(letra);
        if (nome) valores.set(nome, valor);
      }
      // Mesmo teto por célula da planilha de pedidos: célula gigante viraria
      // documento acima de 1 MiB, que o banco recusa.
      const v = (nome: string) => (valores.get(nome) ?? '').trim().slice(0, 1000);
      const codigo = somenteDigitos(v('codigorevendedor'));
      if (!codigo) continue; // rodapé ou linha vazia

      // CPF ou e-mail digitado no campo Nome: a linha não tem nome que se case
      // com o romaneio, e gravá-la guardaria o documento da pessoa na base.
      const cpf = semZerosAEsquerda(somenteDigitos(v('cpfcnpj')));
      const nome = v('nome');
      const digitosDoNome = somenteDigitos(nome);
      if (nome.includes('@') || digitosDoNome.length >= 11 || (cpf && semZerosAEsquerda(digitosDoNome) === cpf)) continue;
      const naoEhCpf = (telefone: string) => !cpf || semZerosAEsquerda(somenteDigitos(telefone)) !== cpf;

      // Endereço de ENTREGA, que é o que a plataforma imprime no romaneio; o
      // residencial só quando o de entrega veio vazio (9 de 5744 no real).
      const sufixo = v('ruaentrega') ? 'entrega' : 'residencial';
      linhas.push({
        codigo,
        nome,
        papel: v('papel') || null,
        telefone: [v('telcelular'), v('telresidencial')].find((t) => t && naoEhCpf(t)) ?? null,
        situacao: v('situacao') || null,
        endereco: {
          logradouro: v(`rua${sufixo}`),
          complemento: v(`complemento${sufixo}`),
          bairro: v(`bairro${sufixo}`),
          cidade: v(`cidade${sufixo}`),
          uf: v(`estado${sufixo}`),
          cep: v(`cep${sufixo}`),
          referencia: v(`referencia${sufixo}`),
        },
      });
    }
  }

  if (!algumCabecalho) return { ok: false, motivo: 'Não é o cadastro de revendedoras', naoEhCadastro: true };
  return { ok: true, linhas };
}

function semZerosAEsquerda(digitos: string): string {
  return digitos.replace(/^0+/, '');
}

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  distanciaEmMetros,
  linkLigacao,
  linkWhatsApp,
  mensagemDeRecibo,
  notaDaChaveDeAcesso,
  mensagemDeRota,
  mesclarParametrosAviso,
  formatarCarga,
  mesclarParametrosTrilha,
  paradaPrecisaMapear,
  type GeoPonto,
  type ItemPedido,
  type ResultadoEntrega,
} from '@rota/shared';
import { Mapa } from './Mapa';
import { Login } from './Login';
import { Navegacao } from './Navegacao';
import { DossieLocal, FotoReferencia } from './DossieLocal';
import { Comprovante } from './Comprovante';
import { useAutenticacao } from './useAutenticacao';
import { useAtualizacao } from './useAtualizacao';
import { useRotaDoDia } from './useRotaDoDia';
import { useClientesDaRota } from './useClientesDaRota';
import { useConfigGeral } from './useConfigGeral';
import { useMapaOffline } from './useMapaOffline';
import { estiloMapa, type Tema } from './estiloMapa';
import { tipoDeRede } from './mapaOffline';
import {
  fecharRota,
  posicaoAtual,
  reabrirRota,
  registrarAviso,
  registrarRecibo,
  registrarResultado,
} from './servicoEntrega';
import { paradasPorResolver, separarRotas, type AbaRota } from './rotaAtiva';
import { dispararProcessamento, ordemSugerida } from './servicoMapeamento';
import { processarFilaComprovantes, processarFilaFotos } from './servicoFotos';
import { usePosicao } from './usePosicao';
import { aplicarOrdemSugerida, ordemIncerta, ordenarPorProximidade } from './proximidade';
import { formatarDistancia } from './formato';

/**
 * Parada como a tela do motorista precisa dela: a ParadaRota da rota publicada
 * achatada com o que vem do dossiê do cliente.
 *
 * Não existe mais modo de demonstração. Ele foi útil na Fase 0, antes de haver
 * rota real; com o sistema em operação, mostrar três clientes inventados quando
 * não há rota publicada é pior que mostrar nada — o motorista não tem como
 * saber, olhando a tela, que aquilo não é entrega de verdade.
 */
interface ParadaTela {
  ordem: number;
  cliente: string;
  endereco: string;
  telefone: string;
  coordenada: GeoPonto;
  itens: number;
  volumes: number;
  pesoKg: number;
  status: 'pendente' | 'entregue' | 'trilha' | 'insucesso';
  observacao?: string;
  fotoPath?: string;
  pedidoId?: string;
  clienteId?: string;
  /** Minutos de direção acumulados desde o CD, calculados na publicação. */
  etaMin?: number;
  avisadoEm?: string | null;
  reciboEnviadoEm?: string | null;
  recebidoPor?: string | null;
  confirmadaEm?: string | null;
  /** Para o recibo: nº do pedido, nº da nota e a lista do que foi entregue. */
  numeroPedido?: string | null;
  numeroNota?: number;
  itensNota: ItemPedido[];
}

const ICONE_STATUS: Record<ParadaTela['status'], string> = {
  pendente: '●',
  entregue: '✔',
  trilha: '▲',
  insucesso: '✖',
};

const TEXTO_STATUS: Record<ParadaTela['status'], string> = {
  pendente: 'A entregar',
  entregue: 'Entregue',
  trilha: 'Mapear no local',
  insucesso: 'Insucesso',
};

type Filtro = 'todas' | 'a_entregar' | 'entregues' | 'insucessos' | 'rural' | 'urbana';

const ABAS_FILTRO: Array<{ id: Filtro; rotulo: string }> = [
  { id: 'todas', rotulo: 'Todas' },
  { id: 'a_entregar', rotulo: 'A entregar' },
  { id: 'rural', rotulo: 'Rural' },
  { id: 'urbana', rotulo: 'Urbana' },
  { id: 'entregues', rotulo: 'Entregues' },
  { id: 'insucessos', rotulo: 'Insucessos' },
];

/** Quais status de parada compõem cada filtro (rural = as de "navegar e mapear"). */
const STATUS_DO_FILTRO: Record<Exclude<Filtro, 'todas'>, ParadaTela['status'][]> = {
  a_entregar: ['pendente', 'trilha'],
  entregues: ['entregue'],
  insucessos: ['insucesso'],
  rural: ['trilha'],
  urbana: ['pendente'],
};

const MOTIVOS_INSUCESSO: Array<{ resultado: ResultadoEntrega; rotulo: string }> = [
  { resultado: 'ausente', rotulo: 'Ausente' },
  { resultado: 'nao_localizado', rotulo: 'Não localizado' },
  { resultado: 'recusa', rotulo: 'Recusa' },
];

/** ISO → `08h15`, para o motorista ver de relance quando avisou o cliente. */
function horaCurta(iso: string): string {
  const data = new Date(iso);
  return `${String(data.getHours()).padStart(2, '0')}h${String(data.getMinutes()).padStart(2, '0')}`;
}

/** `20260723` → `23/07/2026` — a versão do mapa é a data do extrato OSM. */
function versaoLegivel(versao: string): string {
  return `${versao.slice(6, 8)}/${versao.slice(4, 6)}/${versao.slice(0, 4)}`;
}

export function App() {
  const [tema, setTema] = useState<Tema>('galpao');
  const atualizacao = useAtualizacao();
  const { usuario, carregando, entrar, sair } = useAutenticacao();
  const { rotas, rota: rotaPadrao } = useRotaDoDia(usuario?.uid ?? null);
  /** Aba de rotas e rota escolhida à mão; null = a que abre sozinha. */
  const [abaRota, setAbaRota] = useState<AbaRota>('abertas');
  const [rotaEscolhidaId, setRotaEscolhidaId] = useState<string | null>(null);
  const listas = useMemo(() => separarRotas(rotas), [rotas]);

  /**
   * A rota na tela. A escolha à mão só vale se pertencer à ABA ABERTA — senão
   * abrir "Fechadas" mostraria a rota aberta que estava selecionada. Sem
   * escolha válida, cai na primeira da aba (nas abertas, na automática, que é a
   * regra testada em rotaAtiva.ts).
   */
  const rota = useMemo(() => {
    const escolhida = rotas.find((r) => r.id === rotaEscolhidaId);
    const daAba = listas[abaRota];
    if (escolhida && daAba.some((r) => r.id === escolhida.id)) return escolhida;
    // `rotaPadrao` só serve à aba ABERTAS, e só se ela própria estiver aberta:
    // sem nenhuma rota ativa, `escolherRotaAtiva` devolve a concluída mais
    // recente (de propósito — é o resumo do dia). Usá-la aqui mostraria uma rota
    // FECHADA embaixo do aviso "nenhuma rota aberta agora".
    if (abaRota === 'abertas' && rotaPadrao && daAba.some((r) => r.id === rotaPadrao.id)) {
      return rotaPadrao;
    }
    return daAba[0] ?? null;
  }, [rotas, rotaEscolhidaId, rotaPadrao, listas, abaRota]);
  const rotaFechada = rota?.status === 'concluida';
  const dossies = useClientesDaRota(rota);
  const config = useConfigGeral(usuario?.uid ?? null);
  const mapaOffline = useMapaOffline(config);
  const estilo = useMemo(
    () => estiloMapa(tema, mapaOffline.urlFonte),
    [tema, mapaOffline.urlFonte],
  );
  // Parâmetros de trilha: padrões mesclados com os overrides de config/geral —
  // o escritório ajusta filtros de GPS/handoff sem novo deploy (seção 11).
  const parametrosTrilha = useMemo(() => mesclarParametrosTrilha(config?.trilha), [config?.trilha]);
  // Redação e ritmo do aviso ao cliente — também ajustáveis sem deploy.
  const parametrosAviso = useMemo(() => mesclarParametrosAviso(config?.aviso), [config?.aviso]);

  // Alternância Galpão/Pátio em um toque no topo da tela (seção 14.2).
  useEffect(() => {
    document.documentElement.dataset.tema = tema;
  }, [tema]);

  // O que ficou pendente offline (trilhas por processar, fotos do dossiê e
  // COMPROVANTES de entrega) é retomado em toda abertura logada e sempre que a
  // rede volta. A fila de comprovantes tem de estar aqui: sem isto, um
  // comprovante tirado sem sinal só subiria se o motorista tirasse OUTRO
  // depois — e ficaria parado no aparelho para sempre se ele não tirasse.
  useEffect(() => {
    if (!usuario) return;
    const retomar = () => {
      dispararProcessamento();
      void processarFilaFotos();
      void processarFilaComprovantes();
    };
    retomar();
    window.addEventListener('online', retomar);
    return () => window.removeEventListener('online', retomar);
  }, [usuario]);

  // CD de partida da rota publicada. Identidade presa ao id da rota: cada
  // snapshot renova o objeto `rota`, e um `cd` novo a cada confirmação
  // recriaria o mapa da visão geral.
  const cd = useMemo(
    () => (rota ? { nome: rota.origemNome, ...rota.origemCoordenada } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rota?.id],
  );
  const paradas: ParadaTela[] = useMemo(
    () =>
      rota
        ? rota.paradas.map((p, i) => {
            const cliente = dossies[p.clienteId]?.cliente ?? null;
            return {
              ordem: i + 1,
              cliente: p.nome,
              endereco: p.endereco,
              telefone: p.telefone ?? '',
              coordenada: p.coordenada,
              // `?? []` porque um único doc de rota sem `itens` derrubaria a
              // lista INTEIRA com um TypeError — falha desproporcional.
              // Pedido importado da planilha não tem a LISTA de itens — só a
              // quantidade física. Sem o fallback, a porta do cliente mostraria
              // "0 itens" com a caixa cheia.
              itens: p.quantidadeMateriais ?? (p.itens ?? []).length,
              itensNota: p.itens ?? [],
              numeroPedido: p.numeroPedido ?? null,
              numeroNota: p.numeroNota,
              volumes: p.volumes,
              pesoKg: p.pesoBrutoKg,
              status:
                p.status === 'entregue'
                  ? ('entregue' as const)
                  : p.status === 'insucesso'
                    ? ('insucesso' as const)
                    : // Destino sem ponto confiável (rural/aproximado) → 'trilha'
                      // (mapear em campo); geocodificado/mapeado é entrega normal.
                      paradaPrecisaMapear(p.precisaMapear, cliente?.statusMapeamento)
                      ? ('trilha' as const)
                      : ('pendente' as const),
              observacao: cliente?.observacoes || undefined,
              fotoPath: cliente?.fotoReferenciaPath ?? undefined,
              pedidoId: p.pedidoId,
              clienteId: p.clienteId,
              etaMin: p.etaMin,
              avisadoEm: p.avisadoEm ?? null,
              reciboEnviadoEm: p.reciboEnviadoEm ?? null,
              recebidoPor: p.recebidoPor ?? null,
              confirmadaEm: p.confirmadaEm ?? null,
            };
          })
        : [],
    [rota, dossies],
  );
  const [insucessoAberto, setInsucessoAberto] = useState<string | null>(null);
  /**
   * Parada cujo comprovante está sendo preenchido. Um passo antes de confirmar:
   * o nome de quem recebeu se pergunta NA PORTA, com a pessoa na frente — não
   * dá para lembrar depois, no caminhão.
   */
  const [comprovanteDe, setComprovanteDe] = useState<{
    pedidoId: string;
    resultado: ResultadoEntrega;
  } | null>(null);
  // Const local: o narrowing de `comprovanteDe` tem de sobreviver ao callback do
  // JSX, e variável de state não é narrowável dentro de closure.
  const comprovanteAtual = comprovanteDe;
  const [navegandoPara, setNavegandoPara] = useState<string | null>(null);
  const [dossieAberto, setDossieAberto] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [porProximidade, setPorProximidade] = useState(false);
  /** Parada cujo trecho está em foco no mapa (índice 0-based). */
  const [paradaFocada, setParadaFocada] = useState<number | null>(null);
  /** Ordem por estrada vinda da API (null = linha reta, o padrão offline). */
  const [ordemEstrada, setOrdemEstrada] = useState<string[] | null>(null);
  const [refinando, setRefinando] = useState(false);
  const [erroOrdem, setErroOrdem] = useState<string | null>(null);

  /**
   * Fechar é decisão dele, a qualquer momento — mas com o número na frente:
   * "fechar com 4 por entregar" é uma escolha diferente de "fechar tudo feito",
   * e o aviso tem de dizer qual das duas ele está tomando.
   */
  function fechar() {
    if (!rota) return;
    const faltam = paradasPorResolver(rota);
    const texto =
      faltam > 0
        ? `Fechar a rota com ${faltam} parada(s) POR ENTREGAR?\n\n` +
          'Elas ficam sem registro de entrega e o escritório vai ter de resolver. ' +
          'A rota vai para o histórico — você pode reabrir depois, se foi engano.'
        : 'Fechar a rota? Tudo foi resolvido. Ela vai para o histórico, na aba Fechadas.';
    if (!window.confirm(texto)) return;
    fecharRota(rota.id);
    setAbaRota('fechadas');
    setRotaEscolhidaId(rota.id);
  }

  function reabrir() {
    if (!rota) return;
    if (!window.confirm('Reabrir esta rota e voltar a entregar?')) return;
    reabrirRota(rota.id);
    setAbaRota('abertas');
    setRotaEscolhidaId(rota.id);
  }

  /**
   * Guarda de distância (seção 11.9): confirmar a 3 km do ponto do cliente é,
   * quase sempre, parada errada ou esquecimento — e é exatamente o caso que
   * gera briga depois ("ausente" dado de longe). O mercado BLOQUEIA fora da
   * geofência; aqui só AVISA, por duas razões desta operação: o pin pode estar
   * errado (é ele que o motorista corrige em campo) e o app não pode travar
   * entrega quando o GPS falha — sem posição, segue sem pergunta.
   */
  const LIMIAR_GUARDA_M = 250;
  /** Confirmações em andamento — o await do GPS abre janela para toque duplo. */
  const confirmandoRef = useRef<Set<string>>(new Set());

  /**
   * Devolve SE o resultado foi registrado. O retorno existe para a navegação:
   * cancelar a guarda de distância tem de deixar o motorista ONDE ESTAVA, com
   * o comprovante preenchido — fechar a tela num cancelamento foi bug real.
   */
  async function resolver(
    pedidoId: string | undefined,
    resultado: ResultadoEntrega,
    comprovante: { recebidoPor?: string | null; foto?: Blob | null } = {},
  ): Promise<boolean> {
    if (!rota || !pedidoId || !usuario) return false;
    const parada = rota.paradas.find((p) => p.pedidoId === pedidoId);
    if (!parada) return false;
    // Parada já resolvida não gera segunda entrega (proteção contra toque
    // duplo) — mas conta como "feito": quem chamou pode fechar a tela.
    if (parada.status === 'entregue' || parada.status === 'insucesso') return true;
    if (confirmandoRef.current.has(pedidoId)) return false;
    confirmandoRef.current.add(pedidoId);
    try {
      // Destino "a mapear" tem pin sabidamente grosseiro (aproximado no
      // município): cobrar distância dele seria alarme falso em toda entrega.
      const pinConfiavel =
        paradas.find((pt) => pt.pedidoId === pedidoId)?.status !== 'trilha';
      if (pinConfiavel) {
        const posicao = await posicaoAtual();
        // Pin confirmado em campo manda sobre a coordenada da publicação — a
        // MESMA precedência da navegação e do mapa. Medir contra o pin velho
        // acusaria distância errada justamente no cliente recém-corrigido.
        const referencia =
          dossies[parada.clienteId]?.cliente?.coordenada ?? parada.coordenada;
        const distancia = posicao ? distanciaEmMetros(posicao, referencia) : null;
        if (distancia != null && distancia > LIMIAR_GUARDA_M) {
          const acao =
            resultado === 'entregue' ? 'Confirmar a entrega' : 'Registrar o insucesso';
          if (
            !window.confirm(
              `Você está a ${formatarDistancia(distancia)} do ponto deste cliente.\n\n` +
                `${acao} mesmo assim?`,
            )
          ) {
            return false;
          }
        }
      }
      registrarResultado(rota, parada, resultado, usuario.uid, comprovante);
      setInsucessoAberto(null);
      setComprovanteDe(null);
      return true;
    } finally {
      confirmandoRef.current.delete(pedidoId);
    }
  }

  // O componente Mapa recria o MapLibre quando as props mudam de identidade;
  // os snapshots de dossiê renovam `paradas` a cada chegada, então os pontos
  // só devem trocar de identidade quando algo visível no mapa mudar de fato.
  // O pedidoId ENTRA na chave. Sem ele, duas rotas com o mesmo cliente, mesma
  // posição e mesmo status davam a MESMA chave — e o memo devolvia os pontos da
  // rota anterior, com os pedidoIds antigos. Tocar no marcador chamaria um
  // pedidoId que não existe na rota aberta, e a navegação não abria. Produção
  // tem exatamente esse caso: duas rotas do mesmo dia com a mesma parada.
  const chavePontos = paradas
    .map((p) => `${p.pedidoId}:${p.ordem}:${p.status}:${p.coordenada.lat},${p.coordenada.lng}`)
    .join('|');
  const pontosMapa = useMemo(
    () =>
      paradas.map((p) => ({
        ordem: p.ordem,
        cliente: p.cliente,
        coordenada: p.coordenada,
        status: p.status,
        pedidoId: p.pedidoId,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chavePontos],
  );

  const entregues = paradas.filter((p) => p.status === 'entregue').length;

  const contagem = useMemo((): Record<Filtro, number> => {
    const conta = (fs: ParadaTela['status'][]) => paradas.filter((p) => fs.includes(p.status)).length;
    return {
      todas: paradas.length,
      a_entregar: conta(STATUS_DO_FILTRO.a_entregar),
      entregues: conta(STATUS_DO_FILTRO.entregues),
      insucessos: conta(STATUS_DO_FILTRO.insucessos),
      rural: conta(STATUS_DO_FILTRO.rural),
      urbana: conta(STATUS_DO_FILTRO.urbana),
    };
  }, [paradas]);

  const paradasFiltradas = useMemo(
    () =>
      filtro === 'todas'
        ? paradas
        : paradas.filter((p) => STATUS_DO_FILTRO[filtro].includes(p.status)),
    [paradas, filtro],
  );

  // Visão "mais perto de mim" (não altera a rota publicada). O GPS só liga
  // quando o motorista pede — na lista, um watch permanente seria bateria à toa
  // — e desliga durante a navegação, que tem o watch dela: dois `watchPosition`
  // no mesmo aparelho é o dobro de acordar o GPS sem nenhum ganho.
  const { leitura: posicaoLista } = usePosicao(porProximidade && !navegandoPara);
  const posicao = useMemo(
    () => (posicaoLista ? { lat: posicaoLista.lat, lng: posicaoLista.lng } : null),
    [posicaoLista],
  );
  const paradasNaTela = useMemo(() => {
    if (!porProximidade) return paradasFiltradas.map((p) => ({ ...p, distanciaM: null }));
    return ordemEstrada
      ? aplicarOrdemSugerida(paradasFiltradas, ordemEstrada, posicao)
      : ordenarPorProximidade(paradasFiltradas, posicao);
  }, [paradasFiltradas, porProximidade, ordemEstrada, posicao]);
  /**
   * O GPS distingue mesmo a 1ª da 2ª? `watchPosition` entrega primeiro uma
   * posição de rede (±km em zona rural) e só depois refina — nesse intervalo a
   * ordem sai embaralhada com cara de certa. Só vale para a linha reta: a
   * ordem por estrada vem do OSRM, que já parte da posição enviada.
   */
  const incerta = useMemo(
    () => !ordemEstrada && ordemIncerta(paradasNaTela, posicaoLista?.precisaoM ?? null),
    [paradasNaTela, ordemEstrada, posicaoLista],
  );

  // A primeira ainda por entregar é "a próxima" — só faz sentido com a lista
  // realmente ordenada por distância (ou pela sugestão da estrada).
  const proximaPedidoId =
    porProximidade && posicao
      ? (paradasNaTela.find((p) => p.status === 'pendente' || p.status === 'trilha')?.pedidoId ??
        null)
      : null;

  /** Aviso da parada com a janela relativa a AGORA (chamada no toque). */
  function mensagemDaParada(p: ParadaTela): string {
    return mensagemDeRota(new Date(), p.etaMin ?? 0, p.ordem - 1, parametrosAviso);
  }

  /**
   * Recibo com a hora da ENTREGA, não a do toque.
   *
   * O aviso de chegada é uma previsão e por isso é refeito no toque; o recibo é
   * o oposto — afirma um fato passado. Montá-lo com `new Date()` fazia o cliente
   * receber "entrega registrada às 14h20" quando a entrega foi às 14h05, e a
   * diferença cresce com a demora em mandar. Recibo com hora errada é pior que
   * recibo nenhum.
   *
   * `new Date()` só como último recurso, para rota antiga sem o campo.
   */
  function mensagemDoRecibo(p: ParadaTela): string {
    const quando = p.confirmadaEm ? new Date(p.confirmadaEm) : new Date();
    // Rota publicada antes da denormalização não traz numeroNota — mas o
    // pedidoId É a chave de acesso, e o número da nota mora dentro dela.
    const daChave = p.numeroNota == null && p.pedidoId ? notaDaChaveDeAcesso(p.pedidoId) : null;
    return mensagemDeRecibo(quando, p.recebidoPor ?? null, parametrosAviso, {
      numeroPedido: p.numeroPedido,
      numeroNota: p.numeroNota ?? daChave?.numeroNota,
      itens: p.itensNota,
      // Pedido da planilha nao tem lista, so o total — sem isto o recibo
      // omitia a mercadoria inteira.
      quantidadeMateriais: p.itens,
    });
  }

  async function refinarPorEstrada() {
    if (!rota || !posicao) return;
    setRefinando(true);
    setErroOrdem(null);
    try {
      setOrdemEstrada(await ordemSugerida(rota.id, posicao));
    } catch (e) {
      setErroOrdem(e instanceof Error ? e.message : 'Não deu para calcular agora');
    } finally {
      setRefinando(false);
    }
  }

  if (carregando) {
    return <div className="tela-login"><div className="sub-login">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
  }

  const paradaNavegando =
    rota && navegandoPara ? (rota.paradas.find((p) => p.pedidoId === navegandoPara) ?? null) : null;

  if (rota && paradaNavegando) {
    // Demais paradas por entregar, na ordem publicada — o número no mapa é o
    // mesmo do cartão, senão o motorista teria duas numerações para conciliar.
    const outrasParadas = rota.paradas
      .map((p, i) => ({ parada: p, ordem: i + 1 }))
      .filter(
        ({ parada: p }) =>
          p.pedidoId !== paradaNavegando.pedidoId &&
          p.status !== 'entregue' &&
          p.status !== 'insucesso',
      )
      .map(({ parada: p, ordem }) => ({
        pedidoId: p.pedidoId,
        ordem,
        nome: p.nome,
        // Pin confirmado em campo na frente da coordenada da publicação —
        // mesma precedência do destino atual, para o marcador não cair num
        // ponto que já se sabe errado.
        coordenada: dossies[p.clienteId]?.cliente?.coordenada ?? p.coordenada,
      }));
    return (
      <Navegacao
        // Trocar de parada REMONTA a tela: chegada, pin ajustado, gravação e
        // traçado recalculado são estado DAQUELA parada e têm de zerar juntos.
        key={paradaNavegando.pedidoId}
        rota={rota}
        parada={paradaNavegando}
        dossie={dossies[paradaNavegando.clienteId] ?? null}
        uid={usuario.uid}
        estilo={estilo}
        estiloKey={mapaOffline.urlFonte ?? 'online'}
        parametros={parametrosTrilha}
        parametrosAviso={parametrosAviso}
        outrasParadas={outrasParadas}
        aoTrocarParada={setNavegandoPara}
        aoResolver={(pedidoId, resultado, comprovante) =>
          resolver(pedidoId, resultado, comprovante ?? {})
        }
        aoFechar={() => setNavegandoPara(null)}
      />
    );
  }

  // Guarda de egresso (seção 12): download só em Wi-Fi; rede indetectável
  // pede confirmação em vez de bloquear.
  function baixarMapaComGuarda() {
    const mb = Math.round((mapaOffline.atualizacao?.tamanhoBytes ?? 0) / 1e6);
    const rede = tipoDeRede();
    if (rede === 'celular') {
      window.alert(`Download de ~${mb} MB — conecte ao Wi-Fi da base para baixar.`);
      return;
    }
    if (rede === 'desconhecida' && !window.confirm(`Não deu para confirmar o Wi-Fi. Baixar ~${mb} MB agora?`)) {
      return;
    }
    mapaOffline.baixar();
  }

  return (
    <div className="app">
      {/* Versão nova disponível. NÃO recarrega sozinho: no meio de um
          comprovante — nome digitado, foto anexada — a recarga perderia o que
          ele acabou de fazer na porta do cliente. Ele escolhe a hora. */}
      {atualizacao.temAtualizacao && (
        <button className="faixa-atualizacao" onClick={() => atualizacao.aplicar?.()}>
          ⬆ Nova versão disponível — toque para atualizar
        </button>
      )}
      <header className="topo">
        <div className="topo-marca">
          <img src="/logo.png" className="logo-marca" alt="Alcina Maria" />
          <div>
            <h1>Rota do dia</h1>
            <div className="dia">
              {rota ? `${rota.data} · ${rota.origemNome.toUpperCase()}` : 'SEM ROTA PUBLICADA'}
            </div>
          </div>
        </div>
        <div className="topo-acoes">
          <button
            className="tema-botao"
            onClick={() => setTema(tema === 'galpao' ? 'patio' : 'galpao')}
            aria-label="Alternar tema claro/escuro"
          >
            {tema === 'galpao' ? '☀ PÁTIO' : '● GALPÃO'}
          </button>
          <button className="tema-botao" onClick={() => void sair()} aria-label="Sair da conta">
            SAIR
          </button>
        </div>
      </header>

      {rota && (
        <div className="faixa-rota">ROTA PUBLICADA · {rota.distanciaTotalKm} km · {Math.floor(rota.duracaoTotalMin / 60)}h{String(rota.duracaoTotalMin % 60).padStart(2, '0')}</div>
      )}

      {mapaOffline.pronto && (mapaOffline.baixando != null || mapaOffline.atualizacao) && (
        <section className="mapa-offline">
          <div className="mapa-offline-info">
            <div className="mapa-offline-titulo">Mapa offline</div>
            {mapaOffline.baixando != null ? (
              <>
                <div className="mapa-offline-texto">
                  Baixando… {Math.round(mapaOffline.baixando * 100)}%
                </div>
                <div className="progresso">
                  <div
                    className="progresso-preenchido"
                    style={{ width: `${Math.round(mapaOffline.baixando * 100)}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="mapa-offline-texto">
                {mapaOffline.erro
                  ? `Falha no download — ${mapaOffline.erro}`
                  : `${
                      mapaOffline.versaoInstalada
                        ? `Nova versão de ${versaoLegivel(mapaOffline.atualizacao!.versao)}`
                        : 'Mapa de Alagoas para navegar sem sinal'
                    } · ${Math.round(mapaOffline.atualizacao!.tamanhoBytes / 1e6)} MB — baixe no Wi-Fi da base`}
              </div>
            )}
          </div>
          {mapaOffline.baixando == null && (
            <button className="mapa-offline-botao" onClick={baixarMapaComGuarda}>
              {mapaOffline.erro ? '↻ Tentar de novo' : mapaOffline.versaoInstalada ? '⬇ Atualizar' : '⬇ Baixar'}
            </button>
          )}
        </section>
      )}

      {/* Sem rota não há o que desenhar: o mapa da visão geral existe para
          mostrar as paradas do dia. */}
      {rota &&
        (mapaOffline.pronto && cd ? (
          <Mapa
            cd={cd}
            paradas={pontosMapa}
            polyline={rota.polylinePlanejada}
            estilo={estilo}
            aoEscolherParada={setNavegandoPara}
            paradaFocada={paradaFocada}
            aoFocarParada={setParadaFocada}
          />
        ) : (
          <div className="mapa" />
        ))}
      {rota && paradaFocada != null && paradas[paradaFocada] && (
        <div className="foco-trecho">
          Mostrando o caminho até a <strong>PARADA {String(paradaFocada + 1).padStart(2, '0')}</strong>{' '}
          · {paradas[paradaFocada]!.cliente}
          <button onClick={() => setParadaFocada(null)}>ver rota toda</button>
        </div>
      )}
      {/* Estado do mapa embarcado: interessa mesmo sem rota, porque baixá-lo é
          o que o motorista faz no Wi-Fi da base ANTES de sair. */}
      <div className="mapa-nota">
        {mapaOffline.versaoInstalada
          ? `Mapa embarcado de ${versaoLegivel(mapaOffline.versaoInstalada)} — navega sem sinal`
          : 'Basemap online — baixe o mapa offline para navegar sem sinal'}
      </div>

      {rotas.length === 0 && (
        <section className="sem-rota">
          <div className="sem-rota-titulo">Nenhuma rota publicada para você</div>
          <p>
            Quando o escritório publicar a rota do dia, ela aparece aqui sozinha — e fica no
            aparelho, para você seguir mesmo sem sinal.
          </p>
          <p className="sem-rota-dica">
            Aproveite o Wi-Fi da base para baixar o mapa offline, se ainda não baixou.
          </p>
        </section>
      )}

      {/* As abas ficam FORA do bloco da rota: com a aba vazia (só fechadas, ou
          só abertas) não pode sumir a navegação, senão ele fica preso numa
          lista vazia sem como voltar. */}
      {rotas.length > 0 && (
        <>
          <nav className="abas-rota" role="tablist" aria-label="Rotas">
            {(['abertas', 'fechadas'] as const).map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={abaRota === id}
                className="aba-rota"
                onClick={() => {
                  setAbaRota(id);
                  // Escolha à mão zerada: a rota da aba anterior não é desta.
                  setRotaEscolhidaId(null);
                  setParadaFocada(null);
                }}
              >
                {id === 'abertas' ? 'Rotas abertas' : 'Fechadas'}{' '}
                <span className="aba-contagem">{listas[id].length}</span>
              </button>
            ))}
          </nav>

          {/* O seletor só aparece quando há escolha a fazer — numa rota só, ele
              seria ruído entre o motorista e o trabalho. */}
          {listas[abaRota].length > 1 && (
            <div className="seletor-rota">
              {listas[abaRota].map((r) => {
                const feitas = r.paradas.filter(
                  (p) => p.status === 'entregue' || p.status === 'insucesso',
                ).length;
                return (
                  <button
                    key={r.id}
                    className={`chip-rota${rota?.id === r.id ? ' ativa' : ''}`}
                    aria-pressed={rota?.id === r.id}
                    onClick={() => {
                      setRotaEscolhidaId(r.id);
                      setParadaFocada(null);
                    }}
                  >
                    {r.data.slice(8, 10)}/{r.data.slice(5, 7)} · {feitas}/{r.paradas.length}
                  </button>
                );
              })}
            </div>
          )}

          {listas[abaRota].length === 0 && (
            <div className="vazio-rota">
              {abaRota === 'abertas'
                ? 'Nenhuma rota aberta agora — o que você fechou está na aba Fechadas.'
                : 'Nenhuma rota fechada nos últimos 7 dias.'}
            </div>
          )}
        </>
      )}

      {rota && (
      <>
      {rotaFechada && (
        <div className="aviso-outra-rota">
          ✔ Rota fechada{rota?.concluidaEm ? ` às ${horaCurta(rota.concluidaEm)}` : ''}. Você está
          vendo o histórico — não dá para confirmar entrega aqui.
          {paradasPorResolver(rota!) > 0 && (
            <>
              {' '}
              Ficaram <strong>{paradasPorResolver(rota!)}</strong> parada(s) sem resolver.
            </>
          )}
        </div>
      )}

      <div className="resumo">
        <div className="bloco">
          <div className="num">{paradas.length}</div>
          <div className="rot">Paradas</div>
        </div>
        <div className="bloco">
          <div className="num">{entregues}</div>
          <div className="rot">Entregues</div>
        </div>
        <div className="bloco">
          <div className="num">{paradas.length - entregues}</div>
          <div className="rot">Restantes</div>
        </div>
      </div>

      <nav className="abas-filtro" role="tablist" aria-label="Filtrar paradas">
        {/* Abas vazias somem, MENOS a que está selecionada: entregar a última
            parada rural fazia a aba Rural desaparecer com o filtro ainda nela,
            deixando a lista vazia sem nenhuma aba marcada. */}
        {ABAS_FILTRO.filter(
          (a) => a.id === 'todas' || a.id === 'a_entregar' || a.id === filtro || contagem[a.id] > 0,
        ).map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={filtro === a.id}
            className={`aba-filtro${a.id === 'rural' ? ' rural' : ''}`}
            onClick={() => setFiltro(a.id)}
          >
            {a.rotulo} <span className="aba-contagem">{contagem[a.id]}</span>
          </button>
        ))}
      </nav>

      <div className="ordenacao">
        <button
          className="aba-filtro"
          aria-pressed={porProximidade}
          aria-selected={porProximidade}
          onClick={() => {
            setPorProximidade(!porProximidade);
            // A ordem por estrada foi calculada de onde o motorista ESTAVA:
            // sair e voltar ao modo recomeça pela linha reta, que é sempre atual.
            setOrdemEstrada(null);
            setErroOrdem(null);
          }}
        >
          📍 Mais perto de mim
        </button>
        {porProximidade && !posicao && <span className="ordenacao-aviso">procurando GPS…</span>}
        {porProximidade && posicao && rota && (
          <button className="aba-filtro" disabled={refinando} onClick={() => void refinarPorEstrada()}>
            {refinando ? '🛣 calculando…' : ordemEstrada ? '🛣 por estrada ✔' : '🛣 refinar por estrada'}
          </button>
        )}
      </div>
      {porProximidade && (
        <div className="ordenacao-nota">
          {erroOrdem
            ? `⚠ ${erroOrdem} — seguindo pela distância em linha reta.`
            : ordemEstrada
              ? 'Ordem por distância de estrada, a partir de onde você está.'
              : incerta
                ? `⚠ GPS com ±${Math.round(posicaoLista?.precisaoM ?? 0)} m — as primeiras estão perto demais uma da outra para o aparelho separar. Espere o sinal firmar ou use "refinar por estrada".`
                : 'Ordem por distância em linha reta (funciona sem sinal). A ordem oficial da rota não muda.'}
          {/* A dúvida que aparece na primeira vez que alguém usa: "a mais perto
              de mim é a PARADA 04, por que ela não é a 01?". Porque as duas
              ordens respondem perguntas diferentes — e a oficial nem parte de
              onde o motorista está. */}
          <div className="ordenacao-explica">
            Os números (PARADA 01, 02…) são a ordem do escritório, calculada
            saindo do CD e voltando pra ele — por isso a mais perto de você pode
            ter número alto.
          </div>
        </div>
      )}

      {paradasNaTela.length === 0 && (
        <div className="vazio-filtro">Nenhuma parada neste filtro.</div>
      )}

      {paradasNaTela.map((p) => (
        <article key={p.ordem} className={`parada${p.status === 'trilha' ? ' rural' : ''}`}>
          <div className="ordem">
            PARADA {String(p.ordem).padStart(2, '0')}
            {/* Botão de verdade, com rótulo: antes o clique estava no texto
                "PARADA 05", sem nada indicando que era tocável — a função
                existia e ninguém achava. */}
            <button
              className={`ver-caminho${paradaFocada === p.ordem - 1 ? ' ativo' : ''}`}
              onClick={() => setParadaFocada(paradaFocada === p.ordem - 1 ? null : p.ordem - 1)}
            >
              {paradaFocada === p.ordem - 1 ? '🔍 caminho em foco' : '🔍 ver caminho'}
            </button>
            {p.distanciaM != null && (
              <span className="parada-distancia">· {formatarDistancia(p.distanciaM)}</span>
            )}
            {p.pedidoId != null && p.pedidoId === proximaPedidoId && (
              <span className="chip-proxima">PRÓXIMA</span>
            )}
          </div>
          <h2>{p.cliente}</h2>
          <div className="endereco">{p.endereco}</div>
          <div className="carga">
            {p.itens} itens · {formatarCarga(p.volumes, p.pesoKg)}
          </div>
          {p.fotoPath && <FotoReferencia caminho={p.fotoPath} alt={`Referência de ${p.cliente}`} />}
          {p.observacao && <div className="obs">📌 {p.observacao}</div>}
          <span className={`estado ${p.status}`}>
            {ICONE_STATUS[p.status]} {TEXTO_STATUS[p.status]}
          </span>

          {/* Rota fechada é histórico: sem botão de confirmar, senão o registro
              de entrega nasceria depois do fechamento e o relatório do dia
              mudaria sozinho. Para voltar a entregar, reabra a rota. */}
          {!rotaFechada && (p.status === 'pendente' || p.status === 'trilha') && (
            <div className="acoes">
              {p.telefone && (
                <>
                  <a href={linkLigacao(p.telefone)}>📞 Ligar</a>
                  <a href={linkWhatsApp(p.telefone)} target="_blank" rel="noreferrer">
                    💬 WhatsApp
                  </a>
                  {/* Aviso com a janela estimada — o que evita o "ausente".
                      A janela é RECALCULADA NO TOQUE, não na renderização: a
                      lista pode ficar horas na tela sem re-renderizar (só
                      snapshot ou interação provocam isso), e um "chego entre
                      8h30 e 9h50" enviado às 10h30 é pior que nenhum aviso. O
                      href do render é só o valor inicial, para o link funcionar
                      de qualquer forma. */}
                  <a
                    className={`avisar${p.avisadoEm ? ' feito' : ''}`}
                    href={linkWhatsApp(p.telefone, mensagemDaParada(p))}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(evento) => {
                      evento.currentTarget.href = linkWhatsApp(p.telefone!, mensagemDaParada(p));
                      if (rota && p.pedidoId) registrarAviso(rota, p.pedidoId);
                    }}
                  >
                    {p.avisadoEm ? `✔ Avisado ${horaCurta(p.avisadoEm)}` : '📣 Avisar chegada'}
                  </a>
                </>
              )}
              <button className="navegar" onClick={() => setNavegandoPara(p.pedidoId ?? null)}>
                🧭 Navegar{p.status === 'trilha' ? ' e mapear' : ''}
              </button>
              {/* Confirmar deixou de gravar direto: abre o comprovante, onde o
                  nome de quem recebeu é perguntado com a pessoa na frente. */}
              <button
                className="confirmar"
                onClick={() =>
                  p.pedidoId && setComprovanteDe({ pedidoId: p.pedidoId, resultado: 'entregue' })
                }
              >
                ✔ Confirmar entrega
              </button>
              <button
                className="insucesso-botao"
                onClick={() =>
                  setInsucessoAberto(insucessoAberto === p.pedidoId ? null : (p.pedidoId ?? null))
                }
              >
                ✖ Registrar insucesso
              </button>
              {insucessoAberto === p.pedidoId && comprovanteAtual?.pedidoId !== p.pedidoId && (
                <div className="motivos">
                  {MOTIVOS_INSUCESSO.map((m) => (
                    <button
                      key={m.resultado}
                      onClick={() =>
                        p.pedidoId &&
                        setComprovanteDe({ pedidoId: p.pedidoId, resultado: m.resultado })
                      }
                    >
                      {m.rotulo}
                    </button>
                  ))}
                </div>
              )}
              {comprovanteAtual && comprovanteAtual.pedidoId === p.pedidoId && (
                <Comprovante
                  resultado={comprovanteAtual.resultado}
                  nomeCliente={p.cliente}
                  aoConfirmar={({ recebidoPor, foto }) =>
                    resolver(p.pedidoId, comprovanteAtual.resultado, { recebidoPor, foto })
                  }
                  aoCancelar={() => setComprovanteDe(null)}
                />
              )}
            </div>
          )}

          {/* O que ficou registrado, no proprio card: e o que o motorista
              confere antes de mandar o recibo, e o que ele mostra ao cliente
              se houver duvida na hora. */}
          {p.status === 'entregue' && (p.recebidoPor || p.confirmadaEm) && (
            <div className="recebido-por">
              ✔ Entregue{p.confirmadaEm ? ` ${horaCurta(p.confirmadaEm)}` : ''}
              {p.recebidoPor ? ` · recebido por ${p.recebidoPor}` : ' · sem nome anotado'}
            </div>
          )}

          {/* Recibo ao cliente, depois de confirmada. É o que dá força ao
              comprovante: a cópia fica no celular DELE, com data, fora do nosso
              alcance. O WhatsApp entrega quando ele pegar sinal — não exige que
              esteja online agora, o que importa numa base 1/5 rural. */}
          {/* Vale TAMBÉM em rota fechada. Mandar o recibo não muda registro
              nenhum — só comunica um fato já gravado —, e esquecer de mandar
              antes de fechar não pode custar o recibo do cliente. */}
          {p.status === 'entregue' && p.telefone && (
            <a
              className={`recibo${p.reciboEnviadoEm ? ' feito' : ''}`}
              href={linkWhatsApp(p.telefone, mensagemDoRecibo(p))}
              target="_blank"
              rel="noreferrer"
              onClick={(evento) => {
                evento.currentTarget.href = linkWhatsApp(p.telefone!, mensagemDoRecibo(p));
                if (rota && p.pedidoId) registrarRecibo(rota, p.pedidoId);
              }}
            >
              {p.reciboEnviadoEm
                ? `✔ Recibo enviado ${horaCurta(p.reciboEnviadoEm)}`
                : '🧾 Mandar recibo ao cliente'}
            </a>
          )}

          {(p.status === 'entregue' || p.status === 'insucesso') &&
            p.clienteId &&
            dossies[p.clienteId]?.cliente && (
              <>
                <button
                  className="dossie-toggle"
                  onClick={() =>
                    setDossieAberto(dossieAberto === p.pedidoId ? null : (p.pedidoId ?? null))
                  }
                >
                  📋 {dossieAberto === p.pedidoId ? 'Fechar dossiê do local' : 'Dossiê do local'}
                </button>
                {dossieAberto === p.pedidoId && (
                  <DossieLocal cliente={dossies[p.clienteId]!.cliente!} />
                )}
              </>
            )}
        </article>
      ))}

      {/* Fechar fica DEPOIS de tudo, no fim da rolagem: é o último ato do dia, e
          longe do polegar que está confirmando entregas. */}
      {rota && !rotaFechada && (
        <button className="fechar-rota" onClick={fechar}>
          🏁 Fechar esta rota
        </button>
      )}
      {rota && rotaFechada && paradasPorResolver(rota) > 0 && (
        <button className="reabrir-rota" onClick={reabrir}>
          ↺ Reabrir rota
        </button>
      )}
      </>
      )}

      <footer className="rodape">Offline-first · dados sincronizam ao reencontrar rede</footer>
    </div>
  );
}

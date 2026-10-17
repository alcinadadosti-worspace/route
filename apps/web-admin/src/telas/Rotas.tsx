import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  diaEmAlagoas,
  distanciaEmMetros,
  excecoesDaSelecao,
  formatarCarga,
  formatarDia,
  formatarHora,
  municipioDoPedido,
  normalizar,
  paradasEmAberto,
  rotasSemBaixa,
  type ResultadoBaixa,
  haQuantoTempo,
  posicaoEstaVelha,
  type CentroDistribuicao,
  type GrupoSugerido,
  type PosicaoMotorista,
  type Cliente,
  type Entrega,
  type Pedido,
  type PreviaRota,
  type Rota,
  type Usuario,
} from '@rota/shared';
import {
  agruparPorRegiao,
  apagarPedido,
  apagarRota,
  darBaixa,
  listarCds,
  listarClientes,
  listarEntregasDaRota,
  listarPedidos,
  obterAcompanhamento,
  listarRotas,
  listarUsuarios,
  previaDeRota,
  publicarRota,
} from '../api';
import { MapaRota } from '../MapaRota';
import { MapaAcompanhamento } from '../MapaAcompanhamento';
import { LimiteDeErro } from '../LimiteDeErro';
import { FotoReferencia } from '../FotoReferencia';
import { montarRoteiro } from '../roteiro';
import { baixarPdfRoteiro } from '../roteiroPdf';
import { alternarGrupo, estadoDoGrupo } from '../selecaoCidades';

/** Status da parada em português — o enum cru não é para o operador ler. */
const ROTULO_PARADA: Record<string, string> = {
  em_rota: 'A entregar',
  entregue: 'Entregue',
  insucesso: 'Insucesso',
};

/** Motivo do insucesso como o motorista escolheu (RF-18). */
const ROTULO_RESULTADO: Record<string, string> = {
  entregue: 'Entregue',
  ausente: 'Cliente ausente',
  nao_localizado: 'Endereço não localizado',
  recusa: 'Recusou a mercadoria',
};

/** Hora de um campo ISO do banco. Data torta vira traço, nunca "Invalid Date". */
const horaDe = formatarHora;

const ROTULO_ROTA: Record<string, { texto: string; classe: string }> = {
  rascunho: { texto: 'Rascunho', classe: '' },
  publicada: { texto: 'Publicada', classe: 'pendente' },
  em_execucao: { texto: 'Em execução', classe: 'pendente' },
  concluida: { texto: 'Concluída', classe: 'pronto' },
};

/**
 * Montagem de rota (RF-11): o operador seleciona os pedidos prontos, escolhe
 * o CD de partida e otimiza — a prévia mostra a ordem das paradas, o traçado
 * e as estimativas. Publicação para o motorista (RF-13) é o próximo passo.
 */
export function Rotas() {
  const [pedidos, setPedidos] = useState<Array<{ id: string } & Pedido>>([]);
  const [clientes, setClientes] = useState<Record<string, Cliente>>({});
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [cdId, setCdId] = useState<string>('');
  /** O operador pediu para trocar o CD que as notas definiram. */
  const [trocandoCd, setTrocandoCd] = useState(false);
  const [retornaAoCd, setRetornaAoCd] = useState(true);
  const [previa, setPrevia] = useState<PreviaRota | null>(null);
  const [otimizando, setOtimizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /**
   * Explica o que ACONTECEU, quando o resultado não é óbvio na tela — e diz em
   * QUE seção mostrar. Acompanhamento e Montagem estão longe uma da outra:
   * confirmar "10 pedidos apagados" lá em cima, fora da tela de quem apagou na
   * de baixo, é o mesmo que não confirmar.
   */
  const [aviso, setAviso] = useState<{ texto: string; onde: 'acompanhamento' | 'montagem' } | null>(
    null,
  );
  const [usuarios, setUsuarios] = useState<Array<{ id: string } & Usuario>>([]);
  const [motoristaId, setMotoristaId] = useState('');
  const [publicando, setPublicando] = useState(false);
  const [apagandoLote, setApagandoLote] = useState(false);
  const [publicada, setPublicada] = useState<string | null>(null);
  const [rotas, setRotas] = useState<Array<{ id: string } & Rota>>([]);
  /** Rota expandida no acompanhamento, para ver parada a parada. */
  const [rotaAberta, setRotaAberta] = useState<string | null>(null);
  /**
   * Confirmações da rota aberta, por pedidoId. Buscadas só ao expandir: o motivo
   * do insucesso não cabe na parada (que só guarda 'insucesso') e ler o
   * histórico inteiro para mostrar uma rota seria desperdício.
   */
  const [entregasDaRota, setEntregasDaRota] = useState<Record<string, Entrega>>({});
  const [carregandoEntregas, setCarregandoEntregas] = useState(false);
  /** Exceções sugeridas que o operador DESMARCOU. Guarda-se o "não", e não o
   * "sim": a exceção que surge ao marcar outra cidade já chega marcada. */
  const [excecoesDesmarcadas, setExcecoesDesmarcadas] = useState<Set<string>>(new Set());
  /** Baixa em preparo na rota aberta: pedidoId → resultado marcado. Só vai ao
   * servidor no "Registrar baixa", tudo de uma vez — e numa transação. */
  const [marcasBaixa, setMarcasBaixa] = useState<Record<string, ResultadoBaixa>>({});
  const [baixando, setBaixando] = useState(false);
  const [erroBaixa, setErroBaixa] = useState<string | null>(null);
  const [gerandoPdf, setGerandoPdf] = useState<string | null>(null);
  /**
   * Quando a última baixa foi gravada. Uma busca do acompanhamento que SAIU
   * antes dela traz o estado de antes e, chegando depois, desfazia na tela a
   * baixa recém-registrada: os botões voltavam, e registrar de novo dava erro.
   */
  const baixaGravadaEm = useRef(0);

  useEffect(() => {
    // Marcas de baixa são de UMA rota: abrir outra com marcas da anterior
    // registraria pedidos que não são dela (a API recusaria, mas confunde).
    setMarcasBaixa({});
    setErroBaixa(null);
    if (!rotaAberta) {
      setEntregasDaRota({});
      return;
    }
    let ativo = true;
    setCarregandoEntregas(true);
    setEntregasDaRota({});
    listarEntregasDaRota(rotaAberta)
      .then((es) => {
        if (!ativo) return;
        // Mais recente por pedido: a coleção admite duplicata (id automático) e
        // a última é a que casa com o status gravado na parada.
        const porPedido: Record<string, Entrega> = {};
        for (const e of [...es].sort((a, b) => a.confirmadaEm.localeCompare(b.confirmadaEm))) {
          porPedido[e.pedidoId] = e;
        }
        setEntregasDaRota(porPedido);
      })
      .catch(() => ativo && setEntregasDaRota({}))
      .finally(() => ativo && setCarregandoEntregas(false));
    return () => {
      ativo = false;
    };
  }, [rotaAberta]);

  function carregar() {
    Promise.all([listarPedidos(), listarCds(), listarUsuarios(), listarRotas(), listarClientes()])
      .then(([ps, c, us, rs, cls]) => {
        setPedidos(ps);
        setClientes(Object.fromEntries(cls.map((cl) => [cl.id, cl])));
        setCds(c);
        setCdId((atual) => atual || (Object.keys(c)[0] ?? ''));
        // TODOS ficam guardados para dar nome às rotas antigas: filtrar aqui
        // fazia a rota de um motorista desativado exibir o uid cru para sempre.
        setUsuarios(us);
        const ativos = us.filter((u) => u.ativo);
        setMotoristaId(
          (atual) => atual || (ativos.find((u) => u.papel === 'motorista') ?? ativos[0])?.id || '',
        );
        setRotas(rs);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar'));
  }

  useEffect(carregar, []);

  const nomeDoUsuario = (id: string) => usuarios.find((u) => u.id === id)?.nome ?? id.slice(0, 8);

  const prontos = useMemo(
    () => pedidos.filter((p) => p.status === 'pronto_para_rota'),
    [pedidos],
  );
  const pendentes = useMemo(
    () => pedidos.filter((p) => p.status === 'pendente_de_mapeamento'),
    [pedidos],
  );
  const idsProntos = useMemo(() => new Set(prontos.map((p) => p.id)), [prontos]);

  /**
   * Pedidos sem ponto das MESMAS cidades da seleção: vão como exceção, fora da
   * ordem otimizada (o motorista conhece o caminho). É sugestão — vem marcada
   * e o operador desmarca o que não sai hoje.
   */
  const pendentesPorLugar = useMemo(
    () =>
      pendentes.map((p) => ({
        id: p.id,
        municipio: municipioDoPedido(p, clientes[p.clienteId]),
        cdId: p.cdId,
      })),
    [pendentes, clientes],
  );
  const excecoesSugeridas = useMemo(() => {
    const marcados = prontos.filter((p) => selecionados.has(p.id));
    const ids = new Set(
      excecoesDaSelecao(
        marcados.map((p) => ({ municipio: municipioDoPedido(p, clientes[p.clienteId]), cdId: p.cdId })),
        pendentesPorLugar,
      ),
    );
    return pendentes.filter((p) => ids.has(p.id));
  }, [prontos, pendentes, pendentesPorLugar, selecionados, clientes]);
  /** Cidades da seleção atual, para o resumo acima da lista — uma vez cada,
   * com ou sem acento (mesma chave do agrupamento). */
  const cidadesSelecionadas = useMemo(() => {
    const porChave = new Map<string, string>();
    for (const p of prontos) {
      if (!selecionados.has(p.id)) continue;
      const nome = (municipioDoPedido(p, clientes[p.clienteId]) ?? '—').trim().toUpperCase();
      const chave = normalizar(nome);
      if (!porChave.has(chave)) porChave.set(chave, nome);
    }
    return [...porChave.values()];
  }, [prontos, selecionados, clientes]);
  const excecoesEscolhidas = excecoesSugeridas.filter((p) => !excecoesDesmarcadas.has(p.id));

  /** Rotas de dias anteriores ainda com parada sem baixa — prendem pedidos. */
  const rotasAtrasadas = rotasSemBaixa(rotas, diaEmAlagoas());

  /**
   * Onde os motoristas estão agora. Busca de tempos em tempos enquanto houver
   * rota em execução — e SÓ enquanto houver: sem rota na rua não há o que
   * perguntar, e bater na API à toa é acordar instância no Render por nada.
   */
  const [posicoes, setPosicoes] = useState<Record<string, PosicaoMotorista>>({});
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  /**
   * Última vez que o painel CONSEGUIU falar com a API. Sem isto, API fora do ar
   * e motorista sem sinal produzem o MESMO sintoma na tela — tudo parado com
   * "há 25 min" —, e o operador conclui a causa errada: ligaria para o
   * motorista quando o problema é o servidor.
   */
  const [contatoEm, setContatoEm] = useState<number | null>(null);
  /**
   * Enquanto houver rota ABERTA (publicada ou em execução), o painel se
   * atualiza sozinho. Antes ele só ligava com rota JÁ em execução — quem
   * abrisse a tela de manhã, antes de o motorista começar, ficava com o
   * progresso congelado em "0/12" e sem rastreio, e nada dizia que era preciso
   * clicar em Atualizar.
   *
   * Funde o que muda em cima do que já está na tela, em vez de recarregar
   * tudo: o traçado da rota é o campo pesado, não muda nunca, e recarregá-lo a
   * cada 20 s desmontaria o mapa que o operador está olhando.
   */
  const temRotaAberta = rotas.some(
    (r) => r.status === 'publicada' || r.status === 'em_execucao',
  );
  useEffect(() => {
    if (!temRotaAberta) return;
    let vivo = true;
    const buscar = () => {
      const saiuEm = Date.now();
      obterAcompanhamento()
        .then((a) => {
          if (!vivo) return;
          setContatoEm(Date.now());
          setPosicoes(a.posicoes);
          if (saiuEm < baixaGravadaEm.current) return;
          const porId = new Map(a.rotas.map((r) => [r.id, r]));
          setRotas((atuais) =>
            atuais.map((rota) => {
              const novo = porId.get(rota.id);
              if (!novo) return rota;
              const statusPorPedido = new Map(novo.paradas.map((p) => [p.pedidoId, p]));
              return {
                ...rota,
                status: novo.status,
                concluidaEm: novo.concluidaEm,
                paradas: rota.paradas.map((p) => {
                  const atualizada = statusPorPedido.get(p.pedidoId);
                  return atualizada
                    ? {
                        ...p,
                        status: atualizada.status,
                        avisadoEm: atualizada.avisadoEm,
                        chegouEm: atualizada.chegouEm,
                      }
                    : p;
                }),
                excecoes: rota.excecoes?.map((e) => {
                  const atualizada = novo.excecoes?.find((x) => x.pedidoId === e.pedidoId);
                  return atualizada ? { ...e, status: atualizada.status } : e;
                }),
              };
            }),
          );
        })
        .catch(() => undefined);
      // O relógio anda junto: "há 3 min" precisa envelhecer na tela mesmo sem
      // posição nova chegando — é assim que dá para perceber que parou de vir.
      if (vivo) setAgoraMs(Date.now());
    };
    buscar();
    const timer = setInterval(buscar, 20_000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [temRotaAberta]);

  /** Sugestão de regiões (null = ainda não pedida nesta sessão da tela). */
  const [grupos, setGrupos] = useState<GrupoSugerido[] | null>(null);
  const [carregandoGrupos, setCarregandoGrupos] = useState(false);
  const [erroGrupos, setErroGrupos] = useState<string | null>(null);
  /** A sugestão é de quando foi pedida: cidade que saiu inteira numa rota some
   * dela, e quando somem todas a tela precisa dizer isso, não ficar em branco. */
  const algumaCidadeAberta =
    grupos?.some((g) => estadoDoGrupo(g.ids, idsProntos, selecionados).vivos.length > 0) ?? false;

  async function sugerirGrupos() {
    setCarregandoGrupos(true);
    setErroGrupos(null);
    try {
      // Passa o CD quando já se sabe qual é: assim a sugestão sai ordenada pela
      // distância dele e não mistura pedidos do outro galpão — que a montagem
      // barraria depois, e sugerir seria oferecer o erro.
      const r = await agruparPorRegiao(cdId || undefined);
      setGrupos(r.grupos);
    } catch (e) {
      setErroGrupos(e instanceof Error ? e.message : 'Falha ao agrupar');
    } finally {
      setCarregandoGrupos(false);
    }
  }

  const todosProntosMarcados = prontos.length > 0 && prontos.every((p) => selecionados.has(p.id));
  const algumProntoMarcado = prontos.some((p) => selecionados.has(p.id));

  // CD que os pedidos selecionados dizem ser a origem (seção 8.5) — vem do
  // CNPJ do emitente da nota. Vazio quando não há consenso ou não se sabe.
  const cdsSelecionados = useMemo(
    () => [
      ...new Set(
        prontos.filter((p) => selecionados.has(p.id)).map((p) => p.cdId ?? null).filter(Boolean),
      ),
    ],
    [prontos, selecionados],
  );
  const cdDasNotas = cdsSelecionados.length === 1 ? cdsSelecionados[0]! : null;
  const misturaCds = cdsSelecionados.length > 1;

  // Pré-seleciona o CD das notas: o operador não precisa saber de cabeça de
  // qual galpão sai cada pedido. Continua podendo trocar — a nota diz quem
  // FATUROU, e nem sempre é de onde a mercadoria fisicamente sai.
  useEffect(() => {
    if (cdDasNotas && cdDasNotas !== cdId) {
      setCdId(cdDasNotas);
      setPrevia(null);
    }
    // Mudou a seleção de pedidos: a troca manual anterior era sobre OUTRAS
    // notas, e manter o seletor aberto sugeriria uma decisão que não é mais a
    // mesma.
    setTrocandoCd(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdDasNotas]);

  // Poda a seleção quando a lista de prontos muda (Atualizar/publicar): um id que
  // deixou de estar pronto não pode seguir selecionado e ir para a otimização.
  useEffect(() => {
    setSelecionados((sel) => {
      const validos = new Set(prontos.map((p) => p.id));
      const podado = new Set([...sel].filter((id) => validos.has(id)));
      return podado.size === sel.size ? sel : podado;
    });
  }, [prontos]);

  /**
   * A PRÉVIA também envelhece, e era a única coisa que ninguém podava. Ela
   * carrega os pedidoIds usados na otimização; se algum deixou de estar
   * disponível (foi apagado, entrou em outra rota, ou a rota foi desfeita e
   * remontada), continuar mostrando uma rota que não existe mais é pior do que
   * mostrar nada — e o botão Publicar mandaria os ids velhos.
   */
  useEffect(() => {
    if (!previa) return;
    const validos = new Set(prontos.map((p) => p.id));
    const sumiram = previa.paradas.filter((p) => !validos.has(p.pedidoId));
    if (sumiram.length === 0) return;
    setPrevia(null);
    setAviso({
      onde: 'montagem',
      texto:
        `A prévia foi descartada: ${sumiram.length} pedido(s) dela não estão mais disponíveis ` +
        '(apagados ou já em outra rota). Selecione de novo e otimize.',
    });
  }, [prontos, previa]);

  /**
   * A prévia é DESTA seleção, ou não é prévia. As paradas publicadas saem da
   * prévia e as exceções saem da seleção: otimizar uma cidade, clicar no grupo
   * de outra e publicar levava as paradas da primeira com as exceções da
   * segunda — dezenas de pedidos rurais de outro lugar, reservados. Cada
   * caminho que muda a seleção já descarta a prévia; isto é a rede para o
   * próximo que esquecer.
   */
  useEffect(() => {
    if (!previa) return;
    const ids = previa.paradas.map((p) => p.pedidoId);
    if (ids.length !== selecionados.size || ids.some((id) => !selecionados.has(id))) {
      setPrevia(null);
    }
  }, [selecionados, previa]);

  function alternar(id: string) {
    const proximo = new Set(selecionados);
    if (proximo.has(id)) proximo.delete(id);
    else proximo.add(id);
    setSelecionados(proximo);
    setPrevia(null);
  }

  function alternarCidade(ids: string[]) {
    setSelecionados(alternarGrupo(ids, idsProntos, selecionados));
    setPrevia(null);
  }

  // Marca/desmarca todos os pedidos prontos de uma vez.
  function alternarTodos() {
    setSelecionados(todosProntosMarcados ? new Set() : new Set(prontos.map((p) => p.id)));
    setPrevia(null);
  }

  async function otimizar() {
    setOtimizando(true);
    setErro(null);
    setPublicada(null);
    try {
      setPrevia(await previaDeRota({ pedidoIds: [...selecionados], cdId, retornaAoCd }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na otimização');
    } finally {
      setOtimizando(false);
    }
  }

  // RF-12: o operador ajusta a ordem; o traçado é recalculado com a sequência fixa.
  async function mover(indice: number, delta: number) {
    if (!previa) return;
    const ids = previa.paradas.map((p) => p.pedidoId);
    const destino = indice + delta;
    if (destino < 0 || destino >= ids.length) return;
    [ids[indice], ids[destino]] = [ids[destino]!, ids[indice]!];
    setOtimizando(true);
    setErro(null);
    try {
      setPrevia(await previaDeRota({ pedidoIds: ids, cdId, retornaAoCd, ordemManual: true }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao reordenar');
    } finally {
      setOtimizando(false);
    }
  }

  async function desfazerRota(r: { id: string } & Rota) {
    // As exceções também voltam: contar só as paradas escondia a maior parte
    // dos pedidos de uma rota rural.
    const total = r.paradas.length + (r.excecoes?.length ?? 0);
    if (
      !window.confirm(
        `Desfazer a rota ${r.id}?\n\n` +
          `Os ${total} pedidos dela somem do app do motorista e voltam a ficar ` +
          'disponíveis para montar outra rota. Nada do que já foi entregue é afetado.',
      )
    ) {
      return;
    }
    setErro(null);
    setAviso(null);
    try {
      await apagarRota(r.id);
      // Dizer PARA ONDE os pedidos foram. Sem isto, eles reaparecem sozinhos na
      // lista de Montagem e parece que a rota "não foi apagada de verdade" —
      // quando é o contrário: apagar a rota é justamente devolvê-los.
      setAviso({
        onde: 'acompanhamento',
        texto:
          `Rota ${r.id} desfeita. Os ${total} pedido(s) dela voltaram para a lista de ` +
          'Montagem de rota, disponíveis para montar outra.',
      });
      carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao desfazer a rota');
    }
  }

  /**
   * Apagar o pedido SEM sair da montagem. Ele já podia ser apagado na aba
   * Pedidos, mas quem está montando a rota está olhando ESTA lista — mandar o
   * operador procurar a nota noutra aba para tirá-la daqui é fazer o trabalho
   * duas vezes.
   */
  async function apagarDaMontagem(p: { id: string } & Pedido) {
    const nome = clientes[p.clienteId]?.nome ?? '';
    if (
      !window.confirm(
        `Apagar a nota ${p.numeroNota}/${p.serie}${nome ? ` — ${nome}` : ''}?\n\n` +
          'A importação dela é desfeita e ela sai da montagem. Para trazê-la de volta, ' +
          'reimporte o XML.',
      )
    ) {
      return;
    }
    setErro(null);
    setAviso(null);
    try {
      await apagarPedido(p.id);
      carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao apagar');
    }
  }

  /** Limpar a montagem de uma vez — dez notas erradas não se apagam uma a uma. */
  async function apagarSelecionados() {
    const alvos = prontos.filter((p) => selecionados.has(p.id));
    if (alvos.length === 0) return;
    if (
      !window.confirm(
        `Apagar ${alvos.length} pedido(s) selecionado(s)?\n\n` +
          'A importação deles é desfeita e eles saem da montagem. Para trazê-los de volta, ' +
          'reimporte os XMLs.',
      )
    ) {
      return;
    }
    setErro(null);
    setAviso(null);
    setApagandoLote(true);
    // Em série: a API do plano free responde melhor a uma fila do que a dez
    // requisições ao mesmo tempo, e o parcial importa — o que apagou, apagou.
    const falhas: string[] = [];
    for (const p of alvos) {
      try {
        await apagarPedido(p.id);
      } catch {
        falhas.push(`${p.numeroNota}/${p.serie}`);
      }
    }
    setApagandoLote(false);
    setSelecionados(new Set());
    if (falhas.length > 0) {
      setErro(`Não deu para apagar ${falhas.length}: ${falhas.join(', ')}. Tente de novo.`);
    } else {
      setAviso({ onde: 'montagem', texto: `${alvos.length} pedido(s) apagado(s) da montagem.` });
    }
    carregar();
  }

  function alternarExcecao(id: string) {
    setExcecoesDesmarcadas((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });
  }

  /** O PDF sai sempre de uma rota PUBLICADA: é a publicação que reserva os
   * pedidos. Baixar de novo depois da baixa parcial mostra o que já foi feito. */
  async function baixarPdf(r: { id: string } & Rota) {
    setGerandoPdf(r.id);
    setErroBaixa(null);
    try {
      await baixarPdfRoteiro(
        montarRoteiro(r.id, r, {
          motorista: nomeDoUsuario(r.motoristaId),
          clientes,
          geradoEm: new Date(),
        }),
      );
    } catch (e) {
      setErroBaixa(e instanceof Error ? `Falha ao gerar o PDF: ${e.message}` : 'Falha ao gerar o PDF');
    } finally {
      setGerandoPdf(null);
    }
  }

  function marcarBaixa(pedidoId: string, resultado: ResultadoBaixa) {
    setMarcasBaixa((atual) => {
      const proximo = { ...atual };
      // Tocar de novo na mesma opção desmarca: errar o toque não pode obrigar
      // a registrar o erro.
      if (proximo[pedidoId] === resultado) delete proximo[pedidoId];
      else proximo[pedidoId] = resultado;
      return proximo;
    });
  }

  /** O caso comum na volta do motorista: quase tudo entregue. Marca o resto
   * como entregue — o operador ainda revisa antes de registrar. */
  function marcarRestantesComoEntregues(r: Rota) {
    setMarcasBaixa((atual) => {
      const proximo = { ...atual };
      for (const p of [...r.paradas, ...(r.excecoes ?? [])]) {
        if (p.status === 'em_rota' && !proximo[p.pedidoId]) proximo[p.pedidoId] = 'entregue';
      }
      return proximo;
    });
  }

  async function registrarBaixa(r: { id: string } & Rota) {
    const baixas = Object.entries(marcasBaixa).map(([pedidoId, resultado]) => ({ pedidoId, resultado }));
    if (baixas.length === 0) return;
    const naoEntregues = baixas.filter((b) => b.resultado === 'nao_entregue').length;
    if (
      !window.confirm(
        `Registrar a baixa de ${baixas.length} parada(s) da rota ${r.id}?\n\n` +
          `${baixas.length - naoEntregues} entregue(s) · ${naoEntregues} não entregue(s).\n\n` +
          'O que não foi entregue volta para a Montagem de rota, marcado como "voltou da rota". ' +
          'A baixa registrada não se desfaz.',
      )
    ) {
      return;
    }
    setBaixando(true);
    setErroBaixa(null);
    try {
      const resultado = await darBaixa(r.id, baixas);
      baixaGravadaEm.current = Date.now();
      setRotas((atuais) => atuais.map((x) => (x.id === r.id ? { ...resultado.rota, id: r.id } : x)));
      setMarcasBaixa({});
      setAviso({
        onde: 'acompanhamento',
        texto:
          `Baixa registrada na rota ${r.id}: ${resultado.entregues.length} entregue(s)` +
          (resultado.devolvidos.length > 0
            ? `, ${resultado.devolvidos.length} não entregue(s) — voltaram para a Montagem de rota.`
            : '.'),
      });
      // Os devolvidos reaparecem na montagem: recarregar a lista de pedidos.
      carregar();
    } catch (e) {
      setErroBaixa(e instanceof Error ? e.message : 'Falha ao registrar a baixa');
    } finally {
      setBaixando(false);
    }
  }

  async function publicar(comPdf: boolean) {
    if (!previa || !motoristaId) return;

    /**
     * O motorista já tem rota aberta? O app dele mostra UMA rota. Se a atual
     * ainda não foi iniciada, a nova toma a tela e a anterior fica invisível
     * com os pedidos presos em `em_rota`. Se ele já começou, é o contrário: a
     * nova é que espera. Nos dois casos alguém precisa saber ANTES.
     */
    const abertas = rotas.filter(
      (r) => r.motoristaId === motoristaId && r.status !== 'concluida' && r.status !== 'rascunho',
    );
    if (abertas.length > 0) {
      const iniciada = abertas.some((r) => r.status === 'em_execucao');
      const paradasAbertas = abertas.reduce(
        (n, r) => n + r.paradas.filter((p) => p.status === 'em_rota').length,
        0,
      );
      const consequencia = iniciada
        ? 'Como ele JÁ COMEÇOU aquela rota, o app continua mostrando a atual — esta nova só aparece quando a primeira for concluída.'
        : 'Como ele ainda NÃO COMEÇOU aquela rota, o app vai passar a mostrar esta nova, e a anterior some da tela dele (os pedidos seguem reservados nela).';
      const texto =
        `${nomeDoUsuario(motoristaId)} já tem ${abertas.length} rota(s) em aberto, ` +
        `com ${paradasAbertas} parada(s) por entregar.\n\n${consequencia}\n\nPublicar assim mesmo?`;
      if (!window.confirm(texto)) return;
    }

    /**
     * Exceção não aparece no mapa nem na ordem, e a sugestão vem marcada: numa
     * cidade sem localização feita, um clique no grupo traz dezenas delas
     * (medido no ciclo 11: Teotônio Vilela com 2 pedidos com ponto e 151 sem).
     * Publicar reserva todas. O número tem de ser dito antes, não descoberto
     * no dia seguinte, quando a montagem estiver vazia.
     */
    if (excecoesEscolhidas.length > 0) {
      const total = previa.paradas.length + excecoesEscolhidas.length;
      if (
        !window.confirm(
          `Esta rota leva ${previa.paradas.length} parada(s) na ordem e ${excecoesEscolhidas.length} ` +
            `exceção(ões) sem ponto no mapa.\n\nOs ${total} pedidos ficam reservados nesta rota até a ` +
            'baixa. Publicar?',
        )
      ) {
        return;
      }
    }

    setPublicando(true);
    setErro(null);
    try {
      const resultado = await publicarRota({
        pedidoIds: previa.paradas.map((p) => p.pedidoId),
        excecaoIds: excecoesEscolhidas.map((p) => p.id),
        cdId,
        retornaAoCd,
        motoristaId,
      });
      setPublicada(resultado.rotaId);
      setPrevia(null);
      setSelecionados(new Set());
      setExcecoesDesmarcadas(new Set());
      carregar();
      if (comPdf) {
        try {
          await baixarPdfRoteiro(
            montarRoteiro(resultado.rotaId, resultado.rota, {
              motorista: nomeDoUsuario(motoristaId),
              clientes,
              geradoEm: new Date(),
            }),
          );
        } catch {
          // A rota já existe e os pedidos já estão reservados — o que falhou foi
          // só o arquivo. Dizer isso evita que o operador publique de novo.
          setErro(
            'A rota foi publicada e os pedidos estão reservados, mas o PDF falhou — baixe-o pelo Acompanhamento do dia (abra a rota).',
          );
        }
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na publicação');
    } finally {
      setPublicando(false);
    }
  }

  return (
    <>
      <section className="cartao">
        <div className="cabecalho-secao">
          <h2>Acompanhamento do dia</h2>
          <button onClick={carregar}>Atualizar</button>
        </div>
        {aviso?.onde === 'acompanhamento' && <div className="alerta">{aviso.texto}</div>}
        {/* Rota em papel não fecha sozinha: sem a baixa, os pedidos dela ficam
            reservados para sempre e nunca voltam para a montagem. */}
        {rotasAtrasadas.length > 0 && (
          <div className="alerta">
            ⚠{' '}
            {rotasAtrasadas.length === 1
              ? 'Uma rota de dia anterior está'
              : `${rotasAtrasadas.length} rotas de dias anteriores estão`}{' '}
            sem baixa:{' '}
            {rotasAtrasadas.map((r) => `${formatarDia(r.data)} (${paradasEmAberto(r)} em aberto)`).join(', ')}.
            Os pedidos delas seguem reservados até você abrir a rota e registrar o que foi entregue.
          </div>
        )}
        {/* API fora do ar e motorista sem sinal davam o MESMO sintoma: tudo
            parado. Dizer qual é evita ligar para a pessoa errada. */}
        {temRotaAberta && contatoEm !== null && agoraMs - contatoEm > 90_000 && (
          <div className="alerta">
            ⚠ Sem contato com o servidor {haQuantoTempo(new Date(contatoEm).toISOString(), agoraMs)}
            {' '}— o que está na tela pode estar desatualizado. Não é sinal do motorista.
          </div>
        )}
        {rotas.length === 0 && <div className="vazio">Nenhuma rota publicada ainda.</div>}
        {rotas.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rota</th>
                <th>Motorista</th>
                <th>Partida</th>
                <th>Progresso</th>
                <th>Onde está</th>
                <th>Avisados</th>
                <th>Insucessos</th>
                <th>km</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rotas.map((r) => {
                // Exceções contam no progresso: também são entregas desta rota.
                const todas = [...r.paradas, ...(r.excecoes ?? [])];
                const entregues = todas.filter((p) => p.status === 'entregue').length;
                const insucessos = todas.filter((p) => p.status === 'insucesso').length;
                const avisados = r.paradas.filter((p) => p.avisadoEm).length;
                const s = ROTULO_ROTA[r.status] ?? { texto: r.status, classe: '' };
                const aberta = rotaAberta === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setRotaAberta(aberta ? null : r.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="mono">{r.id}</td>
                      <td>{nomeDoUsuario(r.motoristaId)}</td>
                      <td>{r.origemNome}</td>
                      <td className="mono">
                        {entregues + insucessos}/{todas.length} {aberta ? '▲' : '▾'}
                      </td>
                      <td>
                        <PosicaoDoMotorista
                          posicao={posicoes[r.id] ?? null}
                          rota={r}
                          agoraMs={agoraMs}
                        />
                      </td>
                      <td className="mono">
                        {avisados}/{r.paradas.length}
                      </td>
                      <td className="mono">{insucessos || '—'}</td>
                      <td className="mono">{r.distanciaTotalKm}</td>
                      <td>
                        <span className={`chip ${s.classe}`}>{s.texto}</span>
                      </td>
                      <td>
                        {/* Desfazer a publicação. Só faz sentido enquanto nada
                            foi executado — depois disso é histórico, e a API
                            recusa (o botão nem aparece). */}
                        {entregues + insucessos === 0 && (
                          <button
                            className="apagar"
                            title="Desfazer esta rota"
                            aria-label={`Desfazer a rota ${r.id}`}
                            onClick={(evento) => {
                              evento.stopPropagation();
                              void desfazerRota(r);
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                    {aberta && (
                      <tr>
                        <td colSpan={10}>
                          {/* O mapa vem ANTES da lista: quando o cliente liga
                              perguntando, a pergunta é espacial — "o caminhão já
                              passou pela minha rua?" —, e texto obriga quem lê a
                              montar a geografia de cabeça. */}
                          {/* O mapa é o pedaço mais frágil da tela: depende de
                              WebGL, de doc do banco e de biblioteca de terceiro.
                              Isolado, ele falha sozinho — a lista de paradas
                              abaixo continua respondendo quem ligou. */}
                          <LimiteDeErro oQue="O mapa do acompanhamento">
                            <MapaAcompanhamento
                              rota={r}
                              posicao={posicoes[r.id] ?? null}
                              agoraMs={agoraMs}
                            />
                          </LimiteDeErro>
                          <div className="barra-rota">
                            <button disabled={gerandoPdf === r.id} onClick={() => void baixarPdf(r)}>
                              {gerandoPdf === r.id ? 'GERANDO…' : '📄 Baixar PDF'}
                            </button>
                            {/* Pelo que falta, não pelo status: rota fechada no
                                app com parada por entregar também precisa. */}
                            {paradasEmAberto(r) > 0 && (
                              <button disabled={baixando} onClick={() => marcarRestantesComoEntregues(r)}>
                                Marcar as que faltam como entregues
                              </button>
                            )}
                          </div>
                          {/* Parada a parada com o aviso ao cliente: diante de um
                              "ausente", saber se ele tinha sido avisado é o que
                              separa aprendizado de reclamação (seção 11.8). */}
                          <table className="paradas-rota">
                            <tbody>
                              {r.paradas.map((p, i) => {
                                const e = entregasDaRota[p.pedidoId];
                                // Onde ele estava ao confirmar, contra o pin do
                                // cliente. "Ausente" registrado a 3 km da porta
                                // conta uma história diferente de "ausente" no
                                // portão — e é a única forma de saber.
                                const distancia =
                                  e?.posicaoConfirmacao
                                    ? Math.round(distanciaEmMetros(e.posicaoConfirmacao, p.coordenada))
                                    : null;
                                return (
                                  <Fragment key={p.pedidoId}>
                                    <tr>
                                      <td className="mono">{String(i + 1).padStart(2, '0')}</td>
                                      <td>{p.nome}</td>
                                      <td>
                                        <ChipParada status={p.status} painel={Boolean(p.baixaNoPainel)} />
                                      </td>
                                      <td className="mono">
                                        {p.avisadoEm ? `avisado ${horaDe(p.avisadoEm)}` : 'não avisado'}
                                      </td>
                                      <td>
                                        {p.status === 'em_rota' && (
                                          <OpcoesBaixa
                                            marcado={marcasBaixa[p.pedidoId]}
                                            desabilitado={baixando}
                                            onMarcar={(res) => marcarBaixa(p.pedidoId, res)}
                                          />
                                        )}
                                      </td>
                                    </tr>
                                    {/* O detalhe da confirmação: o "por quê" que
                                        o Admin Estoque precisa para ligar ao
                                        cliente, e que a parada não guarda. */}
                                    {e && (
                                      <tr className="confirmacao">
                                        <td />
                                        <td colSpan={4}>
                                          <strong>{ROTULO_RESULTADO[e.resultado] ?? e.resultado}</strong>{' '}
                                          às {horaDe(e.confirmadaEm)}
                                          {/* Quem recebeu é o que responde um
                                              "não recebi" semanas depois — e a
                                              distância é o que mostra que o
                                              motorista estava na porta. */}
                                          {e.recebidoPor && (
                                            <>
                                              {' '}
                                              · recebido por <strong>{e.recebidoPor}</strong>
                                            </>
                                          )}
                                          {distancia != null
                                            ? ` · confirmado a ${distancia} m do ponto do cliente`
                                            : ' · sem posição (GPS indisponível na hora)'}
                                          {p.reciboEnviadoEm &&
                                            ` · recibo enviado ${horaDe(p.reciboEnviadoEm)}`}
                                          {e.comprovantePath && (
                                            <div className="dossie-bloco" style={{ marginTop: 8 }}>
                                              <FotoReferencia
                                                caminho={e.comprovantePath}
                                                alt={`Comprovante da entrega de ${p.nome}`}
                                              />
                                            </div>
                                          )}
                                        </td>
                                      </tr>
                                    )}
                                    {!e && carregandoEntregas && (
                                      <tr className="confirmacao">
                                        <td />
                                        <td colSpan={4}>carregando confirmação…</td>
                                      </tr>
                                    )}
                                    {/* O dossiê do local: foto e observação que
                                        o motorista deixou no doc do CLIENTE.
                                        Vale para esta rota e para as próximas
                                        até o mesmo endereço. */}
                                    {(clientes[p.clienteId]?.fotoReferenciaPath ||
                                      clientes[p.clienteId]?.observacoes) && (
                                      <tr className="dossie-linha">
                                        <td />
                                        <td colSpan={4}>
                                          <div className="dossie-bloco">
                                            {clientes[p.clienteId]!.fotoReferenciaPath && (
                                              <FotoReferencia
                                                caminho={clientes[p.clienteId]!.fotoReferenciaPath!}
                                                alt={`Referência do local de ${p.nome}`}
                                              />
                                            )}
                                            {clientes[p.clienteId]!.observacoes && (
                                              <div className="dossie-obs-admin">
                                                📌 {clientes[p.clienteId]!.observacoes}
                                              </div>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                              {/* Exceções: sem ponto no mapa, fora da ordem. Mesma
                                  baixa das paradas — também saíram no caminhão. */}
                              {(r.excecoes ?? []).map((e, i) => (
                                <tr key={e.pedidoId}>
                                  <td className="mono">E{i + 1}</td>
                                  <td>
                                    {e.nome}
                                    <div className="excecao-endereco">{e.endereco} · sem ponto no mapa</div>
                                  </td>
                                  <td>
                                    <ChipParada status={e.status} painel={Boolean(e.baixaNoPainel)} />
                                  </td>
                                  <td className="mono">—</td>
                                  <td>
                                    {e.status === 'em_rota' && (
                                      <OpcoesBaixa
                                        marcado={marcasBaixa[e.pedidoId]}
                                        desabilitado={baixando}
                                        onMarcar={(res) => marcarBaixa(e.pedidoId, res)}
                                      />
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {Object.keys(marcasBaixa).length > 0 && (
                            <div className="barra-rota">
                              <button className="primaria" disabled={baixando} onClick={() => void registrarBaixa(r)}>
                                {baixando ? 'REGISTRANDO…' : `REGISTRAR BAIXA (${Object.keys(marcasBaixa).length})`}
                              </button>
                              <button disabled={baixando} onClick={() => setMarcasBaixa({})}>
                                Limpar marcas
                              </button>
                            </div>
                          )}
                          {erroBaixa && <div className="erro">{erroBaixa}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="cartao">
        <h2>Montagem de rota</h2>

        <div className="config-rota">
          {/* Nada selecionado: não há o que configurar nem de onde deduzir o
              CD. Mostrar a escolha aqui é pedir uma decisão que não serve para
              nada ainda — o operador escolhe os pedidos primeiro.
              Com seleção, o CD sai das notas (CNPJ do emitente) e não há
              decisão a tomar. O seletor só aparece quando o app NÃO SABE
              (nenhuma nota reconhecida) ou quando o operador pede para trocar —
              o dado real mostra que a filial que fatura nem sempre é o galpão
              de onde o caminhão sai. */}
          {selecionados.size === 0 ? (
            <div className="cd-definido-fonte">
              Selecione os pedidos abaixo — o CD de partida vem das notas.
            </div>
          ) : cdDasNotas && !trocandoCd ? (
            <div className="cd-definido">
              <div>
                Partida: <strong>{cds[cdDasNotas]?.nome ?? cdDasNotas}</strong>
              </div>
              <div className="cd-definido-fonte">definido pelas notas selecionadas</div>
              <button type="button" onClick={() => setTrocandoCd(true)}>
                trocar
              </button>
            </div>
          ) : (
            <fieldset>
              <legend>CD de partida{cdsSelecionados.length === 0 ? ' (nota não reconhecida)' : ''}</legend>
              {Object.entries(cds).map(([id, cd]) => (
                <label key={id} className="opcao">
                  <input
                    type="radio"
                    name="cd"
                    checked={cdId === id}
                    onChange={() => {
                      setCdId(id);
                      setPrevia(null);
                    }}
                  />
                  {cd.nome}
                </label>
              ))}
            </fieldset>
          )}
          <label className="opcao">
            <input
              type="checkbox"
              checked={retornaAoCd}
              onChange={(e) => {
                setRetornaAoCd(e.target.checked);
                setPrevia(null);
              }}
            />
            Retornar ao CD ao fim da rota
          </label>
        </div>

        {prontos.length === 0 && (
          <div className="vazio">
            Nenhum pedido pronto para rota — importe notas ou resolva os mapeamentos pendentes.
          </div>
        )}

        {/* Agrupamento geográfico: o passo ANTES de otimizar a ordem. O OSRM
            responde "em que ordem visitar estes N"; escolher QUAIS são os N no
            olho só funciona com meia dúzia de pedidos. Não decide nada — cada
            cidade é um clique que entra ou sai da seleção, e quantas cabem num
            dia é o operador quem sabe. */}
        {prontos.length > 0 && (
          <div className="agrupamento">
            <div className="cabecalho-secao">
              <strong>Cidades</strong>
              <button disabled={carregandoGrupos} onClick={() => void sugerirGrupos()}>
                {carregandoGrupos ? 'agrupando…' : '🗺 agrupar por cidade'}
              </button>
            </div>
            {erroGrupos && <div className="erro">{erroGrupos}</div>}
            {grupos !== null && grupos.length === 0 && (
              <div className="vazio">Nada a agrupar com os pedidos prontos de agora.</div>
            )}
            {grupos !== null && grupos.length > 0 && !algumaCidadeAberta && (
              <div className="vazio">
                As cidades sugeridas já saíram em rota. Clique em agrupar de novo para ver o que
                ficou pronto depois.
              </div>
            )}
            {grupos !== null && algumaCidadeAberta && (
              <>
                <p style={{ color: 'var(--texto-2)', margin: '4px 0 8px' }}>
                  Da mais distante para a mais perto do CD. Clique para pôr a cidade na rota ou
                  tirar — dá para juntar quantas couberem no dia. A ordem das paradas sai da
                  otimização.
                </p>
                <div className="grupos">
                  {grupos.map((g) => {
                    const { vivos, marcado } = estadoDoGrupo(g.ids, idsProntos, selecionados);
                    // Cidade que já saiu inteira numa rota publicada some da sugestão.
                    if (vivos.length === 0) return null;
                    const semPonto = excecoesDaSelecao(
                      [{ municipio: g.municipio, cdId: cdId || null }],
                      pendentesPorLugar,
                    ).length;
                    const nome = g.parte ? `${g.municipio} (${g.parte.indice}/${g.parte.total})` : g.municipio;
                    return (
                      <button
                        key={`${g.municipio}-${g.parte?.indice ?? 0}`}
                        className="grupo"
                        aria-pressed={marcado}
                        onClick={() => alternarCidade(g.ids)}
                        title={marcado === true ? `Tirar ${nome} da rota` : `Pôr ${nome} na rota`}
                      >
                        <strong>
                          {marcado === true ? '✓ ' : ''}
                          {nome}
                        </strong>
                        <div className="grupo-numeros">
                          {vivos.length} parada(s)
                          {/* Cidade dividida: as exceções são da cidade, não do
                              pedaço — sem o "na cidade", duas partes com "+ 17"
                              pareceriam 34. */}
                          {semPonto > 0 && ` + ${semPonto} sem ponto${g.parte ? ' na cidade' : ''}`}
                          {g.distanciaDoCdKm != null && ` · ${g.distanciaDoCdKm} km do CD`}
                          {` · ${g.extensaoKm} km de ponta a ponta`}
                        </div>
                        {g.parte && (
                          <div className="grupo-numeros">
                            cidade grande para um dia — dividida em {g.parte.total}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {selecionados.size > 0 && (
                  <div className="selecao-cidades">
                    <span>
                      Na rota: <strong>{cidadesSelecionadas.join(' + ')}</strong> ·{' '}
                      {selecionados.size} parada(s)
                    </span>
                    <button
                      onClick={() => {
                        setSelecionados(new Set());
                        setPrevia(null);
                      }}
                    >
                      Limpar seleção
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {prontos.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos os pedidos"
                    checked={todosProntosMarcados}
                    ref={(el) => {
                      if (el) el.indeterminate = algumProntoMarcado && !todosProntosMarcados;
                    }}
                    onChange={alternarTodos}
                  />
                </th>
                <th>Nota</th>
                <th>CD</th>
                <th>Cliente</th>
                {/* Com várias cidades marcadas, é a coluna que diz de qual
                    cidade é cada pedido — a montagem é pensada por cidade. */}
                <th>Cidade</th>
                <th>Vol · Peso</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {prontos.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar nota ${p.numeroNota}`}
                      checked={selecionados.has(p.id)}
                      onChange={() => alternar(p.id)}
                    />
                  </td>
                  <td className="mono">
                    {p.numeroNota}/{p.serie}
                  </td>
                  <td>{p.cdId ? (cds[p.cdId]?.nome ?? p.cdId) : '—'}</td>
                  <td>
                    {clientes[p.clienteId]?.nome ?? `${p.clienteId.slice(0, 8)}…`}
                    {clientes[p.clienteId]?.statusMapeamento === 'aproximado' && (
                      <span className="chip pendente" style={{ marginLeft: 8 }}>
                        aprox · a mapear
                      </span>
                    )}
                    {p.voltouDeRota && (
                      <span
                        className="chip"
                        style={{ marginLeft: 8 }}
                        title={`Saiu na rota ${p.voltouDeRota.rotaId} e voltou sem ser entregue`}
                      >
                        voltou da rota de {formatarDia(p.voltouDeRota.data)}
                      </span>
                    )}
                  </td>
                  <td>{municipioDoPedido(p, clientes[p.clienteId]) ?? '—'}</td>
                  <td>
                    {formatarCarga(p.volumes, p.pesoBrutoKg)}
                  </td>
                  <td>
                    <button
                      className="apagar"
                      title={`Apagar a nota ${p.numeroNota}`}
                      aria-label={`Apagar a nota ${p.numeroNota}`}
                      disabled={apagandoLote}
                      onClick={() => void apagarDaMontagem(p)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Apagar em lote: quem selecionou dez notas erradas não vai apagar uma
            a uma. Só aparece com seleção, para não ficar um botão destrutivo
            parado na tela ao lado de "Otimizar". */}
        {algumProntoMarcado && (
          <button
            className="apagar-lote"
            disabled={apagandoLote}
            onClick={() => void apagarSelecionados()}
          >
            {apagandoLote
              ? 'APAGANDO…'
              : `✕ Apagar ${selecionados.size} pedido(s) selecionado(s)`}
          </button>
        )}

        {excecoesSugeridas.length > 0 && (
          <div className="excecoes-sugeridas">
            <div className="cabecalho-secao">
              <strong>
                Sem ponto no mapa nas mesmas cidades — {excecoesEscolhidas.length} de{' '}
                {excecoesSugeridas.length} vão como exceção
              </strong>
              <button
                type="button"
                onClick={() =>
                  setExcecoesDesmarcadas(
                    excecoesEscolhidas.length > 0
                      ? new Set(excecoesSugeridas.map((p) => p.id))
                      : new Set(),
                  )
                }
              >
                {excecoesEscolhidas.length > 0 ? 'Desmarcar todas' : 'Marcar todas'}
              </button>
            </div>
            <p>
              Vão no caminhão e ficam reservados na rota, mas fora da ordem otimizada: saem no fim
              do PDF e o motorista encaixa no caminho. Desmarque o que não sai hoje.
            </p>
            {excecoesSugeridas.map((p) => {
              const c = clientes[p.clienteId];
              return (
                <label key={p.id} className="opcao">
                  <input
                    type="checkbox"
                    checked={!excecoesDesmarcadas.has(p.id)}
                    onChange={() => alternarExcecao(p.id)}
                  />
                  <span>
                    {c?.nome ?? `${p.clienteId.slice(0, 8)}…`} · nota{' '}
                    <span className="mono">{p.numeroNota}</span> · {municipioDoPedido(p, c) ?? '—'}
                    {p.voltouDeRota && ` · voltou da rota de ${formatarDia(p.voltouDeRota.data)}`}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {pendentes.length > 0 && (
          <div className="alerta">
            {pendentes.length} pedido(s) sem ponto no mapa — não entram na ordem otimizada.
            {selecionados.size === 0
              ? ' Marque os pedidos de uma cidade e os sem ponto dela aparecem para ir como exceção.'
              : excecoesSugeridas.length === 0
                ? ' Nenhum é das cidades marcadas.'
                : ''}
          </div>
        )}

        {misturaCds && (
          <div className="erro">
            A seleção mistura pedidos de CDs diferentes ({cdsSelecionados.join(', ')}). A mercadoria
            está em dois galpões e o motorista sai de um só — monte uma rota por CD.
          </div>
        )}
        {cdDasNotas && cdDasNotas !== cdId && (
          <div className="alerta">
            As notas selecionadas foram emitidas por <strong>{cds[cdDasNotas]?.nome ?? cdDasNotas}</strong>,
            mas a partida escolhida é <strong>{cds[cdId]?.nome ?? cdId}</strong>. Se a mercadoria sai
            mesmo daqui, siga — a nota diz quem faturou, não necessariamente de onde o caminhão parte.
          </div>
        )}

        <div className="acoes-rota">
          <button
            className="primaria"
            disabled={selecionados.size === 0 || !cdId || otimizando || misturaCds}
            onClick={() => void otimizar()}
          >
            {otimizando ? 'OTIMIZANDO…' : `OTIMIZAR ROTA (${selecionados.size})`}
          </button>
        </div>

        {aviso?.onde === 'montagem' && <div className="alerta">{aviso.texto}</div>}
        {erro && <div className="erro">{erro}</div>}
        {publicada && (
          <div className="sucesso">
            Rota <span className="mono">{publicada}</span> publicada — os pedidos dela estão
            reservados e só voltam para a montagem pela baixa (Acompanhamento do dia).
          </div>
        )}
      </section>

      {previa && (
        <section className="cartao">
          <h2>Prévia — {previa.cd.nome}</h2>
          <div className="grade-relatorio">
            <div className="metrica">
              <div className="valor">{previa.paradas.length}</div>
              <div className="rotulo">Paradas</div>
            </div>
            <div className="metrica">
              <div className="valor">{previa.distanciaTotalKm}</div>
              <div className="rotulo">km totais</div>
            </div>
            <div className="metrica">
              <div className="valor">
                {Math.floor(previa.duracaoTotalMin / 60)}h{String(previa.duracaoTotalMin % 60).padStart(2, '0')}
              </div>
              <div className="rotulo">Duração estimada</div>
            </div>
            <div className="metrica">
              <div className="valor">{previa.retornaAoCd ? 'SIM' : 'NÃO'}</div>
              <div className="rotulo">Retorna ao CD</div>
            </div>
          </div>

          <LimiteDeErro oQue="O mapa da prévia">
            <MapaRota previa={previa} />
          </LimiteDeErro>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Endereço</th>
                <th>Vol · Peso</th>
                <th>Ordem</th>
              </tr>
            </thead>
            <tbody>
              {previa.paradas.map((p, i) => (
                <tr key={p.pedidoId}>
                  <td className="mono">{String(p.posicao).padStart(2, '0')}</td>
                  <td>{p.nome}</td>
                  <td>{p.endereco}</td>
                  <td>
                    {formatarCarga(p.volumes, p.pesoBrutoKg)}
                  </td>
                  <td>
                    <div className="reordenar">
                      <button
                        aria-label={`Subir ${p.nome}`}
                        disabled={i === 0 || otimizando}
                        onClick={() => void mover(i, -1)}
                      >
                        ▲
                      </button>
                      <button
                        aria-label={`Descer ${p.nome}`}
                        disabled={i === previa.paradas.length - 1 || otimizando}
                        onClick={() => void mover(i, 1)}
                      >
                        ▼
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {excecoesEscolhidas.length > 0 && (
            <div className="excecoes-previa">
              <strong>Exceções — sem ponto no mapa ({excecoesEscolhidas.length})</strong>
              <p>Vão no caminhão, fora da ordem e do traçado acima. Saem no fim do PDF.</p>
              <ol>
                {excecoesEscolhidas.map((p, i) => (
                  <li key={p.id}>
                    <span className="mono">E{i + 1}</span> · {clientes[p.clienteId]?.nome ?? p.clienteId}{' '}
                    · {municipioDoPedido(p, clientes[p.clienteId]) ?? '—'}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="publicacao">
            <label className="opcao">
              Motorista:
              <select value={motoristaId} onChange={(e) => setMotoristaId(e.target.value)}>
                {usuarios
                  .filter((u) => u.ativo)
                  .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nome} ({u.papel})
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primaria"
              disabled={publicando || !motoristaId}
              onClick={() => void publicar(true)}
            >
              {publicando ? 'PUBLICANDO…' : 'PUBLICAR E BAIXAR PDF'}
            </button>
            <button disabled={publicando || !motoristaId} onClick={() => void publicar(false)}>
              Publicar sem PDF
            </button>
          </div>
          <p className="nota-publicacao">
            Publicar reserva os pedidos: eles saem da montagem e não entram em outra rota até a
            baixa. O PDF pode ser baixado de novo no Acompanhamento do dia.
          </p>
        </section>
      )}
    </>
  );
}

/**
 * Onde o motorista está, e há quanto tempo se sabe disso.
 *
 * O "há quanto tempo" não é enfeite: em rota rural o sinal cai, e mostrar um
 * ponto de 40 minutos atrás como se fosse atual faria o Admin Estoque dizer ao
 * cliente uma coisa que já não é verdade. Passado o limite, a tela para de
 * fingir que sabe.
 *
 * A distância sai até a PARADA que está sendo feita — é o que responde "o
 * cliente ligou, quando chega?". Sem parada em aberto, mostra só a hora.
 */
function PosicaoDoMotorista({
  posicao,
  rota,
  agoraMs,
}: {
  posicao: PosicaoMotorista | null;
  rota: { id: string } & Rota;
  agoraMs: number;
}) {
  if (!posicao) {
    return <span className="sub">— sem posição</span>;
  }
  // `haQuantoTempo` em vez da conta na mão: com `em` corrompido, `Date.parse`
  // devolvia NaN e a tela mostrava "há NaN min" — que não diz nada a quem
  // precisa decidir se liga para o motorista.
  const quando = haQuantoTempo(posicao.em, agoraMs);
  const velha = posicaoEstaVelha(posicao, agoraMs);

  // Próxima parada por resolver: é para onde ele está indo.
  const proxima = rota.paradas.find((p) => p.status !== 'entregue' && p.status !== 'insucesso');
  const km =
    proxima && !velha
      ? Math.round(distanciaEmMetros(posicao, proxima.coordenada) / 100) / 10
      : null;

  return (
    <div className={`posicao-motorista${velha ? ' velha' : ''}`}>
      <a
        href={`https://www.google.com/maps?q=${posicao.lat},${posicao.lng}`}
        target="_blank"
        rel="noreferrer"
        title="Abrir no mapa"
        onClick={(e) => e.stopPropagation()}
      >
        {velha ? '⚠' : '📍'} {quando}
      </a>
      {km != null && proxima && (
        <div className="sub">
          {km} km de {proxima.nome?.trim().split(/\s+/)[0] || 'parada'}
        </div>
      )}
      {velha && <div className="sub">sem sinal ou app fechado</div>}
    </div>
  );
}

/** Status da parada; "pelo painel" quando a baixa veio do escritório e não do
 * motorista — sem GPS nem hora real, e quem lê precisa saber a diferença. */
function ChipParada({ status, painel }: { status: string; painel: boolean }) {
  const classe = status === 'entregue' ? 'pronto' : status === 'insucesso' ? '' : 'pendente';
  return (
    <span className={`chip ${classe}`}>
      {(status === 'insucesso' && painel ? 'Não entregue' : ROTULO_PARADA[status]) ?? status}
      {painel && ' · pelo painel'}
    </span>
  );
}

function OpcoesBaixa({
  marcado,
  desabilitado,
  onMarcar,
}: {
  marcado: ResultadoBaixa | undefined;
  desabilitado: boolean;
  onMarcar: (resultado: ResultadoBaixa) => void;
}) {
  return (
    <div className="opcoes-baixa" role="group" aria-label="Resultado da entrega">
      <button
        className={marcado === 'entregue' ? 'marcado entregue' : ''}
        aria-pressed={marcado === 'entregue'}
        disabled={desabilitado}
        onClick={() => onMarcar('entregue')}
      >
        Entregue
      </button>
      <button
        className={marcado === 'nao_entregue' ? 'marcado nao-entregue' : ''}
        aria-pressed={marcado === 'nao_entregue'}
        disabled={desabilitado}
        onClick={() => onMarcar('nao_entregue')}
      >
        Não entregue
      </button>
    </div>
  );
}

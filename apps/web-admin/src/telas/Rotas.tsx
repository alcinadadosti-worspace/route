import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  distanciaEmMetros,
  formatarCarga,
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
  listarCds,
  listarClientes,
  listarEntregasDaRota,
  listarPedidos,
  listarPosicoes,
  listarRotas,
  listarUsuarios,
  previaDeRota,
  publicarRota,
} from '../api';
import { MapaRota } from '../MapaRota';
import { MapaAcompanhamento } from '../MapaAcompanhamento';
import { FotoReferencia } from '../FotoReferencia';

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

function horaDe(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

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

  useEffect(() => {
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

  /**
   * Onde os motoristas estão agora. Busca de tempos em tempos enquanto houver
   * rota em execução — e SÓ enquanto houver: sem rota na rua não há o que
   * perguntar, e bater na API à toa é acordar instância no Render por nada.
   */
  const [posicoes, setPosicoes] = useState<Record<string, PosicaoMotorista>>({});
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  const temRotaNaRua = rotas.some((r) => r.status === 'em_execucao');
  useEffect(() => {
    if (!temRotaNaRua) return;
    let vivo = true;
    const buscar = () => {
      listarPosicoes()
        .then((p) => vivo && setPosicoes(p))
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
  }, [temRotaNaRua]);

  /** Sugestão de regiões (null = ainda não pedida nesta sessão da tela). */
  const [grupos, setGrupos] = useState<GrupoSugerido[] | null>(null);
  const [carregandoGrupos, setCarregandoGrupos] = useState(false);
  const [erroGrupos, setErroGrupos] = useState<string | null>(null);

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

  function alternar(id: string) {
    const proximo = new Set(selecionados);
    if (proximo.has(id)) proximo.delete(id);
    else proximo.add(id);
    setSelecionados(proximo);
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
    if (
      !window.confirm(
        `Desfazer a rota ${r.id}?\n\n` +
          `As ${r.paradas.length} paradas somem do app do motorista e os pedidos voltam a ficar ` +
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
          `Rota ${r.id} desfeita. Os ${r.paradas.length} pedido(s) dela voltaram para a lista de ` +
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

  async function publicar() {
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

    setPublicando(true);
    setErro(null);
    try {
      const resultado = await publicarRota({
        pedidoIds: previa.paradas.map((p) => p.pedidoId),
        cdId,
        retornaAoCd,
        motoristaId,
      });
      setPublicada(resultado.rotaId);
      setPrevia(null);
      setSelecionados(new Set());
      carregar();
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
                const entregues = r.paradas.filter((p) => p.status === 'entregue').length;
                const insucessos = r.paradas.filter((p) => p.status === 'insucesso').length;
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
                        {entregues + insucessos}/{r.paradas.length} {aberta ? '▲' : '▾'}
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
                        <td colSpan={9}>
                          {/* O mapa vem ANTES da lista: quando o cliente liga
                              perguntando, a pergunta é espacial — "o caminhão já
                              passou pela minha rua?" —, e texto obriga quem lê a
                              montar a geografia de cabeça. */}
                          <MapaAcompanhamento
                            rota={r}
                            posicao={posicoes[r.id] ?? null}
                            agoraMs={agoraMs}
                          />
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
                                        <span
                                          className={`chip ${p.status === 'entregue' ? 'pronto' : p.status === 'insucesso' ? '' : 'pendente'}`}
                                        >
                                          {ROTULO_PARADA[p.status] ?? p.status}
                                        </span>
                                      </td>
                                      <td className="mono">
                                        {p.avisadoEm ? `avisado ${horaDe(p.avisadoEm)}` : 'não avisado'}
                                      </td>
                                    </tr>
                                    {/* O detalhe da confirmação: o "por quê" que
                                        o escritório precisa para ligar ao
                                        cliente, e que a parada não guarda. */}
                                    {e && (
                                      <tr className="confirmacao">
                                        <td />
                                        <td colSpan={3}>
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
                                        <td colSpan={3}>carregando confirmação…</td>
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
                                        <td colSpan={3}>
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
                            </tbody>
                          </table>
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
            grupo é um clique que marca a seleção, e o operador segue do jeito
            de sempre. */}
        {prontos.length > 0 && (
          <div className="agrupamento">
            <div className="cabecalho-secao">
              <strong>Sugestão de regiões</strong>
              <button disabled={carregandoGrupos} onClick={() => void sugerirGrupos()}>
                {carregandoGrupos ? 'agrupando…' : '🗺 agrupar por região'}
              </button>
            </div>
            {erroGrupos && <div className="erro">{erroGrupos}</div>}
            {grupos !== null && grupos.length === 0 && (
              <div className="vazio">Nada a agrupar com os pedidos prontos de agora.</div>
            )}
            {grupos !== null && grupos.length > 0 && (
              <>
                <p style={{ color: 'var(--texto-2)', margin: '4px 0 8px' }}>
                  Do mais distante para o mais perto do CD — a região longe é a que precisa do dia
                  inteiro. Clicar marca os pedidos do grupo; a ordem das paradas continua saindo da
                  otimização.
                </p>
                <div className="grupos">
                  {grupos.map((g, i) => (
                    <button
                      key={i}
                      className="grupo"
                      onClick={() => setSelecionados(new Set(g.ids))}
                      title={`Selecionar as ${g.ids.length} paradas desta região`}
                    >
                      <strong>{g.municipios.slice(0, 3).join(' · ')}</strong>
                      {g.municipios.length > 3 && <span> +{g.municipios.length - 3}</span>}
                      <div className="grupo-numeros">
                        {g.ids.length} paradas · {g.extensaoKm} km de extensão
                        {g.distanciaDoCdKm != null && ` · ${g.distanciaDoCdKm} km do CD`}
                      </div>
                    </button>
                  ))}
                </div>
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
                  </td>
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

        {pendentes.length > 0 && (
          <div className="alerta">
            {pendentes.length} pedido(s) pendente(s) de mapeamento — fora da seleção até ganharem
            coordenada (painel de pendências ou primeira entrega em campo).
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
            Rota <span className="mono">{publicada}</span> publicada — já visível no app do
            motorista.
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

          <MapaRota previa={previa} />

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
              onClick={() => void publicar()}
            >
              {publicando ? 'PUBLICANDO…' : 'PUBLICAR ROTA'}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Onde o motorista está, e há quanto tempo se sabe disso.
 *
 * O "há quanto tempo" não é enfeite: em rota rural o sinal cai, e mostrar um
 * ponto de 40 minutos atrás como se fosse atual faria o escritório dizer ao
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
  const idadeMin = Math.max(0, Math.round((agoraMs - Date.parse(posicao.em)) / 60_000));
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
        {velha ? '⚠' : '📍'} {idadeMin === 0 ? 'agora' : `há ${idadeMin} min`}
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

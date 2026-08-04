import { Fragment, useCallback, useEffect, useState } from 'react';
import type {
  ProdutividadeMotorista,
  ProdutividadeRota,
  RelatorioProdutividade,
  Usuario,
} from '@rota/shared';
import { listarUsuarios, obterProdutividade } from '../api';

/**
 * Produtividade do motorista (RF-25). Tudo aqui sai do que a operação já grava
 * — nenhuma coleta nova foi criada para esta tela.
 *
 * A leitura é deliberadamente em três blocos, porque juntar tudo num "score"
 * seria mentira: VOLUME (quanto passou pela mão), QUALIDADE (o que falhou e por
 * quê) e CONHECIMENTO (o que ele deixou para as próximas rotas). Volume alto com
 * muita ausência não é produtividade; e quem mapeia o mato produz um valor que
 * não aparece no dia em que trabalhou.
 */

/** AAAA-MM-DD de hoje menos `dias`, no fuso do navegador. */
function diaRelativo(dias: number): string {
  const data = new Date();
  data.setDate(data.getDate() - dias);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

function horas(minutos: number | null): string {
  if (minutos == null) return '—';
  return `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')}`;
}

/** Milhar com ponto, como se escreve aqui: 12.480 e não 12,480. */
function num(valor: number): string {
  return valor.toLocaleString('pt-BR');
}

/** Idem para a quilometragem, que passa de mil num mês: 1.284,6 e não 1284.6. */
function km(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function kg(valor: number): string {
  return `${valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`;
}

/** AAAA-MM-DD → DD/MM. Sem `new Date`, que jogaria o dia para trás no fuso. */
function diaCurto(data: string): string {
  const [, mes, dia] = data.split('-');
  return mes && dia ? `${dia}/${mes}` : data;
}

const ROTULO_MOTIVO: Record<string, string> = {
  ausente: 'ausente',
  nao_localizado: 'não localizado',
  recusa: 'recusa',
};

export function Produtividade() {
  const [desde, setDesde] = useState(diaRelativo(30));
  const [ate, setAte] = useState(diaRelativo(0));
  const [relatorio, setRelatorio] = useState<RelatorioProdutividade | null>(null);
  const [nomes, setNomes] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro(null);
    Promise.all([obterProdutividade(desde, ate), listarUsuarios()])
      .then(([r, us]) => {
        setRelatorio(r);
        setNomes(Object.fromEntries(us.map((u: { id: string } & Usuario) => [u.id, u.nome])));
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar'))
      .finally(() => setCarregando(false));
  }, [desde, ate]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  return (
    <section className="cartao">
      <div className="cabecalho-secao">
        <h2>Produtividade</h2>
        <button onClick={carregar} disabled={carregando}>
          {carregando ? 'CARREGANDO…' : 'Atualizar'}
        </button>
      </div>

      <div className="periodo">
        <label className="opcao">
          De
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="opcao">
          até
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
        </label>
      </div>

      {erro && <div className="erro">{erro}</div>}

      {relatorio && relatorio.motoristas.length === 0 && !erro && (
        <div className="vazio">
          Nenhuma rota publicada neste período. A medição começa quando houver rota executada — com
          uma rota só, qualquer média engana.
        </div>
      )}

      {relatorio?.motoristas.map((m) => (
        <Cartao key={m.motoristaId} m={m} nome={nomes[m.motoristaId] ?? m.motoristaId.slice(0, 8)} />
      ))}

      {/* O ranking é sobre o CLIENTE, não sobre o motorista: é onde o aviso de
          chegada e a combinação de horário devem mirar primeiro. */}
      {(relatorio?.ausenciasPorCliente ?? []).length > 0 && (
        <div className="produtividade">
          <div className="produtividade-nome">Clientes com mais ausências</div>
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Ausências</th>
                <th>Tinha sido avisado</th>
              </tr>
            </thead>
            <tbody>
              {relatorio!.ausenciasPorCliente.map((a) => (
                <tr key={a.clienteId}>
                  <td>{a.nome}</td>
                  <td className="mono">{a.ausencias}</td>
                  <td className="mono">
                    {a.avisadas}/{a.ausencias}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="produtividade-nota">
            Ausência <strong>com</strong> aviso enviado sugere horário ruim — vale combinar uma
            janela com o cliente. <strong>Sem</strong> aviso, sugere começar a avisar: é o insucesso
            mais caro da operação, e o mais evitável.
          </div>
        </div>
      )}

      {relatorio && relatorio.motoristas.length > 0 && (
        <div className="alerta">
          <strong>Como ler isto.</strong> Entregas por hora não mede esforço: seis entregas na zona
          rural de Junqueiro podem custar mais que quinze em Penedo — compare junto com a
          quilometragem. O tempo por parada soma <em>viagem + atendimento</em>; o{' '}
          <em>Atendimento</em> separa os dois, mas só nas paradas em que a chegada foi registrada
          automaticamente (navegação aberta ao se aproximar do cliente). E o tempo em rota
          subestima: o trecho do CD até a primeira parada não entra, por não haver hora de saída.
        </div>
      )}
    </section>
  );
}

function Cartao({ m: bruto, nome }: { m: ProdutividadeMotorista; nome: string }) {
  /**
   * Painel e API sobem SEPARADOS no Render, e um deploy pode falhar sozinho —
   * já aconteceu. Com o painel novo contra a API antiga, `itensEntregues` e
   * `rotas_detalhe` vêm ausentes e `undefined.toLocaleString()` derrubaria a aba
   * inteira em tela branca. Faltando o campo, mostra zero: número velho é
   * ruim, tela quebrada é pior.
   */
  const m: ProdutividadeMotorista = {
    ...bruto,
    itensEntregues: bruto.itensEntregues ?? 0,
    produtosDistintos: bruto.produtosDistintos ?? 0,
    volumesEntregues: bruto.volumesEntregues ?? 0,
    pesoEntregueKg: bruto.pesoEntregueKg ?? 0,
    entregasSemCarga: bruto.entregasSemCarga ?? 0,
    rotas_detalhe: bruto.rotas_detalhe ?? [],
    minutosAtendimentoMediana: bruto.minutosAtendimentoMediana ?? null,
    chegadasRegistradas: bruto.chegadasRegistradas ?? 0,
  };
  const executadas = m.entregues + m.insucessos;
  const conclusao = m.paradasPlanejadas > 0 ? Math.round((executadas / m.paradasPlanejadas) * 100) : null;
  const motivos = Object.entries(m.porMotivo);
  const [detalhe, setDetalhe] = useState(false);

  return (
    <div className="produtividade">
      <div className="produtividade-nome">{nome}</div>

      <div className="grade-relatorio">
        <Metrica valor={m.rotas} rotulo="Rotas" />
        <Metrica valor={`${executadas}/${m.paradasPlanejadas}`} rotulo="Paradas executadas" />
        <Metrica valor={conclusao == null ? '—' : `${conclusao}%`} rotulo="Conclusão" />
        <Metrica valor={m.entregues} rotulo="Entregues" />
        {/* O que o Admin Estoque procura ao abrir a aba: quanta mercadoria passou
            pela mão do motorista. Fica junto com "Entregues" porque é a mesma
            pergunta em outra unidade — parada não diz se foi 1 item ou 653. */}
        <Metrica valor={num(m.itensEntregues)} rotulo="Itens entregues" />
        <Metrica valor={m.insucessos} rotulo="Insucessos" />
        <Metrica valor={km(m.kmPlanejados)} rotulo="km planejados" />
        <Metrica
          valor={m.minutosPorParadaMediana == null ? '—' : `${m.minutosPorParadaMediana} min`}
          rotulo="Por parada (mediana)"
        />
        {/* O KPI canônico de last-mile: de tudo que ele TENTOU, quanto entregou.
            Diferente de "Conclusão", que mede quanto do plano foi executado.
            Hoje toda tentativa é a primeira (não há reentrega); quando o
            reagendamento existir, esta conta muda para a 1ª de cada pedido. */}
        <Metrica
          valor={executadas > 0 ? `${Math.round((m.entregues / executadas) * 100)}%` : '—'}
          rotulo="Sucesso 1ª tentativa"
        />
        {/* Eficiência de rota: quanto de estrada custa cada entrega. PLANEJADOS,
            porque km rodados não são medidos — o rótulo não pode sugerir mais. */}
        <Metrica
          valor={m.entregues > 0 ? km(m.kmPlanejados / m.entregues) : '—'}
          rotulo="km planejados / entrega"
        />
        {/* Só das paradas com chegada detectada na navegação (chegouEm): é o
            ATENDIMENTO puro, sem a viagem que o "Por parada" mistura. */}
        <Metrica
          valor={
            m.minutosAtendimentoMediana == null ? '—' : `${m.minutosAtendimentoMediana} min`
          }
          rotulo={`Atendimento (${m.chegadasRegistradas} chegadas)`}
        />
        <Metrica valor={horas(m.minutosEmRota)} rotulo="Em rota" />
      </div>

      {/* Mercadoria que efetivamente saiu do caminhão. Fica em bloco próprio
          porque "20 paradas" e "480 itens" medem coisas diferentes: uma parada
          pode ser um frasco ou 653 deles (a maior linha da base real). */}
      <div className="produtividade-linha carga">
        <strong>Mercadoria entregue:</strong> {num(m.itensEntregues)} item(ns) em{' '}
        {num(m.produtosDistintos)} produto(s) distinto(s)
        {m.volumesEntregues > 0 && ` · ${num(m.volumesEntregues)} volume(s)`}
        {m.pesoEntregueKg > 0 && ` · ${kg(m.pesoEntregueKg)}`}
        <div className="produtividade-nota">
          <strong>Item</strong> é a soma das quantidades da nota (
          <span className="mono">qCom</span>): três frascos do mesmo desodorante contam três.{' '}
          <strong>Produtos distintos</strong> é quantas linhas a nota tem. Nesta base a média é 24
          itens em 8 linhas por nota — os dois aparecem para não se confundirem. Toda a base é
          vendida em <span className="mono">UN</span>, sem caixa nem fardo, então a soma dá um número
          comparável entre motoristas.
          {m.entregasSemCarga > 0 && (
            <>
              {' '}
              Já <strong>volume e peso são parciais</strong>: em {m.entregasSemCarga} das{' '}
              {m.entregues} entregas a nota não trouxe nenhum dos dois (o ERP emissor manda zerado),
              e há nota que informa um sem o outro. O que está somado é a parte declarada — não a
              carga real do período. Itens e produtos, sim, saem de toda nota.
            </>
          )}
        </div>
      </div>

      {motivos.length > 0 && (
        <div className="produtividade-linha">
          <strong>Insucessos por motivo:</strong>{' '}
          {motivos.map(([motivo, n]) => `${ROTULO_MOTIVO[motivo] ?? motivo} (${n})`).join(' · ')}
        </div>
      )}

      {/* O laço causal do aviso: se avisar funciona, a ausência tem de ser mais
          rara entre os avisados. Sem base para comparar, não afirma nada. */}
      <div className="produtividade-linha">
        <strong>Aviso ao cliente:</strong> {m.avisados} parada(s) avisada(s) ·{' '}
        {m.ausenciasAvisados + m.ausenciasNaoAvisados === 0
          ? 'nenhuma ausência no período'
          : `ausências: ${m.ausenciasAvisados} entre avisados, ${m.ausenciasNaoAvisados} entre não avisados`}
      </div>

      <div className="produtividade-linha conhecimento">
        <strong>Conhecimento acrescentado:</strong> {m.pinsConfirmados} pin(s) confirmado(s) em campo
        · {m.trilhasGravadas} trilha(s) aprendida(s)
        <div className="produtividade-nota">
          Não aparece no dia em que aconteceu: aparece em toda rota futura até aquele cliente, para
          qualquer motorista.
        </div>
      </div>

      {/* O número do período é média; o dia é o que se cobra. Rota a rota mostra
          onde a carga foi grande e onde a rota rendeu pouco. */}
      {m.rotas_detalhe.length > 0 && (
        <div className="produtividade-linha">
          <button className="ligacao" onClick={() => setDetalhe(!detalhe)}>
            {detalhe ? '▲ Esconder' : '▾ Ver'} rota a rota ({m.rotas_detalhe.length})
          </button>
          {detalhe && <TabelaRotas rotas={m.rotas_detalhe} />}
        </div>
      )}
    </div>
  );
}

function TabelaRotas({ rotas }: { rotas: ProdutividadeRota[] }) {
  return (
    <div className="rolagem-tabela">
      <table className="rotas-produtividade">
        <thead>
          <tr>
            <th>Dia</th>
            <th>Rota</th>
            <th>Paradas</th>
            <th>Itens</th>
            <th>Itens/entrega</th>
            <th>Produtos</th>
            <th>Volumes</th>
            <th>Peso</th>
            <th>km</th>
          </tr>
        </thead>
        <tbody>
          {rotas.map((r) => (
            <Fragment key={r.rotaId}>
              {/* Sem a borda, a nota do "sem carga" cola na sua própria rota em
                  vez de parecer pertencer à de baixo. */}
              <tr className={r.entregasSemCarga > 0 ? 'sem-borda' : undefined}>
                <td className="mono">{diaCurto(r.data)}</td>
                {/* A data do id repete a coluna Dia; só o sufixo identifica. */}
                <td className="mono" title={r.rotaId}>
                  {r.rotaId.split('_')[1] ?? r.rotaId}
                </td>
                <td className="mono">
                  {r.entregues + r.insucessos}/{r.paradas}
                </td>
                <td className="mono">{num(r.itensEntregues)}</td>
                {/* Uma rota de 400 itens em 20 paradas não é a mesma coisa que
                    400 numa só: é isto que separa carga pesada de rota grande. */}
                <td className="mono">
                  {r.entregues > 0 ? Math.round(r.itensEntregues / r.entregues) : '—'}
                </td>
                <td className="mono">{num(r.produtosDistintos)}</td>
                <td className="mono">{r.volumesEntregues || '—'}</td>
                <td className="mono">{r.pesoEntregueKg > 0 ? kg(r.pesoEntregueKg) : '—'}</td>
                <td className="mono">{km(r.kmPlanejados)}</td>
              </tr>
              {r.entregasSemCarga > 0 && (
                <tr className="nota-linha">
                  <td colSpan={9}>
                    {r.entregasSemCarga} de {r.entregues} entrega(s) desta rota sem volume nem peso
                    na nota — as colunas Volumes e Peso ficam abaixo do que saiu de fato.
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metrica({ valor, rotulo }: { valor: number | string; rotulo: string }) {
  return (
    <div className="metrica">
      <div className="valor">{valor}</div>
      <div className="rotulo">{rotulo}</div>
    </div>
  );
}

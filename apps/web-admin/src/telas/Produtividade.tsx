import { useCallback, useEffect, useState } from 'react';
import type { ProdutividadeMotorista, RelatorioProdutividade, Usuario } from '@rota/shared';
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

      {relatorio && relatorio.motoristas.length > 0 && (
        <div className="alerta">
          <strong>Como ler isto.</strong> Entregas por hora não mede esforço: seis entregas na zona
          rural de Junqueiro podem custar mais que quinze em Penedo — compare junto com a
          quilometragem. O tempo por parada soma <em>viagem + atendimento</em>, porque a hora de
          chegada no cliente ainda não é registrada. E o tempo em rota subestima: o trecho do CD até
          a primeira parada não entra, por não haver hora de saída.
        </div>
      )}
    </section>
  );
}

function Cartao({ m, nome }: { m: ProdutividadeMotorista; nome: string }) {
  const executadas = m.entregues + m.insucessos;
  const conclusao = m.paradasPlanejadas > 0 ? Math.round((executadas / m.paradasPlanejadas) * 100) : null;
  const motivos = Object.entries(m.porMotivo);

  return (
    <div className="produtividade">
      <div className="produtividade-nome">{nome}</div>

      <div className="grade-relatorio">
        <Metrica valor={m.rotas} rotulo="Rotas" />
        <Metrica valor={`${executadas}/${m.paradasPlanejadas}`} rotulo="Paradas executadas" />
        <Metrica valor={conclusao == null ? '—' : `${conclusao}%`} rotulo="Conclusão" />
        <Metrica valor={m.entregues} rotulo="Entregues" />
        <Metrica valor={m.insucessos} rotulo="Insucessos" />
        <Metrica valor={m.kmPlanejados} rotulo="km planejados" />
        <Metrica
          valor={m.minutosPorParadaMediana == null ? '—' : `${m.minutosPorParadaMediana} min`}
          rotulo="Por parada (mediana)"
        />
        <Metrica valor={horas(m.minutosEmRota)} rotulo="Em rota" />
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

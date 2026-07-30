import { useEffect, useRef, useState } from 'react';
import type { CentroDistribuicao, RelatorioImportacao } from '@rota/shared';
import { importarXmls, listarCds } from '../api';

/** Fluxo 1 — o operador arrasta os XMLs das notas do dia (RF-01, RF-04). */
export function Importacao() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [relatorio, setRelatorio] = useState<RelatorioImportacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // Só para dar nome ao CD no relatório — a importação devolve o id.
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});

  useEffect(() => {
    listarCds()
      .then(setCds)
      .catch(() => setCds({}));
  }, []);

  async function enviar(lista: FileList | null) {
    // Copia ANTES de limpar: `files` é uma lista VIVA do input, e zerar o value
    // esvaziaria a lista que acabamos de receber.
    const escolhidos = Array.from(lista ?? []);
    // Limpar a seleção é o que permite reenviar OS MESMOS arquivos: sem isto o
    // input não dispara `change` de novo e a tela não faz nada — justo a
    // tentativa mais provável depois de uma importação que falhou (API dormindo).
    if (inputRef.current) inputRef.current.value = '';
    if (escolhidos.length === 0) return;
    const xmls = escolhidos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
    if (xmls.length === 0) {
      setErro('Nenhum arquivo .xml entre os selecionados.');
      return;
    }
    setEnviando(true);
    setErro(null);
    try {
      setRelatorio(await importarXmls(xmls));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na importação');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="cartao">
      <h2>Importação do dia</h2>
      <p style={{ color: 'var(--texto-2)' }}>
        Arraste os XMLs das NF-e (procNFe, modelo 55) ou clique para selecionar. Reimportar o
        mesmo arquivo é inócuo — a chave de acesso deduplica.
      </p>

      <div
        className={`zona-upload${arrastando ? ' ativa' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault();
          setArrastando(false);
          void enviar(e.dataTransfer.files);
        }}
      >
        {enviando ? 'PROCESSANDO…' : 'SOLTE OS XMLs AQUI'}
        <input
          ref={inputRef}
          type="file"
          accept=".xml"
          multiple
          hidden
          onChange={(e) => void enviar(e.target.files)}
        />
      </div>

      {erro && <div className="erro">{erro}</div>}

      {relatorio && (
        <>
          <div className="grade-relatorio">
            <Metrica valor={relatorio.total} rotulo="Arquivos" />
            <Metrica valor={relatorio.importados} rotulo="Importados" />
            <Metrica valor={relatorio.duplicados} rotulo="Duplicados" />
            <Metrica valor={relatorio.prontosParaRota} rotulo="Prontos p/ rota" />
            <Metrica valor={relatorio.geocodificados} rotulo="Geocodificados" />
            <Metrica valor={relatorio.aproximados} rotulo="Aproximados (a mapear)" />
            <Metrica valor={relatorio.pendentesDeMapeamento} rotulo="Pendentes de mapeamento" />
            <Metrica valor={relatorio.pendentesDeDecisao} rotulo="Aguardando escolha de endereço" />
            <Metrica valor={relatorio.rejeitados.length} rotulo="Rejeitados" />
            <Metrica valor={relatorio.semCarga ?? 0} rotulo="Sem volume/peso" />
          </div>

          {(relatorio.semCarga ?? 0) > 0 && (
            <div className="alerta">
              {relatorio.semCarga} nota(s) chegaram <strong>sem volume nem peso</strong> — o XML traz
              a estrutura zerada (<span className="mono">qVol=0</span>,{' '}
              <span className="mono">pesoB=0.000</span>). Não é falha da importação: o dado não vem
              na nota. Quem carrega o caminhão fica sem essa informação, e o conserto é no ERP que
              emite.
            </div>
          )}

          {/* De qual CD saiu cada nota, pelo CNPJ do emitente (seção 8.5). É a
              conferência que o operador faz de olho: se uma remessa que devia
              ser toda de um galpão vem dividida, algo entrou errado. */}
          {Object.keys(relatorio.porCd ?? {}).length > 0 && (
            <div className="por-cd">
              Origem das notas:{' '}
              {Object.entries(relatorio.porCd)
                .map(
                  ([cdId, quantas]) =>
                    `${cdId === '—' ? 'emitente não reconhecido' : (cds[cdId]?.nome ?? cdId)} (${quantas})`,
                )
                .join(' · ')}
            </div>
          )}

          {/* Um mesmo cliente pode render dois alertas na mesma remessa (mudança
              de cadastro + entrega em local diverso): a chave leva o índice. */}
          {relatorio.alertas.map((a, i) => (
            <div key={`${a.clienteId}-${i}`} className="alerta">
              <strong>{a.nome}:</strong> {a.mensagem}
            </div>
          ))}

          {relatorio.rejeitados.map((r) => (
            <div key={r.arquivo} className="erro">
              <span className="mono">{r.arquivo}</span> — {r.motivo}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Metrica({ valor, rotulo }: { valor: number; rotulo: string }) {
  return (
    <div className="metrica">
      <div className="valor">{valor}</div>
      <div className="rotulo">{rotulo}</div>
    </div>
  );
}

import { useRef, useState } from 'react';
import type { RelatorioImportacao } from '@rota/shared';
import { importarXmls } from '../api';

/** Fluxo 1 — o operador arrasta os XMLs das notas do dia (RF-01, RF-04). */
export function Importacao() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [relatorio, setRelatorio] = useState<RelatorioImportacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(lista: FileList | null) {
    if (!lista || lista.length === 0) return;
    const xmls = Array.from(lista).filter((f) => f.name.toLowerCase().endsWith('.xml'));
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
            <Metrica valor={relatorio.pendentesDeMapeamento} rotulo="Pendentes de mapeamento" />
            <Metrica valor={relatorio.rejeitados.length} rotulo="Rejeitados" />
          </div>

          {relatorio.alertas.map((a) => (
            <div key={a.clienteId} className="alerta">
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

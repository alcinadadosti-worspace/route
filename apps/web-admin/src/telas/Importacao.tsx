import { useEffect, useRef, useState } from 'react';
import type { CentroDistribuicao, RelatorioImportacao } from '@rota/shared';
import { contarEnderecosALocalizar, importarArquivos, listarCds, localizarEnderecos } from '../api';

/** Fluxo 1 — o operador solta a planilha do ERP (ou XMLs de NF-e) do dia (RF-01, RF-04). */
export function Importacao() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [relatorio, setRelatorio] = useState<RelatorioImportacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  /** Progresso da localização de endereços (passo separado, pago e em lotes). */
  const [localizando, setLocalizando] = useState<{ feitos: number; restantes: number } | null>(null);
  /** Resultado da última localização — fica na tela (sumia em 4 s, e o número
   * dos que a busca não achou nunca aparecia). */
  const [ultimaLocalizacao, setUltimaLocalizacao] = useState<{
    feitos: number;
    semResultado: number;
    restantes: number;
  } | null>(null);
  /** Fila da busca — o botão existe SEMPRE que há fila. Antes ele só aparecia
   * logo depois de uma importação, e as telas que mandam "use Localizar
   * endereços na Importação" levavam a uma aba sem botão nenhum. */
  const [naFila, setNaFila] = useState<number | null>(null);
  // Só para dar nome ao CD no relatório — a importação devolve o id.
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});
  /** Sair da aba PARA o laço: ele seguia invisível, e voltar e clicar de novo
   * punha dois laços pagos em paralelo sobre a mesma fila. */
  const montado = useRef(true);
  useEffect(() => {
    // Religa na (re)montagem: o React monta, desmonta e remonta em
    // desenvolvimento, e só desligar deixava a tela "desmontada" para sempre —
    // a contagem da fila nunca aparecia.
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  function contarFila() {
    contarEnderecosALocalizar()
      .then((r) => montado.current && setNaFila(r.restantes))
      .catch(() => montado.current && setNaFila(null));
  }

  useEffect(() => {
    listarCds()
      .then(setCds)
      .catch(() => setCds({}));
    contarFila();
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
    const aceitos = escolhidos.filter((f) => /\.(xml|xlsx)$/i.test(f.name));
    if (aceitos.length === 0) {
      setErro('Nenhum arquivo .xlsx (planilha do ERP) ou .xml entre os selecionados.');
      return;
    }
    setEnviando(true);
    setErro(null);
    // O relatório anterior sai da tela: ficando debaixo do erro de uma
    // importação nova que falhou, parecia ser o resultado dela.
    setRelatorio(null);
    try {
      setRelatorio(await importarArquivos(aceitos));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na importação');
    } finally {
      setEnviando(false);
      contarFila();
    }
  }

  /**
   * Roda lote a lote até acabar. Sequencial de propósito: cada lote é uma
   * requisição que já leva ~10 s, e emendar duas em paralelo só aproxima o
   * limite de taxa da Google — cujo estouro derruba o lote inteiro.
   */
  async function localizar() {
    if (localizando) return;
    setErro(null);
    setUltimaLocalizacao(null);
    setLocalizando({ feitos: 0, restantes: naFila ?? 0 });
    let feitos = 0;
    // `pular` acumula os endereços que a Google NÃO localizou: eles continuam
    // sem coordenada e voltariam ao começo da fila. Sem saltá-los, este laço
    // repetiria o mesmo lote para sempre — e cada volta é dinheiro gasto.
    let pular = 0;
    let restantes = 0;
    try {
      for (;;) {
        if (!montado.current) return;
        const r = await localizarEnderecos(pular);
        feitos += r.geocodificados + r.aproximados;
        pular += r.semResultado;
        restantes = r.restantes;
        if (montado.current) setLocalizando({ feitos, restantes: r.restantes });
        if (r.restantes === 0 || r.processados === 0) break;
      }
      if (montado.current) setUltimaLocalizacao({ feitos, semResultado: pular, restantes });
    } catch (e) {
      if (montado.current) setErro(e instanceof Error ? e.message : 'Falha ao localizar endereços');
    } finally {
      if (montado.current) {
        setLocalizando(null);
        contarFila();
      }
    }
  }

  return (
    <section className="cartao">
      <h2>Importação do dia</h2>
      <p style={{ color: 'var(--texto-2)' }}>
        Arraste a planilha ConsultaPedidos do ERP (.xlsx) — ou XMLs de NF-e — ou clique para selecionar. Reimportar o
        mesmo arquivo é inócuo — a chave de acesso deduplica.
      </p>

      {/* Durante o envio a zona não aceita outro: uma segunda importação em
          paralelo dobrava as leituras, e a que terminasse por último trocava o
          relatório — e os alertas — da outra. */}
      <div
        className={`zona-upload${arrastando ? ' ativa' : ''}`}
        aria-disabled={enviando}
        style={enviando ? { cursor: 'progress', opacity: 0.7 } : undefined}
        onClick={() => !enviando && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!enviando) setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault();
          setArrastando(false);
          if (!enviando) void enviar(e.dataTransfer.files);
        }}
      >
        {enviando ? 'PROCESSANDO…' : 'SOLTE A PLANILHA (OU XMLs) AQUI'}
        <input
          ref={inputRef}
          type="file"
          accept=".xml,.xlsx"
          multiple
          hidden
          onChange={(e) => void enviar(e.target.files)}
        />
      </div>

      {erro && <div className="erro">{erro}</div>}

      {/* Localizar no mapa: passo próprio (é PAGO), disponível sempre que há
          entrega sem ponto — inclusive a liberada em "Fora da montagem". */}
      {(localizando || (naFila ?? 0) > 0 || ultimaLocalizacao) && (
        <div className="acoes-rota">
          <button
            className="primaria"
            disabled={localizando !== null || (naFila ?? 0) === 0}
            onClick={() => void localizar()}
          >
            {localizando
              ? `Localizando… ${localizando.feitos} feito(s), ${localizando.restantes} na fila`
              : `📍 Localizar endereços no mapa${naFila ? ` (${naFila} sem ponto)` : ''}`}
          </button>
          {ultimaLocalizacao && !localizando && (
            <div className="sucesso" style={{ marginTop: 8 }}>
              Localização concluída: {ultimaLocalizacao.feitos} endereço(s) ganharam ponto
              {ultimaLocalizacao.semResultado > 0 &&
                ` · ${ultimaLocalizacao.semResultado} a busca não achou (vão como exceção da cidade, ou se mapeiam em campo)`}
              .
            </div>
          )}
        </div>
      )}

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
            {/* A subtração espelha a aba Decisões: a nota que levanta as duas
                perguntas aparece lá só na de retirada, e a de endereço reaparece
                depois de respondida. Contar o mesmo pedido nas duas métricas
                faria o operador procurar um cartão que ainda não está na tela. */}
            {/* Planilha: o ERP decide sozinho (Tipo de Entrega explícito). */}
            {(relatorio.retiradas ?? 0) > 0 && (
              <Metrica valor={relatorio.retiradas ?? 0} rotulo="Retirada no balcão" />
            )}
            {(relatorio.canceladas ?? 0) > 0 && (
              <Metrica valor={relatorio.canceladas ?? 0} rotulo="Canceladas no ERP (não entram)" />
            )}
            {/* As que já estavam no sistema saem sozinhas; o alerta de cada
                uma, abaixo, diz se estava numa rota. */}
            {(relatorio.canceladasApagadas ?? 0) > 0 && (
              <Metrica
                valor={relatorio.canceladasApagadas ?? 0}
                rotulo="Canceladas já importadas — apagadas"
              />
            )}
            {/* O ERP pode estar errado: ficam em Rotas > Fora da montagem, liberáveis. */}
            {(relatorio.jaEntregues ?? 0) > 0 && (
              <Metrica valor={relatorio.jaEntregues ?? 0} rotulo="Entregues no ERP (fora da montagem)" />
            )}
            {/* XML: retirada é palpite do modFrete e pede confirmação. */}
            {(relatorio.retiradaAConfirmar ?? 0) > 0 && (
              <Metrica valor={relatorio.retiradaAConfirmar ?? 0} rotulo="Retirada a confirmar" />
            )}
            <Metrica
              valor={relatorio.pendentesDeDecisao - (relatorio.retiradaAConfirmar ?? 0)}
              rotulo="Aguardando escolha de endereço"
            />
            <Metrica valor={relatorio.rejeitados.length} rotulo="Rejeitados" />
            <Metrica valor={relatorio.semCarga ?? 0} rotulo="Rota sem peso" />
          </div>

          {(relatorio.semCarga ?? 0) > 0 && (
            <div className="alerta">
              {relatorio.semCarga} nota(s) <strong>de rota</strong> chegaram sem volume nem peso (
              <span className="mono">qVol=0</span>, <span className="mono">pesoB=0.000</span>).
              Quem carrega o caminhão fica sem essa informação nessas entregas. Nota de retirada
              não conta aqui: o ERP zera o volume de propósito no que ninguém vai carregar.
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

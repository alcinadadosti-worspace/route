import { useEffect, useMemo, useRef, useState } from 'react';
import type { CentroDistribuicao } from '@rota/shared';
import { contarEnderecosALocalizar, importarArquivos, listarCds, localizarEnderecos } from '../api';
import { CompletarDados } from '../CompletarDados';
import { resumoDoSalvo } from '../formularioCliente';
import { confirmarDescarte } from '../alteracoesPendentes';
import { descricaoDoEnvio, somarEnvios, type Envio } from '../loteDeImportacao';

/**
 * O lote vive FORA do componente (e na sessão da aba do navegador): trocar de
 * aba desmonta a tela, e voltar da aba Clientes ou Rotas encontrava a lista de
 * romaneios vazia — como se nada tivesse sido enviado.
 *
 * O ENVIO em curso também: trocar de aba no meio dele perdia o resultado (a
 * importação acabava no servidor, mas não entrava na lista), e a tela, de
 * volta, deixava soltar outro arquivo em paralelo.
 */
interface EstadoDoLote {
  envios: Envio[];
  /** Clientes fora da base já resolvidos neste lote (id → o que foi salvo). */
  completados: Record<string, string>;
  /** Arquivos sendo processados agora, e desde quando (null = nenhum envio em curso). */
  enviando: { arquivos: string[]; desde: number } | null;
  erroDoEnvio: string | null;
}
const CHAVE_DA_SESSAO = 'rota.importacao.lote';
const lote: EstadoDoLote = {
  ...(() => {
    try {
      const salvo = sessionStorage.getItem(CHAVE_DA_SESSAO);
      if (salvo) return JSON.parse(salvo) as Pick<EstadoDoLote, 'envios' | 'completados'>;
    } catch {
      // Sem sessionStorage (modo privado, cota): o lote vale só enquanto a página estiver aberta.
    }
    return { envios: [], completados: {} };
  })(),
  enviando: null,
  erroDoEnvio: null,
};
const ouvintes = new Set<() => void>();
function mudarLote(mudanca: Partial<EstadoDoLote>) {
  Object.assign(lote, mudanca);
  try {
    sessionStorage.setItem(CHAVE_DA_SESSAO, JSON.stringify({ envios: lote.envios, completados: lote.completados }));
  } catch {
    // Idem: sem onde guardar, segue só na memória.
  }
  for (const avisar of ouvintes) avisar();
}
/** O lote, redesenhando a tela quando ele muda — inclusive com ela remontada. */
function useLote(): EstadoDoLote {
  const [, redesenhar] = useState(0);
  useEffect(() => {
    const avisar = () => redesenhar((n) => n + 1);
    ouvintes.add(avisar);
    return () => void ouvintes.delete(avisar);
  }, []);
  return lote;
}

/** Manda os arquivos e põe o resultado no lote — fora do componente, para não
 * se perder se a tela for desmontada no meio. */
async function enviarAoLote(aceitos: File[]): Promise<void> {
  const arquivos = aceitos.map((f) => f.name);
  mudarLote({ enviando: { arquivos, desde: Date.now() }, erroDoEnvio: null });
  try {
    const novo = await importarArquivos(aceitos);
    mudarLote({ envios: [...lote.envios, { quando: new Date().toISOString(), arquivos, relatorio: novo }] });
  } catch (e) {
    mudarLote({ erroDoEnvio: e instanceof Error ? e.message : 'Falha na importação' });
  } finally {
    mudarLote({ enviando: null });
  }
}

/** Fluxo 1 — o operador solta os romaneios do dia (ou a planilha/XMLs do ERP) (RF-01, RF-04). */
export function Importacao() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const { envios, completados, enviando, erroDoEnvio } = useLote();
  const [segundos, setSegundos] = useState(0);
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

  // O relógio do "processando": com a API acordando o envio leva até 1 min, e
  // uma tela parada nesse tempo parecia travada.
  useEffect(() => {
    if (!enviando) return;
    // Conta desde o INÍCIO do envio, não da montagem: voltando de outra aba no
    // meio dele, o relógio continua de onde estava.
    const marcar = () => setSegundos(Math.floor((Date.now() - enviando.desde) / 1000));
    marcar();
    const relogio = setInterval(marcar, 1000);
    return () => clearInterval(relogio);
  }, [enviando]);

  const relatorio = useMemo(() => somarEnvios(envios), [envios]);
  const aCompletar = (relatorio?.clientesACompletar ?? []).filter((c) => !(c.id in completados));
  const pacotes = (relatorio?.folhas ?? []).reduce((soma, f) => soma + f.pacotes, 0);

  async function enviar(lista: FileList | null) {
    // Copia ANTES de limpar: `files` é uma lista VIVA do input, e zerar o value
    // esvaziaria a lista que acabamos de receber.
    const escolhidos = Array.from(lista ?? []);
    // Limpar a seleção é o que permite reenviar OS MESMOS arquivos: sem isto o
    // input não dispara `change` de novo e a tela não faz nada — justo a
    // tentativa mais provável depois de uma importação que falhou (API dormindo).
    if (inputRef.current) inputRef.current.value = '';
    if (escolhidos.length === 0) return;
    const aceitos = escolhidos.filter((f) => /\.(xml|xlsx|pdf)$/i.test(f.name));
    if (aceitos.length === 0) {
      setErro('Nenhum romaneio (.pdf), planilha (.xlsx) ou .xml entre os selecionados.');
      return;
    }
    // O envio novo ENTRA no lote — não substitui o anterior: os romaneios de
    // uma rota vão chegando um a um, e os formulários abertos continuam.
    if (lote.enviando) return;
    setErro(null);
    await enviarAoLote(aceitos);
    if (montado.current) contarFila();
  }

  /** Esvazia a LISTA da tela para a próxima rota — os pedidos já importados
   * continuam no sistema. */
  function comecarOutraRota() {
    if (!confirmarDescarte()) return;
    if (!window.confirm('Limpar a lista desta tela para começar outra rota? Os pedidos já importados continuam no sistema.')) {
      return;
    }
    mudarLote({ envios: [], completados: {}, erroDoEnvio: null });
    setUltimaLocalizacao(null);
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

  // Localizar no mapa: passo próprio (é PAGO), disponível sempre que há entrega
  // sem ponto — inclusive a liberada em "Fora da montagem".
  const botaoLocalizar = (
    <button
      className="primaria"
      disabled={localizando !== null || enviando !== null || (naFila ?? 0) === 0}
      onClick={() => void localizar()}
    >
      {localizando ? (
        <>
          <span className="giro pequeno" aria-hidden="true" />
          Localizando… {localizando.feitos} feito(s), {localizando.restantes} na fila
        </>
      ) : (
        `📍 Localizar endereços no mapa${naFila ? ` (${naFila} sem ponto)` : ''}`
      )}
    </button>
  );
  const resultadoDaLocalizacao = ultimaLocalizacao && !localizando && (
    <div className="sucesso" style={{ marginTop: 8 }}>
      Localização concluída: {ultimaLocalizacao.feitos} endereço(s) ganharam ponto
      {ultimaLocalizacao.semResultado > 0 &&
        ` · ${ultimaLocalizacao.semResultado} a busca não achou (vão como exceção da cidade, ou se mapeiam em campo)`}
      . Monte a rota na aba Rotas.
    </div>
  );

  return (
    <section className="cartao">
      <h2>Importação do dia</h2>
      <p style={{ color: 'var(--texto-2)' }}>
        Arraste o <strong>romaneio em PDF</strong> da Plataforma Logística do Boticário — ou clique para selecionar.
        Se a rota vem em <strong>mais de um romaneio</strong>, acrescente os outros com o botão{' '}
        <strong>＋ Adicionar romaneio</strong>; quando tiver mandado todos, clique em{' '}
        <strong>Localizar endereços no mapa</strong>. O CD sai do motorista da folha: Caique Santos = Palmeira dos
        Índios, Paulo Rogério Santos = Penedo. Reenviar a mesma folha é inócuo — o pedido repetido é ignorado.
      </p>
      {/* O cadastro fica guardado no banco: pedir que ele acompanhe todo
          romaneio fazia parecer obrigatório um arquivo que se manda uma vez. */}
      <p style={{ color: 'var(--texto-2)' }}>
        A <strong>base de revendedoras</strong> (cadastro e pedidos do ERP) fica guardada no sistema — não precisa
        vir junto: cada linha do romaneio é cruzada com ela e entra com telefone, papel e referência. Quem não está
        na base entra normalmente, só com nome e endereço, e o painel pede o resto logo abaixo. A planilha
        ConsultaPedidos e os XMLs de NF-e continuam aceitos.
      </p>

      {/* O seletor de arquivo, um só para a zona grande e para o "+". */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.xml,.xlsx"
        multiple
        hidden
        onChange={(e) => void enviar(e.target.files)}
      />

      {/* Antes do primeiro envio: a zona grande. Depois, ela dá lugar ao
          cartão da rota com o "+" — o usuário pediu um botão claro para
          acrescentar o romaneio seguinte, não "solte de novo na zona". */}
      {envios.length === 0 && (
        <div
          className={`zona-upload${arrastando ? ' ativa' : ''}${enviando ? ' enviando' : ''}`}
          aria-disabled={enviando !== null}
          aria-busy={enviando !== null}
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
          {enviando ? <Processando arquivos={enviando.arquivos} segundos={segundos} /> : 'SOLTE OS ROMANEIOS (PDF) AQUI'}
        </div>
      )}

      {(erro ?? erroDoEnvio) && <div className="erro">{erro ?? erroDoEnvio}</div>}

      {/* O cartão da rota: o que JÁ entrou, o "+" para o romaneio seguinte e o
          Localizar — tudo junto, na ordem em que se faz. Aceita soltar PDF
          em cima também. */}
      {envios.length > 0 && (
        <div
          className={`lote-importacao${arrastando ? ' ativa' : ''}`}
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
          <div className="lote-cabecalho">
            <strong>
              Romaneios desta rota: {relatorio?.romaneios ?? 0}
              {pacotes > 0 ? ` · ${pacotes} pacote(s)` : ''} · {relatorio?.importados ?? 0} pedido(s) novo(s)
            </strong>
            <button className="ligacao alvo-toque" disabled={enviando !== null || localizando !== null} onClick={comecarOutraRota}>
              Começar outra rota
            </button>
          </div>
          <ul>
            {envios.map((e, i) => (
              <li key={`${e.quando}-${i}`}>
                <span className="mono">{horaCurta(e.quando)}</span> {descricaoDoEnvio(e).join(' · ')}
                {e.relatorio.duplicados > 0 && ` (${e.relatorio.duplicados} repetido(s), ignorado(s))`}
              </li>
            ))}
          </ul>
          {enviando && <Processando arquivos={enviando.arquivos} segundos={segundos} />}
          <div className="lote-acoes">
            <button disabled={enviando !== null || localizando !== null} onClick={() => inputRef.current?.click()}>
              ＋ Adicionar romaneio
            </button>
            {botaoLocalizar}
          </div>
          {!localizando && !ultimaLocalizacao && (
            <div className="decisao-aviso" style={{ marginTop: 8 }}>
              A rota tem mais romaneios? Adicione com o ＋. Mandou todos? Localize os endereços — depois a rota se monta
              na aba Rotas.
            </div>
          )}
          {resultadoDaLocalizacao}
        </div>
      )}

      {/* Sem lote nesta tela, mas com entrega sem ponto (de outra sessão, ou
          liberada em "Fora da montagem"): o Localizar continua à mão. */}
      {envios.length === 0 && !enviando && (localizando || (naFila ?? 0) > 0 || ultimaLocalizacao) && (
        <div className="acoes-rota">
          {botaoLocalizar}
          {resultadoDaLocalizacao}
        </div>
      )}

      {relatorio && (
        <>
          <div className="grade-relatorio">
            {(relatorio.romaneios ?? 0) > 0 && <Metrica valor={relatorio.romaneios ?? 0} rotulo="Romaneios lidos" />}
            {/* Cadastro de revendedoras: não gera pedido nem cliente — fica
                guardado para casar os romaneios. */}
            {relatorio.revendedoras !== undefined && (
              <Metrica valor={relatorio.revendedoras} rotulo="Revendedoras guardadas" />
            )}
            {relatorio.clientesAtualizados !== undefined && (
              <Metrica valor={relatorio.clientesAtualizados} rotulo="Clientes atualizados" />
            )}
            {/* "Lidos" e não "Arquivos": na planilha e no romaneio conta linhas. */}
            <Metrica valor={relatorio.total} rotulo="Lidos" />
            <Metrica valor={relatorio.importados} rotulo="Pedidos importados" />
            {/* Entraram só com o que a folha traz: os dados se completam abaixo. */}
            {(relatorio.semCadastro ?? 0) > 0 && (
              <Metrica valor={relatorio.semCadastro ?? 0} rotulo="Fora da base de revendedoras" />
            )}
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
          {/* Refeito com o lote inteiro (somado, ele se repetia por envio). */}
          {aCompletar.length > 0 && (
            <div className="alerta">
              <strong>Fora da base de revendedoras:</strong> {aCompletar.length} destinatária(s) não estão na base e
              entraram só com o que a folha traz (nome e endereço). Complete o telefone e a referência logo abaixo — ou
              depois, na aba Clientes. Pedido do site (Consumidor Final) é sempre assim.
            </div>
          )}

          {/* O formulário de cada um ALI, logo depois de importar: é quando o
              Admin Estoque tem o romaneio na mão — e antes de montar a rota. */}
          {(relatorio.clientesACompletar ?? []).length > 0 && (
            <div className="acoes-rota">
              <h3>Completar dados — fora da base de revendedoras</h3>
              {(relatorio.clientesACompletar ?? []).map((c) =>
                c.id in completados ? (
                  <div key={c.id} className="sucesso" style={{ marginTop: 8 }}>
                    {c.nome}: {completados[c.id]}
                  </div>
                ) : (
                  <CompletarDados
                    key={c.id}
                    cliente={c}
                    aoConcluir={(atualizado, corpo) => {
                      mudarLote({ completados: { ...lote.completados, [c.id]: resumoDoSalvo(corpo, atualizado.telefone) } });
                    }}
                  />
                ),
              )}
            </div>
          )}

          {/* Índice na chave: o romaneio recusa várias linhas com o mesmo "arquivo". */}
          {relatorio.rejeitados.map((r, i) => (
            <div key={`${r.arquivo}-${i}`} className="erro">
              <span className="mono">{r.arquivo}</span> — {r.motivo}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** "2026-10-27T17:32:10Z" → "14:32" na hora local. */
function horaCurta(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function Metrica({ valor, rotulo }: { valor: number; rotulo: string }) {
  return (
    <div className="metrica">
      <div className="valor">{valor}</div>
      <div className="rotulo">{rotulo}</div>
    </div>
  );
}

/** O "processando" do envio: giro, relógio e barra em movimento — parada por
 * até 1 min (API acordando), a tela parecia travada. */
function Processando({ arquivos, segundos }: { arquivos: string[]; segundos: number }) {
  return (
    <div className="processando-bloco">
      <div className="processando" role="status" aria-live="polite">
        <span className="giro" aria-hidden="true" />
        <div>
          <strong>
            Processando {arquivos.length} arquivo(s)… {segundos} s
          </strong>
          <div className="processando-detalhe">{arquivos.join(' · ')}</div>
          <div className="processando-detalhe">
            {segundos >= 15
              ? 'O servidor pode levar até 1 minuto para acordar — continue com a tela aberta.'
              : 'Lendo as folhas e cruzando com a base de revendedoras…'}
          </div>
        </div>
      </div>
      <div className="barra-indeterminada" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}

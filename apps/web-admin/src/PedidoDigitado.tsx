import { useEffect, useState } from 'react';
import {
  validarPedidoDigitado,
  type CampoDoPedidoDigitado,
  type CentroDistribuicao,
  type PedidoDigitado as Campos,
  type RelatorioImportacao,
} from '@rota/shared';
import { Girando } from './Carregando';
import { marcarAlteracao } from './alteracoesPendentes';
import { mensagemDoDigitado } from './loteDeImportacao';

const VAZIO: Omit<Campos, 'cdId'> = {
  notaFiscal: '',
  cep: '',
  nome: '',
  pedido: '',
  bairro: '',
  cidade: '',
  endereco: '',
};

/** As colunas na ORDEM da folha do romaneio: o Admin copia a linha da
 * esquerda para a direita, sem procurar onde vai cada coisa. */
const COLUNAS: Array<{ campo: keyof typeof VAZIO; rotulo: string; dica: string; numerico?: boolean; largo?: boolean }> = [
  { campo: 'notaFiscal', rotulo: 'NF do pedido', dica: '165330', numerico: true },
  { campo: 'cep', rotulo: 'CEP (opcional)', dica: '57750-000', numerico: true },
  { campo: 'nome', rotulo: 'Nome do destinatário', dica: 'MARIA DA SILVA', largo: true },
  { campo: 'pedido', rotulo: 'Pedido entrega', dica: '537733613' },
  { campo: 'bairro', rotulo: 'Bairro', dica: 'CENTRO' },
  { campo: 'cidade', rotulo: 'Cidade', dica: 'QUEBRANGULO' },
  { campo: 'endereco', rotulo: 'Endereço', dica: 'RUA DAS FLORES, 43, CASA-PERTO DO MERCADO', largo: true },
];

/** Quem dirige de cada CD — é como a folha diz o CD. */
const MOTORISTA_DO_CD: Record<string, string> = {
  palmeira: 'Caique Santos',
  penedo: 'Paulo Rogério Santos',
};

const MARCA = 'pedido-digitado';

/**
 * Digitar à mão a linha de um romaneio (a que o PDF não trouxe, ou a que veio
 * em papel). Pede SÓ o que a folha tem — pedido do usuário, para ser prático.
 * Depois de salvar, o formulário fica aberto e limpo para a próxima linha,
 * com o mesmo CD.
 */
export function PedidoDigitado({
  cds,
  cdInicial,
  enviar,
  aoFechar,
}: {
  cds: Record<string, CentroDistribuicao>;
  cdInicial: string;
  /** Manda ao servidor e põe no lote (fora do componente: trocar de aba no
   * meio não perde o resultado). */
  enviar: (campos: Campos) => Promise<RelatorioImportacao>;
  aoFechar: () => void;
}) {
  const [cdId, setCdId] = useState(cdInicial);
  const [campos, setCampos] = useState(VAZIO);
  const [erros, setErros] = useState<Partial<Record<CampoDoPedidoDigitado, string>>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState<{ entrou: boolean; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const alterado = Object.values(campos).some((v) => v.trim() !== '');
  useEffect(() => marcarAlteracao(MARCA, alterado), [alterado]);
  useEffect(() => () => marcarAlteracao(MARCA, false), []);

  async function salvar() {
    const corpo = { cdId, ...campos };
    const v = validarPedidoDigitado(corpo);
    if (!v.ok) {
      setErros(v.erros);
      setUltimo(null);
      return;
    }
    setErros({});
    setErro(null);
    setSalvando(true);
    try {
      const relatorio = await enviar(corpo);
      const resultado = mensagemDoDigitado(relatorio, v.pedido.pedido);
      setUltimo(resultado);
      // Entrou: limpa para a próxima linha. Repetido ou recusado: fica o que
      // foi digitado, para conferir.
      if (resultado.entrou) setCampos(VAZIO);
    } catch (e) {
      setErro(
        `${e instanceof Error ? e.message : 'Falha ao salvar'} Salvar de novo é seguro: se já tinha entrado, conta como repetido.`,
      );
    } finally {
      setSalvando(false);
    }
  }

  const opcoes = Object.entries(cds);
  return (
    <form
      className="decisao pedido-digitado"
      onSubmit={(e) => {
        e.preventDefault();
        void salvar();
      }}
    >
      <div className="decisao-cabecalho">
        <strong>Digitar pedido — as colunas da folha do romaneio</strong>
      </div>
      <div className="completar-campos">
        <label>
          <span className="decisao-rotulo">CD (o motorista da folha)</span>
          <select className="filtro" value={cdId} onChange={(e) => setCdId(e.target.value)}>
            <option value="">— escolha —</option>
            {opcoes.map(([id, cd]) => (
              <option key={id} value={id}>
                {cd.nome}
                {MOTORISTA_DO_CD[id] ? ` — ${MOTORISTA_DO_CD[id]}` : ''}
              </option>
            ))}
          </select>
          {erros.cdId && <span className="erro-campo">{erros.cdId}</span>}
        </label>
        {COLUNAS.map((c) => (
          <label key={c.campo} className={c.largo ? 'largo' : undefined}>
            <span className="decisao-rotulo">{c.rotulo}</span>
            <input
              className="filtro"
              inputMode={c.numerico ? 'numeric' : undefined}
              placeholder={c.dica}
              value={campos[c.campo]}
              aria-invalid={erros[c.campo] ? true : undefined}
              onChange={(e) => setCampos({ ...campos, [c.campo]: e.target.value })}
            />
            {erros[c.campo] && <span className="erro-campo">{erros[c.campo]}</span>}
          </label>
        ))}
      </div>

      {erro && <div className="erro">{erro}</div>}
      {ultimo && <div className={ultimo.entrou ? 'sucesso' : 'alerta'} style={{ marginTop: 8 }}>{ultimo.texto}</div>}

      <div className="acoes-rota" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="primaria" disabled={salvando}>
          {salvando ? <Girando texto="SALVANDO…" /> : 'SALVAR PEDIDO'}
        </button>
        <button
          type="button"
          disabled={salvando}
          onClick={() => {
            if (alterado && !window.confirm('Fechar sem salvar o que foi digitado?')) return;
            aoFechar();
          }}
        >
          {ultimo?.entrou && !alterado ? 'PRONTO' : 'FECHAR'}
        </button>
      </div>
    </form>
  );
}

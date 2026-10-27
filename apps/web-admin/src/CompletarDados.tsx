import { Girando } from './Carregando';
import { useEffect, useState } from 'react';
import { telefoneLegivel, type Cliente, type ClienteACompletar, type RevendedoraCandidata } from '@rota/shared';
import { candidatasDoCliente, salvarDadosDoCliente, type DadosDoCliente } from './api';
import { marcarAlteracao } from './alteracoesPendentes';
import {
  camposIniciais,
  clienteDoErp,
  corpoDoFormulario,
  formularioAlterado,
  trocarEscolhida,
  type CamposDoFormulario,
} from './formularioCliente';

/**
 * Formulário do cliente que o romaneio trouxe SEM estar na base de
 * revendedoras: a folha só tem nome e endereço, e o resto do que o app entrega
 * — ligar, avisar a chegada e mandar o recibo pelo WhatsApp, o "como chegar"
 * do dossiê — depende do telefone e da referência que o Admin Estoque põe
 * aqui. Mostra quem tem o mesmo nome na base: se for ela, um toque traz os
 * dados; quem confirma que é a mesma pessoa é o Admin, olhando o endereço.
 *
 * Em cliente que JÁ é do ERP (id = código) a lista não aparece: o "É ela" ali
 * ligava o cliente a OUTRA pessoa, e os pedidos da homônima passavam a cair
 * nele, trocando o endereço a cada romaneio.
 */
export function CompletarDados({
  cliente,
  pendente = true,
  aoConcluir,
  aoCancelar,
}: {
  cliente: ClienteACompletar;
  /** Ainda na lista de "completar dados" (`Cliente.completarDados`). Na aba
   * Clientes o mesmo formulário serve para corrigir quem já está completo. */
  pendente?: boolean;
  /** `corpo` = o que foi mandado (vazio = "não tenho mais dados"). */
  aoConcluir: (atualizado: { id: string } & Cliente, corpo: DadosDoCliente) => void;
  aoCancelar?: () => void;
}) {
  const doErp = clienteDoErp(cliente.id);
  // O formulário compara com o que ABRIU: só o que mudou vai para o servidor.
  const [inicial] = useState(() => camposIniciais(cliente));
  const [campos, setCampos] = useState(inicial);
  const [escolhida, setEscolhida] = useState<RevendedoraCandidata | null>(null);
  /** Os campos como estavam ao escolher: desfazer volta a ELES — o telefone
   * digitado antes do "É ela" não pode sumir no desfazer. */
  const [antesDaEscolha, setAntesDaEscolha] = useState<CamposDoFormulario>(inicial);
  const [candidatas, setCandidatas] = useState<RevendedoraCandidata[] | null>(null);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (doErp) return;
    let vivo = true;
    candidatasDoCliente(cliente.id)
      .then((c) => vivo && setCandidatas(c))
      .catch((e) => vivo && setErroBusca(e instanceof Error ? e.message : 'Falha ao procurar na base'));
    return () => {
      vivo = false;
    };
  }, [cliente.id, doErp]);

  const alterado = formularioAlterado(inicial, campos, escolhida);
  useEffect(() => {
    marcarAlteracao(cliente.id, alterado);
  }, [cliente.id, alterado]);
  // Desmontou (salvou, fechou, trocou de tela já confirmada): nada pendente aqui.
  useEffect(() => () => marcarAlteracao(cliente.id, false), [cliente.id]);

  /** `c` null desfaz a escolha. */
  function escolher(c: RevendedoraCandidata | null) {
    const base = escolhida ? antesDaEscolha : campos;
    if (!escolhida) setAntesDaEscolha(campos);
    setCampos(trocarEscolhida(campos, base, escolhida, c));
    setEscolhida(c);
  }

  async function enviar(dados: DadosDoCliente) {
    setSalvando(true);
    setErro(null);
    try {
      aoConcluir(await salvarDadosDoCliente(cliente.id, dados), dados);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="decisao">
      <div className="decisao-cabecalho">
        <strong>{cliente.nome}</strong>
        {pendente && <span className="chip pendente">só o que veio no romaneio</span>}
      </div>
      <div className="decisao-aviso">{cliente.endereco}</div>

      <div className="completar-campos">
        <label>
          <span className="decisao-rotulo">Telefone (com DDD)</span>
          <input
            className="filtro"
            type="tel"
            inputMode="tel"
            placeholder="(82) 99999-1234"
            value={campos.telefone}
            onChange={(e) => setCampos({ ...campos, telefone: e.target.value })}
          />
        </label>
        <label>
          <span className="decisao-rotulo">Referência — como chegar (o motorista lê no dossiê)</span>
          <textarea
            className="filtro"
            rows={3}
            maxLength={1000}
            value={campos.observacoes}
            onChange={(e) => setCampos({ ...campos, observacoes: e.target.value })}
          />
        </label>
      </div>

      {doErp ? (
        <div className="decisao-aviso" style={{ marginTop: 12 }}>
          Cliente do ERP (cód. {cliente.id}): já é a pessoa do cadastro — aqui só se corrige o telefone e a referência.
        </div>
      ) : (
        <>
          {/* Ligação errada se desfaz: sem isto, o "É ela" salvo por engano
              mandava para sempre os pedidos da homônima para este cliente. */}
          {cliente.codigoErp && (
            <div className="decisao-aviso" style={{ marginTop: 12 }}>
              Ligado à revendedora cód. {cliente.codigoErp}: os pedidos dela caem neste cliente.{' '}
              <button className="ligacao alvo-toque" disabled={salvando} onClick={() => void enviar({ codigo: null })}>
                Não é ela — desligar
              </button>
            </div>
          )}
          <div className="decisao-rotulo" style={{ marginTop: 12 }}>
            Na base de revendedoras com o mesmo nome
          </div>
          {erroBusca && <div className="erro">{erroBusca}</div>}
          {!erroBusca && candidatas === null && <div className="decisao-aviso">Procurando…</div>}
          {candidatas?.length === 0 && (
            <div className="decisao-aviso">
              Ninguém com esse nome na base — preencha à mão. Pedido do site (Consumidor Final) é sempre assim.
            </div>
          )}
          {candidatas && candidatas.length > 0 && (
            <div className="decisao-opcoes">
              {candidatas.map((c) => (
                <div key={c.codigo} className={`decisao-opcao${escolhida?.codigo === c.codigo ? ' ativa' : ''}`}>
                  <div>
                    <div className="decisao-rotulo">
                      cód. {c.codigo}
                      {c.situacao ? ` · ${c.situacao}` : ''} ·{' '}
                      {c.dadosDe ? `pedido de ${dataCurta(c.dadosDe)}` : 'cadastro (sem data)'}
                    </div>
                    <div className="decisao-endereco">{c.endereco}</div>
                    <div className="decisao-aviso">
                      {telefoneLegivel(c.telefone) ?? 'sem telefone'}
                      {c.papel ? ` · ${c.papel}` : ''}
                      {c.referencia ? ` · ${c.referencia}` : ''}
                    </div>
                    {escolhida?.codigo === c.codigo ? (
                      // Desfazer devolve o formulário ao que era antes da escolha:
                      // sem isto, o engano só se corrigia apagando à mão.
                      <button type="button" style={{ marginTop: 8 }} disabled={salvando} onClick={() => escolher(null)}>
                        ESCOLHIDA — DESFAZER
                      </button>
                    ) : (
                      <button type="button" style={{ marginTop: 8 }} disabled={salvando} onClick={() => escolher(c)}>
                        É ELA — USAR ESTES DADOS
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {erro && <div className="erro">{erro}</div>}

      <div className="acoes-rota" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="primaria"
          disabled={salvando}
          onClick={() => void enviar(corpoDoFormulario(inicial, campos, escolhida))}
        >
          {salvando ? <Girando texto="SALVANDO…" /> : 'SALVAR DADOS'}
        </button>
        {/* Sai da lista sem mexer em nada: o pedido do site, por exemplo, não
            tem de onde tirar telefone — e a lista não pode virar ruído. */}
        {pendente && (
          <button disabled={salvando} onClick={() => void enviar({})}>
            NÃO TENHO MAIS DADOS
          </button>
        )}
        {aoCancelar && (
          <button
            disabled={salvando}
            onClick={() => (!alterado || window.confirm('Descartar o que foi digitado para este cliente?')) && aoCancelar()}
          >
            FECHAR
          </button>
        )}
      </div>
    </div>
  );
}

/** "2026-09-01T00:00:00-03:00" → "01/09/2026", sem passar pelo fuso do navegador. */
function dataCurta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Impede que UM pedaço quebrado apague o app no meio da rua.
 *
 * Sem ninguém pegando a exceção, o React desmonta a árvore inteira e a tela
 * fica PRETA — sem mensagem e sem pista, com o motorista de pé na porta do
 * cliente. É o pior desfecho possível neste app: pior que um mapa errado é um
 * app que sumiu.
 *
 * O mapa é a parte que mais tem como quebrar (WebGL, PMTiles no OPFS, GPS,
 * biblioteca de terceiro) e é a MENOS essencial: dá para entregar com a lista
 * de paradas e o endereço escrito. Por isso ele fica isolado aqui dentro —
 * quebra sozinho, e confirmar entrega continua funcionando.
 *
 * Nada de recarregar sozinho: a regra da casa é que nada decide sozinho no meio
 * do trabalho de campo. O botão existe, quem aperta é o motorista.
 */
type Props = {
  /** O que estava sendo mostrado, em português, para aparecer no aviso. */
  oQue: string;
  /** `false` na raiz do app, onde não há "resto da tela" a prometer. */
  isolado?: boolean;
  children: ReactNode;
};

type Estado = { erro: Error | null };

export class LimiteDeErro extends Component<Props, Estado> {
  state: Estado = { erro: null };

  static getDerivedStateFromError(erro: Error): Estado {
    return { erro };
  }

  componentDidCatch(erro: Error, info: ErrorInfo) {
    console.error(`[limite-de-erro] ${this.props.oQue}`, erro, info.componentStack);
  }

  render() {
    const { erro } = this.state;
    const { oQue, isolado = true } = this.props;
    if (!erro) return this.props.children;
    return (
      <div className="tela-quebrou">
        <strong>{oQue} parou de funcionar.</strong>
        <p>
          {isolado
            ? 'Dá para continuar a entrega normalmente pela lista de paradas.'
            : 'Suas entregas confirmadas estão salvas. Toque para recarregar.'}
        </p>
        <button
          type="button"
          onClick={() => (isolado ? this.setState({ erro: null }) : location.reload())}
        >
          {isolado ? 'Tentar mostrar de novo' : 'Recarregar o app'}
        </button>
      </div>
    );
  }
}

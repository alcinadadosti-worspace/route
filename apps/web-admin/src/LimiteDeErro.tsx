import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Impede que UM pedaço quebrado apague o painel inteiro.
 *
 * Sintoma que originou isto: o marcador do motorista entrava no mapa sem
 * coordenada, o MapLibre estourava, e o React — que desmonta a árvore toda
 * quando ninguém pega a exceção — deixava a aba PRETA. O operador perdia a
 * tabela de rotas, a importação e o acompanhamento por causa de um marcador.
 *
 * A regra da casa vale aqui: guarda avisa, não bloqueia. O que quebrou fica
 * isolado num aviso, com o nome do que falhou e um botão de tentar de novo — e
 * o resto da tela continua servindo. Erro de render costuma ser transitório
 * (um doc torto que a próxima leitura corrige), por isso "tentar de novo"
 * resolve sem recarregar a página e sem perder o que estava aberto.
 */
type Props = {
  /** O que estava sendo mostrado, em português, para aparecer no aviso. */
  oQue: string;
  /**
   * `false` só na raiz da aplicação, onde não há "resto da tela" para prometer
   * que continua de pé — prometer isso ali seria mentira, e aí a saída é
   * recarregar.
   */
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
    // O console é o que sobra para diagnosticar: a mensagem na tela é curta de
    // propósito, mas o rastro precisa estar inteiro em algum lugar.
    console.error(`[limite-de-erro] ${this.props.oQue}`, erro, info.componentStack);
  }

  render() {
    const { erro } = this.state;
    const { oQue, isolado = true } = this.props;
    if (!erro) return this.props.children;
    return (
      <div className="alerta">
        <strong>{oQue} não pôde ser exibido.</strong>{' '}
        {isolado
          ? 'O resto da tela continua funcionando.'
          : 'Recarregue a página; se voltar a acontecer, avise o suporte.'}
        <div className="detalhe-erro">{erro.message}</div>
        {isolado ? (
          <button type="button" className="secundario" onClick={() => this.setState({ erro: null })}>
            Tentar de novo
          </button>
        ) : (
          <button type="button" className="secundario" onClick={() => location.reload()}>
            Recarregar
          </button>
        )}
      </div>
    );
  }
}

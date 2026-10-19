/**
 * Campo de busca com lupa — o mesmo nas três listas que pedem busca
 * (montagem, "Fora da montagem" e aba Pedidos). A lupa é SVG com
 * `currentColor`: segue o tema sem depender de fonte de emoji.
 */
export function CampoBusca({
  valor,
  aoMudar,
  placeholder,
  rotulo,
}: {
  valor: string;
  aoMudar: (valor: string) => void;
  placeholder: string;
  rotulo: string;
}) {
  return (
    <label className="campo-busca">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
        <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        className="filtro"
        aria-label={rotulo}
        placeholder={placeholder}
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
      />
    </label>
  );
}

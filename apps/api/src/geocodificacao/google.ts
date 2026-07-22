import { normalizar, type EnderecoFiscal, type GeoPonto } from '@rota/shared';

/**
 * Geocodificação automática (seção 9, passo 3) — Google Geocoding API.
 * Só é consultada para endereço urbano plausível de cliente ainda sem
 * coordenada; com o cache permanente por cliente (a coordenada fica no
 * cadastro), cada endereço é geocodificado no máximo uma vez na vida.
 */

export interface ResultadoGeocodificacao {
  coordenada: GeoPonto;
  /** true = precisão de endereço/rua dentro do município esperado. */
  precisa: boolean;
}

export interface Geocodificador {
  geocodificar(endereco: EnderecoFiscal): Promise<ResultadoGeocodificacao | null>;
}

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

export function criarGeocodificadorGoogle(
  chave: string | undefined = process.env.GOOGLE_MAPS_API_KEY,
): Geocodificador | null {
  if (!chave) return null;

  return {
    async geocodificar(endereco: EnderecoFiscal): Promise<ResultadoGeocodificacao | null> {
      const texto = [
        `${endereco.logradouro}, ${endereco.numero}`,
        endereco.bairro,
        `${endereco.municipio} - ${endereco.uf}`,
        formatarCep(endereco.cep),
        'Brasil',
      ]
        .filter(Boolean)
        .join(', ');

      const parametros = new URLSearchParams({ address: texto, region: 'br', key: chave });
      const resposta = await fetch(`${ENDPOINT}?${parametros.toString()}`);
      if (!resposta.ok) return null;

      const corpo: any = await resposta.json();
      const resultado = corpo?.results?.[0];
      if (corpo?.status !== 'OK' || !resultado) return null;

      const local = resultado.geometry?.location;
      if (typeof local?.lat !== 'number' || typeof local?.lng !== 'number') return null;

      // Precisão "endereço/rua": tudo que não for centroide aproximado (nível cidade).
      const tipoPrecisao = String(resultado.geometry?.location_type ?? 'APPROXIMATE');
      const nivelEndereco = tipoPrecisao !== 'APPROXIMATE';

      // Dentro do município esperado? (resultado fora do município é ponto errado
      // com cara de certo — vira pendente de mapeamento.)
      const municipioEsperado = normalizar(endereco.municipio);
      const componentes: any[] = resultado.address_components ?? [];
      const municipioBate = componentes.some(
        (c) =>
          (c.types?.includes('administrative_area_level_2') || c.types?.includes('locality')) &&
          normalizar(String(c.long_name ?? '')) === municipioEsperado,
      );

      return {
        coordenada: { lat: local.lat, lng: local.lng },
        precisa: nivelEndereco && municipioBate,
      };
    },
  };
}

function formatarCep(cep: string): string {
  const digitos = cep.replace(/\D/g, '');
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : cep;
}

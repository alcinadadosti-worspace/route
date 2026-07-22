import { XMLParser } from 'fast-xml-parser';
import {
  clienteIdDeDocumento,
  mascararDocumento,
  normalizarTelefone,
  extrairPedidoELote,
  type EnderecoFiscal,
  type ItemPedido,
} from '@rota/shared';

/**
 * Parser e validação de NF-e (seção 8).
 * Entrada: XML `nfeProc` modelo 55. Validações antes de aceitar:
 * estrutura parseável, mod=55, protNFe com cStat=100 (autorizada).
 */

export interface NotaImportada {
  chaveAcesso: string;
  numeroNota: number;
  serie: number;
  emitidoEm: string;
  destinatario: {
    clienteId: string;
    nome: string;
    documentoMascarado: string;
    telefone: string | null;
    email: string | null;
    enderecoFiscal: EnderecoFiscal;
  };
  itens: ItemPedido[];
  valorTotal: number;
  volumes: number;
  pesoBrutoKg: number;
  numeroPedido: string | null;
  lote: string | null;
}

export type ResultadoParse =
  | { ok: true; nota: NotaImportada }
  | { ok: false; motivo: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Tudo como string: preserva chave de acesso, CEP e códigos com zeros à esquerda.
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'det' || name === 'vol',
  removeNSPrefix: true,
});

export async function parseNfe(xml: string): Promise<ResultadoParse> {
  let doc: any;
  try {
    doc = parser.parse(xml, true);
  } catch {
    return { ok: false, motivo: 'XML não parseável' };
  }

  const proc = doc?.nfeProc;
  if (!proc) return { ok: false, motivo: 'Arquivo não é um nfeProc (NF-e processada)' };

  const infNFe = proc?.NFe?.infNFe;
  if (!infNFe) return { ok: false, motivo: 'Estrutura NFe/infNFe ausente' };

  const ide = infNFe.ide ?? {};
  if (String(ide.mod) !== '55') {
    return { ok: false, motivo: `Modelo ${ide.mod ?? '?'} não suportado (esperado 55)` };
  }

  const cStat = String(proc?.protNFe?.infProt?.cStat ?? '');
  if (cStat !== '100') {
    return { ok: false, motivo: `Nota não autorizada (cStat=${cStat || 'ausente'})` };
  }

  const chaveAcesso = String(infNFe['@_Id'] ?? '').replace(/^NFe/, '');
  if (!/^\d{44}$/.test(chaveAcesso)) {
    return { ok: false, motivo: 'Chave de acesso inválida' };
  }

  const dest = infNFe.dest ?? {};
  const documento = String(dest.CPF ?? dest.CNPJ ?? '');
  if (!documento) return { ok: false, motivo: 'Destinatário sem CPF/CNPJ' };

  const ender = dest.enderDest ?? {};
  const enderecoFiscal: EnderecoFiscal = {
    logradouro: String(ender.xLgr ?? ''),
    numero: String(ender.nro ?? ''),
    complemento: ender.xCpl ? String(ender.xCpl) : undefined,
    bairro: String(ender.xBairro ?? ''),
    municipio: String(ender.xMun ?? ''),
    uf: String(ender.UF ?? ''),
    cep: String(ender.CEP ?? ''),
  };

  const dets: any[] = infNFe.det ?? [];
  const itens: ItemPedido[] = dets.map((d) => ({
    codigo: String(d?.prod?.cProd ?? ''),
    descricao: String(d?.prod?.xProd ?? ''),
    quantidade: Number(d?.prod?.qCom ?? 0),
  }));

  const vols: any[] = infNFe.transp?.vol ?? [];
  const volumes = vols.reduce((s, v) => s + Number(v?.qVol ?? 0), 0);
  const pesoBrutoKg = vols.reduce((s, v) => s + Number(v?.pesoB ?? 0), 0);

  const { numeroPedido, lote } = extrairPedidoELote(infNFe.infAdic?.infCpl);

  return {
    ok: true,
    nota: {
      chaveAcesso,
      numeroNota: Number(ide.nNF ?? 0),
      serie: Number(ide.serie ?? 0),
      emitidoEm: String(ide.dhEmi ?? ''),
      destinatario: {
        clienteId: await clienteIdDeDocumento(documento),
        nome: String(dest.xNome ?? ''),
        documentoMascarado: mascararDocumento(documento),
        telefone: normalizarTelefone(ender.fone ? String(ender.fone) : null),
        email: dest.email ? String(dest.email) : null,
        enderecoFiscal,
      },
      itens,
      valorTotal: Number(infNFe.total?.ICMSTot?.vNF ?? 0),
      volumes,
      pesoBrutoKg,
      numeroPedido,
      lote,
    },
  };
}

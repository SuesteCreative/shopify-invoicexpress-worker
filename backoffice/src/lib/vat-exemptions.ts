/**
 * A ordem e a redacção da tabela de códigos de motivo de isenção da AT, a que
 * está em vigor desde julho de 2022 (M03 e M08 foram suprimidos: o M08 passou a
 * desdobrar-se nos M30-M34 e M40-M43).
 *
 * Estava espalhada por dez páginas de integração, cada uma com a sua cópia de
 * doze linhas, e faltavam lá as autoliquidações todas, que são precisamente as
 * que um comerciante que venda a empresas de outro país precisa de escolher.
 * Fica aqui uma vez só.
 *
 * O que vai para o documento é o CÓDIGO; a etiqueta é só para a pessoa o
 * reconhecer. Só é aplicado quando a linha fica a 0%.
 */
export const VAT_EXEMPTION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: "M01", label: "Artigo 16.º, n.º 6 do CIVA" },
    { value: "M02", label: "Artigo 6.º do Decreto-Lei n.º 198/90, de 19 de junho" },
    { value: "M04", label: "Isento artigo 13.º do CIVA" },
    { value: "M05", label: "Isento artigo 14.º do CIVA" },
    { value: "M06", label: "Isento artigo 15.º do CIVA" },
    { value: "M07", label: "Isento artigo 9.º do CIVA" },
    { value: "M09", label: "IVA – não confere direito a dedução (artigo 62.º alínea b) do CIVA)" },
    { value: "M10", label: "Regime especial de isenção artigo 53.º do CIVA" },
    { value: "M11", label: "Regime particular do tabaco (Decreto-Lei n.º 346/85)" },
    { value: "M12", label: "Regime da margem de lucro – Agências de viagens" },
    { value: "M13", label: "Regime da margem de lucro – Bens em segunda mão" },
    { value: "M14", label: "Regime da margem de lucro – Objetos de arte" },
    { value: "M15", label: "Regime da margem de lucro – Objetos de coleção e antiguidades" },
    { value: "M16", label: "Isento artigo 14.º do RITI" },
    { value: "M19", label: "Outras isenções temporárias, em diploma próprio" },
    { value: "M20", label: "IVA – regime forfetário (artigo 59.º-D n.º 2 do CIVA)" },
    { value: "M21", label: "IVA – não confere direito à dedução (artigo 72.º n.º 4 do CIVA)" },
    { value: "M25", label: "Mercadorias à consignação (artigo 38.º n.º 1 alínea a) do CIVA)" },
    { value: "M30", label: "IVA – autoliquidação: sucatas e resíduos (artigo 2.º n.º 1 alínea i))" },
    { value: "M31", label: "IVA – autoliquidação: construção civil (artigo 2.º n.º 1 alínea j))" },
    { value: "M32", label: "IVA – autoliquidação: direitos de emissão (artigo 2.º n.º 1 alínea l))" },
    { value: "M33", label: "IVA – autoliquidação: cortiça e madeira (artigo 2.º n.º 1 alínea m))" },
    { value: "M34", label: "IVA – autoliquidação: eletricidade em autoconsumo (artigo 2.º n.º 1 alínea n))" },
    { value: "M40", label: "IVA – autoliquidação: serviços a sujeito passivo de outro país (artigo 6.º n.º 6 alínea a), a contrário)" },
    { value: "M41", label: "IVA – autoliquidação: operações triangulares (artigo 8.º n.º 3 do RITI)" },
    { value: "M42", label: "IVA – autoliquidação: imóveis com renúncia (Decreto-Lei n.º 21/2007)" },
    { value: "M43", label: "IVA – autoliquidação: ouro para investimento (Decreto-Lei n.º 362/99)" },
    { value: "M44", label: "Não sujeito: operação não localizada em Portugal (artigo 6.º do CIVA)" },
    { value: "M45", label: "Regime transfronteiriço de isenção (artigo 58.º-A do CIVA)" },
    { value: "M46", label: "Bens em bagagem de viajante fora da UE, e-TaxFree (Decreto-Lei n.º 19/2017)" },
    { value: "M99", label: "Não sujeito; não tributado (ou similar)" },
];

/** O código por defeito, quando uma ligação nunca escolheu nenhum. */
export const DEFAULT_VAT_EXEMPTION = "M01";

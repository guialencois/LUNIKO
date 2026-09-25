// Parte de scripts/effects-spec: MODELO DE TIPOS usado por run.sh --types.
// Só as funções que o código usa, com a forma de tipo do drizzle-orm 0.33:
// comparações aceitam valor OU coluna/SQL do mesmo tipo; `sql<T>` carrega o
// tipo do que produz; `.mapWith(coluna)` decodifica como a coluna decodifica.
declare module "drizzle-orm" {
  export interface SQL<T = unknown> {
    readonly __sql: true;
    readonly __t?: T;
    mapWith<U>(decoder: { readonly __t?: U }): SQL<U>;
  }
  export function sql<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SQL<T>;
  export function and(...c: (SQL | undefined)[]): SQL;
  export function or(...c: (SQL | undefined)[]): SQL;
  // O tipo vem SÓ da coluna (como no drizzle real: GetColumnData<TColumn>);
  // o valor não participa da inferência — senão "bogus" alargaria T.
  type Only<T> = [T][T extends unknown ? 0 : never];
  export function eq<T>(col: { readonly __t?: T }, v: Only<T> | { readonly __t?: Only<T> }): SQL;
  export function lt<T>(col: { readonly __t?: T }, v: Only<T> | { readonly __t?: Only<T> }): SQL;
  export function inArray<T>(col: { readonly __t?: T }, v: Only<T>[]): SQL;
  export function isNull(col: { readonly __t?: unknown }): SQL;
  export function isNotNull(col: { readonly __t?: unknown }): SQL;
  export function desc(col: { readonly __t?: unknown }): SQL;
}

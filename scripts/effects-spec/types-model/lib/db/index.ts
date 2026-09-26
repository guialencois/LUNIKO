// Parte de scripts/effects-spec: MODELO DE TIPOS usado por run.sh --types.
// MODELO DE TIPOS do cliente Drizzle: resultados são ARRAYS de linhas (logo,
// desestruturar dá `Row | undefined` sob noUncheckedIndexedAccess), inserts
// tipados pelos enums das colunas, `.for()` só com as forças do Postgres.
// Uma projeção pode trazer colunas, fragmentos sql<T> e TABELAS inteiras
// (select({ op: effectOperations, ... }) -> { op: EffectOperationRow, ... }).
import type { Table } from "./schema";
type AnyTable = Table<any, any, any>;
type Picked<V> = V extends Table<infer R, any, any> ? R : V extends { readonly __t?: infer T } ? T : never;
type Projected<P> = { [K in keyof P]: Picked<P[K]> };
export interface SelectQ<R> extends PromiseLike<R[]> {
  where(c: unknown): SelectQ<R>; limit(n: number): SelectQ<R>; orderBy(...c: unknown[]): SelectQ<R>;
  innerJoin(t: AnyTable, on: unknown): SelectQ<R>;
  for(strength: "update" | "no key update" | "share" | "key share", config?: { skipLocked?: boolean; noWait?: boolean }): SelectQ<R>;
}
interface From<P> { from<T extends AnyTable>(t: T): SelectQ<P extends undefined ? T["__row"] : Projected<P>> }
interface InsertQ<R> extends PromiseLike<void> {
  onConflictDoNothing(cfg?: { target?: unknown }): InsertQ<R>;
  returning(): PromiseLike<R[]>;
}
interface UpdateQ<R, I> { set(v: Partial<I>): { where(c: unknown): PromiseLike<void> & { returning(): PromiseLike<R[]> } } }
interface DeleteQ<R> {
  where(c: unknown): PromiseLike<void> & {
    returning(): PromiseLike<R[]>;
    returning<P extends Record<string, unknown>>(p: P): PromiseLike<Projected<P>[]>;
  };
}
export interface Tx {
  select(): From<undefined>;
  select<P extends Record<string, unknown>>(p: P): From<P>;
  insert<T extends AnyTable>(t: T): { values(v: T["__insert"]): InsertQ<T["__row"]> };
  update<T extends AnyTable>(t: T): UpdateQ<T["__row"], T["__insert"]>;
  delete<T extends AnyTable>(t: T): DeleteQ<T["__row"]>;
}
export interface DB extends Tx { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }
export declare const db: DB;

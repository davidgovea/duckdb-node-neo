import duckdb from '@duckdb/node-bindings';
import { DuckDBExpression } from './DuckDBExpression';

export class DuckDBBindInfo {
  private readonly bind_info: duckdb.BindInfo;
  
  constructor(bind_info: duckdb.BindInfo) {
    this.bind_info = bind_info;
  }
  
  public get argumentCount(): number {
    return duckdb.scalar_function_bind_get_argument_count(this.bind_info);
  }
  
  public getArgument(index: number): DuckDBExpression {
    const expr = duckdb.scalar_function_bind_get_argument(this.bind_info, index);
    return new DuckDBExpression(expr);
  }
  
  public setError(error: string) {
    duckdb.scalar_function_bind_set_error(this.bind_info, error);
  }
}

import duckdb from '@duckdb/node-bindings';
import { DuckDBLogicalType } from './DuckDBLogicalType';
import { DuckDBType } from './DuckDBType';
import { DuckDBValue } from './values';

/**
 * Represents a DuckDB expression handle.
 * Expressions are typically accessed through bind info in scalar functions.
 */
export class DuckDBExpression {
  private readonly expression: duckdb.Expression;

  constructor(expression: duckdb.Expression) {
    this.expression = expression;
  }

  /**
   * Gets the return type of this expression.
   */
  public get returnType(): DuckDBType {
    const logicalType = DuckDBLogicalType.create(
      duckdb.expression_return_type(this.expression)
    );
    return logicalType.asType();
  }

  /**
   * Checks if this expression can be folded to a constant value.
   */
  public get isFoldable(): boolean {
    return duckdb.expression_is_foldable(this.expression);
  }

  /**
   * Folds this expression to a constant value.
   * Only works if isFoldable is true.
   *
   * @param context The client context to use for folding
   * @returns The folded value as a native DuckDB value handle
   */
  public fold(context: duckdb.ClientContext): duckdb.Value {
    return duckdb.expression_fold(context, this.expression);
  }
}

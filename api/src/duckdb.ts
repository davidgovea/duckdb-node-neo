export {
  arrow_c_array_create,
  arrow_c_array_release,
  arrow_c_schema_create,
  arrow_c_schema_release,
  data_chunk_from_arrow,
  destroy_arrow_converted_schema,
  double_to_hugeint,
  double_to_uhugeint,
  hugeint_to_double,
  schema_from_arrow,
  uhugeint_to_double
} from '@duckdb/node-bindings';

export type {
  ArrowArray,
  ArrowArrayDesc,
  ArrowBufferRef,
  ArrowConvertedSchema,
  ArrowSchema,
  ArrowSchemaDesc
} from '@duckdb/node-bindings';
export * from './configurationOptionDescriptions';
export * from './createDuckDBValueConverter';
export * from './DuckDBAppender';
export * from './DuckDBConnection';
export * from './DuckDBDataChunk';
export * from './DuckDBExtractedStatements';
export * from './DuckDBFunctionInfo';
export * from './DuckDBInstance';
export * from './DuckDBInstanceCache';
export * from './DuckDBLogicalType';
export * from './DuckDBMaterializedResult';
export * from './DuckDBPendingResult';
export * from './DuckDBPreparedStatement';
export * from './DuckDBPreparedStatementCollection';
export * from './DuckDBResult';
export * from './DuckDBResultReader';
export * from './DuckDBScalarFunction';
export * from './DuckDBType';
export * from './DuckDBTypeId';
export * from './DuckDBValueConverter';
export * from './DuckDBValueConverters';
export * from './DuckDBVector';
export * from './appendArrowCData';
export * from './enums';
export * from './JS';
export * from './JSDuckDBValueConverter';
export * from './Json';
export * from './JsonDuckDBValueConverter';
export * from './sql';
export * from './values';
export * from './version';

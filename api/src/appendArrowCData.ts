import duckdb from '@duckdb/node-bindings';
import { DuckDBConnection } from './DuckDBConnection';
import { DuckDBDataChunk } from './DuckDBDataChunk';

export async function appendArrowCData(
  connection: DuckDBConnection,
  appender: duckdb.Appender,
  schema: duckdb.ArrowSchema,
  batches: readonly duckdb.ArrowArray[]
): Promise<void> {
  const converted = duckdb.schema_from_arrow(
    connection.nativeConnection,
    schema
  );
  try {
    for (const batch of batches) {
      try {
        const chunk = DuckDBDataChunk.fromArrow(
          connection,
          batch,
          converted
        );
        duckdb.append_data_chunk(appender, chunk.chunk);
      } finally {
        duckdb.arrow_c_array_release(batch);
      }
    }
  } finally {
    duckdb.destroy_arrow_converted_schema(converted);
  }
}

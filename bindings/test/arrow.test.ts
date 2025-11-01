import duckdb from '@duckdb/node-bindings';
import { expect, suite, test } from 'vitest';
import { expectResult } from './utils/expectResult';
import { INTEGER, VARCHAR } from './utils/expectedLogicalTypes';
import { data } from './utils/expectedVectors';
import { withConnection } from './utils/withConnection';

suite('arrow c data', () => {
  test('simple integer', async () => {
    await withConnection(async (connection) => {
      await duckdb.query(connection, 'create table arrow_target(i integer)');
      const appender = duckdb.appender_create(connection, null, 'arrow_target');
      const schema_desc: duckdb.ArrowSchemaDesc = {
        format: '+s',
        children: [
          {
            format: 'i',
            name: 'i',
          },
        ],
      };
      const schema = duckdb.arrow_c_schema_create(schema_desc);
      const converted = duckdb.schema_from_arrow(connection, schema);
      const batch_desc: duckdb.ArrowArrayDesc = {
        length: 3,
        null_count: 1,
        buffers: [
          new Uint8Array([0b00000101]), // validity
          new Int32Array([11, 22, 33]), // data
        ],
      };
      const batch = duckdb.arrow_c_array_create(batch_desc);
      const chunk = duckdb.data_chunk_from_arrow(connection, batch, converted);
      duckdb.append_data_chunk(appender, chunk);
      duckdb.arrow_c_array_release(batch);
      duckdb.appender_flush_sync(appender);
      duckdb.appender_close_sync(appender);
      const result = await duckdb.query(connection, 'from arrow_target');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 3,
        columns: [
          { name: 'i', logicalType: INTEGER },
        ],
        chunks: [
          { rowCount: 3, vectors: [data(4, [true, false, true], [11, null, 33])] },
        ],
      });
      duckdb.destroy_arrow_converted_schema(converted);
      duckdb.arrow_c_schema_release(schema);
    });
  });

  test('simple varchar', async () => {
    await withConnection(async (connection) => {
      await duckdb.query(connection, 'create table arrow_target(v varchar)');
      const appender = duckdb.appender_create(connection, null, 'arrow_target');
      const schema_desc: duckdb.ArrowSchemaDesc = {
        format: '+s',
        children: [
          {
            format: 'u',
            name: 'v',
          },
        ],
      };
      const schema = duckdb.arrow_c_schema_create(schema_desc);
      const converted = duckdb.schema_from_arrow(connection, schema);
      const offsets = new Int32Array([0, 3, 3, 6]);
      const data_buffer = new Uint8Array(Buffer.from('ABCDEF'));
      const batch_desc: duckdb.ArrowArrayDesc = {
        length: 3,
        null_count: 1,
        buffers: [
          new Uint8Array([0b00000101]), // validity
          offsets, // offsets
          data_buffer, // data
        ],
      };
      const batch = duckdb.arrow_c_array_create(batch_desc);
      const chunk = duckdb.data_chunk_from_arrow(connection, batch, converted);
      duckdb.append_data_chunk(appender, chunk);
      duckdb.arrow_c_array_release(batch);
      duckdb.appender_flush_sync(appender);
      duckdb.appender_close_sync(appender);
      const result = await duckdb.query(connection, 'from arrow_target');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 3,
        columns: [
          { name: 'v', logicalType: VARCHAR },
        ],
        chunks: [
          { rowCount: 3, vectors: [data(16, [true, false, true], ['ABC', null, 'DEF'])] },
        ],
      });
      duckdb.destroy_arrow_converted_schema(converted);
      duckdb.arrow_c_schema_release(schema);
    });
  });

  test('error: invalid schema', async () => {
    await withConnection(async (connection) => {
      const schema_desc: duckdb.ArrowSchemaDesc = {
        format: '+s',
        children: [
          {
            format: 'bogus',
            name: 'i',
          },
        ],
      };
      const schema = duckdb.arrow_c_schema_create(schema_desc);
      expect(() => duckdb.schema_from_arrow(connection, schema))
        .toThrowError(/Unsupported Internal Arrow Type bogus/);
      duckdb.arrow_c_schema_release(schema);
    });
  });
});
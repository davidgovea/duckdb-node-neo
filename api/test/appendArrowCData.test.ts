import * as duckdb from '../src';
import { testBindings } from '@duckdb/node-bindings/test/all';
import { expect, suite, test } from 'vitest';

suite('appendArrowCData', () => {
  test('simple integer', async () => {
    const instance = await duckdb.DuckDBInstance.create();
    const conn = await instance.connect();
    await conn.run('create table arrow_target(i integer)');
    const appender = await conn.createAppender(null, 'arrow_target');
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
    const batch_desc: duckdb.ArrowArrayDesc = {
      length: 3,
      null_count: 1,
      buffers: [
        new Uint8Array([0b00000101]), // validity
        new Int32Array([11, 22, 33]), // data
      ],
    };
    const batch = duckdb.arrow_c_array_create(batch_desc);
    await duckdb.appendArrowCData(conn, appender, schema, [batch]);
    await appender.flush();
    await appender.close();
    const results = await conn.run('from arrow_target');
    expect(await results.fetchAll()).toEqual([
      { i: 11 },
      { i: null },
      { i: 33 },
    ]);
    duckdb.arrow_c_schema_release(schema);
  });

  test('simple varchar', async () => {
    const instance = await duckdb.DuckDBInstance.create();
    const conn = await instance.connect();
    await conn.run('create table arrow_target(v varchar)');
    const appender = await conn.createAppender(null, 'arrow_target');
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
    await duckdb.appendArrowCData(conn, appender, schema, [batch]);
    await appender.flush();
    await appender.close();
    const results = await conn.run('from arrow_target');
    expect(await results.fetchAll()).toEqual([
      { v: 'ABC' },
      { v: null },
      { v: 'DEF' },
    ]);
    duckdb.arrow_c_schema_release(schema);
    conn.close();
  });
});
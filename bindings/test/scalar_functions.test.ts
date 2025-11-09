import duckdb from '@duckdb/node-bindings';
import { expect, suite, test } from 'vitest';
import { data } from './utils/expectedVectors';
import { expectResult } from './utils/expectResult';
import { withConnection } from './utils/withConnection';

suite('scalar functions', () => {
  test('create', () => {
    const scalar_function = duckdb.create_scalar_function();
    expect(scalar_function).toBeTruthy();
  });
  test('set name', () => {
    const scalar_function = duckdb.create_scalar_function();
    duckdb.scalar_function_set_name(scalar_function, 'my_func');
  });
  test('set return type', () => {
    const scalar_function = duckdb.create_scalar_function();
    const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
    duckdb.scalar_function_set_return_type(scalar_function, int_type);
  });
  test('register & run (no extra info)', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, input, output) => {
          const rowCount = duckdb.data_chunk_get_size(input);
          for (let i = 0; i < rowCount; i++) {
            duckdb.vector_assign_string_element(output, i, `output_${i}`);
          }
        }
      );
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select my_func()');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          { name: 'my_func()', logicalType: { typeId: duckdb.Type.VARCHAR } },
        ],
        chunks: [{ rowCount: 1, vectors: [data(16, [true], ['output_0'])] }],
      });
    });
  });
  test('register & run (extra info)', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_function(
        scalar_function,
        (info, input, output) => {
          const extra_info = duckdb.scalar_function_get_extra_info(info);
          const rowCount = duckdb.data_chunk_get_size(input);
          for (let i = 0; i < rowCount; i++) {
            duckdb.vector_assign_string_element(
              output,
              i,
              `output_${i}_${JSON.stringify(extra_info)}`
            );
          }
        }
      );
      duckdb.scalar_function_set_extra_info(scalar_function, { 'my_extra_info_key': 'my_extra_info_value' });
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select my_func()');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          { name: 'my_func()', logicalType: { typeId: duckdb.Type.VARCHAR } },
        ],
        chunks: [
          {
            rowCount: 1,
            vectors: [
              data(
                16,
                [true],
                ['output_0_{"my_extra_info_key":"my_extra_info_value"}']
              ),
            ],
          },
        ],
      });
    });
  });
  test('error handling', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, _input, _output) => {
          throw new Error('my_error');
        }
      );
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      await expect(
        duckdb.query(connection, 'select my_func()')
      ).rejects.toThrow('Invalid Input Error: my_error');
    });
  });
  test('parameters (fixed, volatile)', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      duckdb.scalar_function_add_parameter(scalar_function, varchar_type);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_volatile(scalar_function);
      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, input, output) => {
          const rowCount = duckdb.data_chunk_get_size(input);
          const vec0 = duckdb.data_chunk_get_vector(input, 0);
          const data0 = duckdb.vector_get_data(vec0, rowCount * 4);
          const dv0 = new DataView(data0.buffer);
          const vec1 = duckdb.data_chunk_get_vector(input, 1);
          const data1 = duckdb.vector_get_data(vec1, rowCount * 16);
          const dv1 = new DataView(data1.buffer);
          for (let i = 0; i < rowCount; i++) {
            duckdb.vector_assign_string_element(
              output,
              i,
              `output_${i}_${dv0.getInt32(i * 4, true)}_${dv1.getUint32(
                i * 16,
                true
              )}`
            );
          }
        }
      );
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(
        connection,
        "select my_func(42, 'duck') as my_func_result from range(3)"
      );
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 3,
        columns: [
          {
            name: 'my_func_result',
            logicalType: { typeId: duckdb.Type.VARCHAR },
          },
        ],
        chunks: [
          {
            rowCount: 3,
            vectors: [
              data(
                16,
                [true, true, true],
                ['output_0_42_4', 'output_1_42_4', 'output_2_42_4']
              ),
            ],
          },
        ],
      });
    });
  });
  test('parameters (varargs, volatile)', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_set_varargs(scalar_function, int_type);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_volatile(scalar_function);
      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, input, output) => {
          const rowCount = duckdb.data_chunk_get_size(input);
          const paramCount = duckdb.data_chunk_get_column_count(input);

          for (let r = 0; r < rowCount; r++) {
            const params: number[] = [];
            for (let p = 0; p < paramCount; p++) {
              const vec = duckdb.data_chunk_get_vector(input, p);
              const data = duckdb.vector_get_data(vec, rowCount * 4);
              const dv = new DataView(data.buffer);
              params.push(dv.getInt32(r * 4, true));
            }
            duckdb.vector_assign_string_element(
              output,
              r,
              `output_${r}_${params.join('_')}`
            );
          }
        }
      );
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(
        connection,
        'select my_func(11, 13, 17) as my_func_result from range(3)'
      );
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 3,
        columns: [
          {
            name: 'my_func_result',
            logicalType: { typeId: duckdb.Type.VARCHAR },
          },
        ],
        chunks: [
          {
            rowCount: 3,
            vectors: [
              data(
                16,
                [true, true, true],
                ['output_0_11_13_17', 'output_1_11_13_17', 'output_2_11_13_17']
              ),
            ],
          },
        ],
      });
    });
  });
  test('special handling', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'my_func');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);
      duckdb.scalar_function_set_special_handling(scalar_function);
      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, input, output) => {
          const rowCount = duckdb.data_chunk_get_size(input);
          for (let i = 0; i < rowCount; i++) {
            duckdb.vector_assign_string_element(
              output,
              i,
              `output_is_not_null`
            );
          }
        }
      );
      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select my_func(NULL)');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          {
            name: 'my_func(NULL)',
            logicalType: { typeId: duckdb.Type.VARCHAR },
          },
        ],
        // Without special handling, this would be NULL
        chunks: [
          { rowCount: 1, vectors: [data(16, [true], ['output_is_not_null'])] },
        ],
      });
    });
  });

  test('expression functions - bind callback with argument access', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'test_expr_func');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      
      // Add parameter BEFORE bind callback
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);

      let arg_type_verified = false;
      let is_foldable_checked = false;

      duckdb.scalar_function_set_bind(scalar_function, (bind_info) => {
        const arg_count = duckdb.scalar_function_bind_get_argument_count(bind_info);

        if (arg_count > 0) {
          const expr = duckdb.scalar_function_bind_get_argument(bind_info, 0);
          const return_type = duckdb.expression_return_type(expr);
          const type_id = duckdb.get_type_id(return_type);
          arg_type_verified = (type_id === duckdb.Type.INTEGER);

          is_foldable_checked = typeof duckdb.expression_is_foldable(expr) === 'boolean';
        }
      });

      duckdb.scalar_function_set_function(scalar_function, (_info, _input, output) => {
        const rowCount = duckdb.data_chunk_get_size(_input);
        for (let i = 0; i < rowCount; i++) {
          duckdb.vector_assign_string_element(output, i, `type_ok:${arg_type_verified},foldable:${is_foldable_checked}`);
        }
      });

      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select test_expr_func(42) as result');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          { name: 'result', logicalType: { typeId: duckdb.Type.VARCHAR } }
        ],
        chunks: [
          { rowCount: 1, vectors: [data(16, [true], ['type_ok:true,foldable:true'])] }
        ]
      });
    });
  });

  test('expression functions - check multiple arguments', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'test_multi_arg');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);

      let arg_count = 0;

      duckdb.scalar_function_set_bind(scalar_function, (bind_info) => {
        arg_count = duckdb.scalar_function_bind_get_argument_count(bind_info);
        expect(arg_count).toBe(2);

        for (let i = 0; i < arg_count; i++) {
          const expr = duckdb.scalar_function_bind_get_argument(bind_info, i);
          const return_type = duckdb.expression_return_type(expr);
          const type_id = duckdb.get_type_id(return_type);
          expect(type_id).toBe(duckdb.Type.INTEGER);
        }
      });

      duckdb.scalar_function_set_function(scalar_function, (_info, _input, output) => {
        const rowCount = duckdb.data_chunk_get_size(_input);
        for (let i = 0; i < rowCount; i++) {
          duckdb.vector_assign_string_element(output, i, `args:${arg_count}`);
        }
      });

      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select test_multi_arg(10, 20) as result');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          { name: 'result', logicalType: { typeId: duckdb.Type.VARCHAR } }
        ],
        chunks: [
          { rowCount: 1, vectors: [data(16, [true], ['args:2'])] }
        ]
      });
    });
  });

  test('expression functions - client context fold', async () => {
    await withConnection(async (connection) => {
      const scalar_function = duckdb.create_scalar_function();
      duckdb.scalar_function_set_name(scalar_function, 'test_ctx_fold');
      const int_type = duckdb.create_logical_type(duckdb.Type.INTEGER);
      const varchar_type = duckdb.create_logical_type(duckdb.Type.VARCHAR);
      duckdb.scalar_function_add_parameter(scalar_function, int_type);
      duckdb.scalar_function_set_return_type(scalar_function, varchar_type);

      let foldedValue: number | null = null;

      duckdb.scalar_function_set_bind(scalar_function, (bind_info) => {
        const context = duckdb.scalar_function_get_client_context(bind_info);
        expect(context).toBeTruthy();
        const expr = duckdb.scalar_function_bind_get_argument(bind_info, 0);
        const folded = duckdb.expression_fold(context, expr);
        foldedValue = duckdb.get_int32(folded);
      });

      duckdb.scalar_function_set_function(
        scalar_function,
        (_info, input, output) => {
          expect(foldedValue).not.toBeNull();
          const rowCount = duckdb.data_chunk_get_size(input);
          for (let i = 0; i < rowCount; i++) {
            duckdb.vector_assign_string_element(
              output,
              i,
              `folded:${foldedValue}`
            );
          }
        }
      );

      duckdb.register_scalar_function(connection, scalar_function);
      duckdb.destroy_scalar_function_sync(scalar_function);

      const result = await duckdb.query(connection, 'select test_ctx_fold(24) as result');
      await expectResult(result, {
        chunkCount: 1,
        rowCount: 1,
        columns: [
          { name: 'result', logicalType: { typeId: duckdb.Type.VARCHAR } }
        ],
        chunks: [
          { rowCount: 1, vectors: [data(16, [true], ['folded:24'])] }
        ]
      });
    });
  });
});

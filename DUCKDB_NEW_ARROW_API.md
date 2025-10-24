We want to add arrow capability to the duckdb-node-neo bindings

A recent PR added a new C API:
~~~
This PR introduces the new Arrow C API, which is intended to replace the deprecated Arrow API.

# Why a new Arrow C-API?
We decided to rewrite the Arrow C-API a while ago and marked all current methods as deprecated. The main reason for a full rewrite is that the previous methods were bloated, extremely complex, and quite brittle. (Kudos to @Tishj for going over these, this is a lightly edited version of his text).

### Previous API was bloated
For reference this is a list, curated by @Tishj, of all previous methods:

* `duckdb_query_arrow` - which covers both the execution of the duckdb query and the conversion to arrow.
* `duckdb_query_arrow_schema` - to extract the schema from the produced result by `duckdb_query_arrow`
* `duckdb_prepared_arrow_schema` - same as above, only it feeds off of a prepared duckdb query
* `duckdb_result_arrow_array` - to convert a chunk to an arrow array (but somehow also require the duckdb_result)
* `duckdb_query_arrow_array` - same as `duckdb_query_arrow_schema` only this takes the array from it
* `duckdb_arrow_column_count` - get metadata from the `duckdb_arrow` object
* `duckdb_arrow_row_count` - get metadata from the `duckdb_arrow` object
* `duckdb_arrow_rows_changed` - get metadata from the `duckdb_arrow` object
* `duckdb_query_arrow_error` - get metadata from the `duckdb_arrow` object
* `duckdb_execute_prepared_arrow` - same as `duckdb_query_arrow` only this takes a prepared statement
* `duckdb_arrow_scan` - scan a table and produce an ArrowArrayStream from it
* `duckdb_arrow_array_scan` - take an array+schema, scan this into a duckdb table and also output the array+schema into an arrow array stream

Some of these methods are also variations of previous methods, that did things in a slightly different way (e.g., `duckdb_execute_prepared_arrow` and `duckdb_query_arrow`.

### Previous API was complex and brittle
It is important to note that the C API is designed to simply wrap an existing C++ construct and expose it to C. No real (or very little) logic should reside in this layer. Functions like `duckdb_arrow_array_scan` are undeniably complex, which means they also contain a lot of custom and fragile logic. Issues in this API remained dormant for years.

### Previous API was poorly tested
Due to the complexity of the API, many tests lived in external clients (e.g., Julia), which left the C API largely untested on the core side. Writing pure C API tests was also difficult because of the complexity of the functionality and the sheer number of methods.

## How does the new API change that?
The new API is much simpler. It consists of only four functions:

* `arrow_to_duckdb_data_chunk`
* `arrow_to_duckdb_schema`
* `duckdb_data_chunk_to_arrow`
* `duckdb_to_arrow_schema`

These enable conversions between Arrow and DuckDB in both directions:

* `ArrowSchema` <-> (`const char **` + `duckdb_arrow_converted_schema *`)
* `ArrowArray` <-> `duckdb_data_chunk`

The complexity of the C API is therefore much lower, and the test paths are much simpler. What comes out of or goes into these functions is simply Arrow, and thus the client’s responsibility.

# Quick tour
The new API consists of four basic methods that convert schemas and data to and from Arrow.

When transforming from DuckDB to Arrow, the schema can be obtained via:

```c++
/*!
Transforms a DuckDB Schema into an Arrow Schema

* @param arrow_options The Arrow settings used to produce arrow.
* @param types The DuckDB Logical Types for each column in the schema.
* @param names The names for each column in the schema.
* @param column_count The number of columns that exist in the schema.
* @param out_schema The resulting arrow schema. Must be destroyed with `out_schema->release(out_schema)`.
* @return The error data.
*/
DUCKDB_C_API duckdb_error_data duckdb_to_arrow_schema(duckdb_arrow_options arrow_options, duckdb_logical_type *types,
                                                      const char **names, idx_t column_count,
                                                      struct ArrowSchema *out_schema);
```

The user must provide the client_properties, as these hold a few Arrow options that specify data production, along with the types, names, and the number of columns. As a result, the `out_schema` will be populated with a valid Arrow schema.

DuckDB data chunks can then be transformed via:

```c++
/*!
Transforms a DuckDB data chunk into an Arrow array.

* @param arrow_options The Arrow settings used to produce arrow.
* @param chunk The DuckDB data chunk to convert.
* @param out_arrow_array The output Arrow structure that will hold the converted data. Must be released with
`out_arrow_array->release(out_arrow_array)`
* @return The error data.
*/
DUCKDB_C_API duckdb_error_data duckdb_data_chunk_to_arrow(duckdb_arrow_options arrow_options, duckdb_data_chunk chunk,
                                                          struct ArrowArray *out_arrow_array);
```

A `duckdb_data_chunk` will be converted to an Arrow Array. In addition to the chunk, the user must also provide the client properties.

The API also provides functions that convert Arrow to DuckDB. An Arrow schema can be converted to a DuckDB schema via:

```c++
/*!
Transforms an Arrow Schema into a DuckDB Schema.

* @param connection The connection to get the transformation settings from.
* @param schema The input Arrow schema. Must be released with `schema->release(schema)`.
* @param out_types The Arrow converted schema with extra information about the Arrow Types. Must be destroyed with
`duckdb_destroy_arrow_converted_schema`.
* @return The error data.
*/
DUCKDB_C_API duckdb_error_data duckdb_schema_from_arrow(duckdb_connection connection, struct ArrowSchema *schema,
                                                      duckdb_arrow_converted_schema *out_types);
```

The user must pass a valid connection so the function can search for Arrow type extensions and the Arrow schema, and output the types, names, and number of columns.

Finally, we can convert an Arrow Array to a DuckDB Chunk via:

```c++
/*!
Transforms an Arrow array into a DuckDB data chunk. The data chunk will retain ownership of the underlying Arrow data.
 However, arrow_array must still be destroyed with `duckdb_destroy_arrow_array`

* @param connection The connection to get the transformation settings from.
* @param arrow_array The input Arrow array. Data ownership is passed on to DuckDB's DataChunk, the underlying object
does not need to be released and won't have ownership of the data.
* @param converted_schema The Arrow converted schema with extra information about the Arrow Types.
* @param out_chunk The resulting DuckDB data chunk. Must be destroyed by duckdb_destroy_data_chunk.
* @return The error data.
*/
DUCKDB_C_API duckdb_error_data duckdb_data_chunk_from_arrow(duckdb_connection connection, struct ArrowArray *arrow_array,
                                                          duckdb_arrow_converted_schema converted_schema,
                                                          duckdb_data_chunk *out_chunk);
```

Here, the user must pass a valid connection, the array to be converted, and the Arrow schema constructed by `duckdb_schema_from_arrow`. The function will then produce a `duckdb_data_chunk`.

Additionally, this PR introduces functions to get the arrow options used in arrow production (`duckdb_arrow_options`) from a connection and the query result., and restructures ADBC to use and test this new C API.

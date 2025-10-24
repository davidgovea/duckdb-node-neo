Below is a **single, end‑to‑end implementation plan** for **Option A (C‑Data bridge, no Arrow dep in core)** + **Option B (opt‑in IPC add‑on)**. It is scoped to your `duckdb-node-neo` monorepo and follows your current structure.

---

## 0) Scope (what you will ship)

* **A/Core** (in `@duckdb/node-bindings`):

  * Minimal Arrow C‑Data **bridge** + wrappers over DuckDB’s **new Arrow C API**.
  * Builders so JS can construct `ArrowSchema`/`ArrowArray` from plain descriptors and **TypedArray views** (no Arrow parser bundled).
  * Lifetime pinning to keep JS buffers alive (zero‑copy possible when the caller supplies buffers).
* **B/Add‑on** (new, opt‑in, separate package):

  * **IPC convenience** that converts `Buffer`(IPC) → C‑Data with *either*

    * **B1**: **nanoarrow** native reader (high‑perf, zero‑copy for uncompressed IPC).
    * **B2 (fallback)**: **apache-arrow JS** reader (pure JS; no native build; may copy on decompress).
  * Ergonomic helpers: `openIPC`, `appendIPC`, `forEachBatch`.

---

## 1) Repo layout changes

```
/bindings
  /pkgs
    /@duckdb
      /node-bindings                # existing (Core)
      /node-arrow-ipc               # NEW (Option B add-on)
        /src
          arrow_ipc_addon.cpp       # B1 native reader (nanoarrow) – optional if you pick B2
          index.ts                  # B1/B2 shared JS surface
        binding.gyp                 # only if B1
        package.json
        README.md
```

Update:

* `/pnpm-workspace.yaml`: add `bindings/pkgs/@duckdb/node-arrow-ipc`.
* `.github/workflows/DuckDBNodeBindingsAndAPI.yml`: build/test new package (conditionally for B1).

---

## 2) Option A (Core) — C‑Data bridge (no Arrow dep)

### 2.1 Public TS surface (edit `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts`)

**Add opaque types:**

```ts
export interface ArrowSchema { __arrow_c_data: 'ArrowSchema'; }
export interface ArrowArray { __arrow_c_data: 'ArrowArray'; }
export interface ArrowArrayStream { __arrow_c_stream: 'ArrowArrayStream'; } // future use
export interface ArrowConvertedSchema { __duckdb_type: 'duckdb_arrow_converted_schema'; }
```

**Expose DuckDB Arrow C‑API wrappers (read path only):**

```ts
export function schema_from_arrow(connection: Connection, schema: ArrowSchema): ArrowConvertedSchema;
export function data_chunk_from_arrow(
  connection: Connection,
  array: ArrowArray,
  converted_schema: ArrowConvertedSchema
): DataChunk;
export function destroy_arrow_converted_schema(converted_schema: ArrowConvertedSchema): void;
```

**Expose C‑Data builders (no parser, just struct constructors):**

```ts
// Minimal descriptors so callers can feed typed arrays they already have
export type ArrowSchemaDesc = {
  format: string;                 // Arrow C-Data format string, e.g. "i", "g", "u:1", "l", "+s", "+l", "+m", etc.
  name?: string | null;
  metadata?: Record<string, string>; // optional
  children?: ArrowSchemaDesc[];
  dictionary?: ArrowSchemaDesc | null;
};

export type ArrowBufferRef = ArrayBufferView | null;  // null for validity when all-valid etc.

export type ArrowArrayDesc = {
  length: number;
  null_count: number;
  offset?: number;                 // default 0
  buffers: ArrowBufferRef[];       // [validity, offsets?, data, ...] per layout of `format`
  children?: ArrowArrayDesc[];
  dictionary?: ArrowArrayDesc | null;
};

// Builders (we pin all ArrayBufferViews)
export function arrow_c_schema_create(desc: ArrowSchemaDesc): ArrowSchema;
export function arrow_c_schema_release(schema: ArrowSchema): void;

export function arrow_c_array_create(desc: ArrowArrayDesc): ArrowArray;
export function arrow_c_array_release(array: ArrowArray): void;
```

> **Reasoning:** The builders make the core independent from Arrow libraries. Callers that already use `apache-arrow` JS (or any producer of TypedArrays) can create C‑Data structs and call DuckDB’s functions.

### 2.2 API layer (optional glue in `api/`)

**Add convenience in `api/src/DuckDBDataChunk.ts`** (additive):

```ts
public static fromArrow(
  connection: import('./DuckDBConnection').DuckDBConnection,
  arr: import('@duckdb/node-bindings').ArrowArray,
  converted: import('@duckdb/node-bindings').ArrowConvertedSchema
): DuckDBDataChunk {
  const chunk = duckdb.data_chunk_from_arrow(connection.connection, arr, converted);
  return new DuckDBDataChunk(chunk);
}
```

**Add a minimal helper** `api/src/appendArrowCData.ts`:

```ts
export async function appendArrowCData(
  conn: DuckDBConnection,
  app: duckdb.Appender,
  schema: duckdb.ArrowSchema,
  batches: duckdb.ArrowArray[]
): Promise<void> {
  const converted = duckdb.schema_from_arrow(conn.connection, schema);
  try {
    for (const batch of batches) {
      const chunk = duckdb.data_chunk_from_arrow(conn.connection, batch, converted);
      duckdb.append_data_chunk(app, chunk);
    }
  } finally {
    duckdb.destroy_arrow_converted_schema(converted);
  }
}
```

### 2.3 Native addon (edit `bindings/src/duckdb_node_bindings.cpp`)

**A) New type-tags and holders (near existing type tags):**

* `ArrowSchemaTypeTag`
* `ArrowArrayTypeTag`
* `ArrowConvertedSchemaTypeTag`

**B) Small C++ holder structs to pin JS buffers:**

```cpp
struct PinnedBuffers {
  std::vector<Napi::Reference<Napi::ArrayBuffer>> arraybuffers;
  ~PinnedBuffers() { for (auto &r : arraybuffers) r.Unref(); }
};

struct ArrowSchemaHolder { ArrowSchema schema{}; /* + optional child holders */ };
struct ArrowArrayHolder  { ArrowArray array{}; std::unique_ptr<PinnedBuffers> pins; /* children... */ };
```

**C) Finalizers:**

```cpp
void FinalizeArrowSchema(Napi::BasicEnv, ArrowSchema* s) {
  if (s && s->release) s->release(s);
  delete s;
}
void FinalizeArrowArray(Napi::BasicEnv, ArrowArray* a) {
  if (a && a->release) a->release(a);
  delete a;
}
void FinalizeArrowConvertedSchema(Napi::BasicEnv, duckdb_arrow_converted_schema* c) {
  duckdb_destroy_arrow_converted_schema(c);
  delete c;
}
```

**D) Builders implementation (key logic):**

* **`arrow_c_schema_create(desc)`**

  * Parse JS `ArrowSchemaDesc` recursively.
  * Allocate `ArrowSchema*` and children (`new ArrowSchema* [n_children]`).
  * Fill `format`, `name`, set `release` to a function that recursively frees `children`, `dictionary`, `format/name/metadata` allocations, then `self->release = nullptr`.
  * Wrap with `Napi::External` + type tag + finalizer.

* **`arrow_c_array_create(desc)`**

  * Parse JS `ArrowArrayDesc`.
  * Allocate `ArrowArray*`, set `length`, `null_count`, `offset`, `n_buffers`, `n_children`, allocate `void** buffers`, `ArrowArray** children`.
  * For each `ArrayBufferView` buffer:

    * Get underlying `ArrayBuffer`; `Ref()` it and store in `PinnedBuffers`.
    * Set `buffers[i] = view ? (view.data + byteOffset) : nullptr`.
  * Children created recursively.
  * Set `release` that:

    * Deletes children (invoke their `release`).
    * Frees `buffers`/`children`.
    * Deletes the attached `PinnedBuffers` (unpins all ArrayBuffers).
    * Sets `release = nullptr`.
  * Wrap with `Napi::External` + type tag + finalizer.

> **Why pin ArrayBuffer (not TypedArray)?** Multiple views share the same backing store; pin the `ArrayBuffer` to keep memory valid.

**E) DuckDB Arrow C‑API wrappers:**

* `schema_from_arrow(conn, schema)` → call `duckdb_schema_from_arrow()`, on error throw with message, else wrap `duckdb_arrow_converted_schema` in External with finalizer.
* `data_chunk_from_arrow(conn, array, converted)` → call `duckdb_data_chunk_from_arrow()`, wrap result using existing `CreateExternalForDataChunkWithoutFinalizer` (or with the DataChunk finalizer you already have).
* `destroy_arrow_converted_schema(converted)` → call `duckdb_destroy_arrow_converted_schema()`.

**F) Errors:** Add a tiny helper to translate `duckdb_error_data` to JS exceptions and ensure destruction of error object (if the C API requires it).

**G) Export new functions in `DuckDBNodeAddon` ctor:**

```cpp
exports.Set("arrow_c_schema_create", Napi::Function::New(env, ArrowCSchemaCreate));
exports.Set("arrow_c_schema_release", Napi::Function::New(env, ArrowCSchemaRelease));
exports.Set("arrow_c_array_create",  Napi::Function::New(env, ArrowCArrayCreate));
exports.Set("arrow_c_array_release", Napi::Function::New(env, ArrowCArrayRelease));
exports.Set("schema_from_arrow",     Napi::Function::New(env, SchemaFromArrow));
exports.Set("data_chunk_from_arrow", Napi::Function::New(env, DataChunkFromArrow));
exports.Set("destroy_arrow_converted_schema", Napi::Function::New(env, DestroyConvertedSchema));
```

**Side effects / impact:** additive API; no changes to existing behavior.

---

## 3) Option B (Add‑on) — IPC convenience module

> **Goal:** Keep core lean. Provide a *separate* package that converts IPC `Buffer` → Arrow C‑Data (`ArrowSchema` + batches) and appends, by **either** B1 (native nanoarrow) **or** B2 (JS apache-arrow). Both use Option A’s builders/wrappers.

### 3.1 Package skeleton (`bindings/pkgs/@duckdb/node-arrow-ipc/package.json`)

* **Name:** `@duckdb/node-arrow-ipc`
* **Type:** module
* **Dependencies:**

  * **B1 (native nanoarrow):** none at JS level; nanoarrow vendored in this package’s `binding.gyp`.
  * **B2 (pure JS):** `"apache-arrow": "^x.y.z"` as a dependency.
* **Peer dependency (optional):** `@duckdb/node-bindings` (ensure version alignment).
* **Optional build:** mark as optional in root README to keep core users unaffected.

### 3.2 B1 (native, nanoarrow) — high‑perf path

**New native file:** `bindings/pkgs/@duckdb/node-arrow-ipc/src/arrow_ipc_addon.cpp`

**Exports:**

```ts
// index.ts d.ts surface:
export interface ArrowIPCStream { __arrow_ipc_stream: 'ArrowIPCStream'; }

export function openIPCFromBuffer(buffer: Uint8Array): ArrowIPCStream;
export function ipcGetSchema(stream: ArrowIPCStream): import('@duckdb/node-bindings').ArrowSchema;
export function ipcGetNext(stream: ArrowIPCStream): import('@duckdb/node-bindings').ArrowArray | null;
export function closeIPC(stream: ArrowIPCStream): void;

// High-level convenience:
export type AppendIPCOptions = { catalog?: string | null; schema?: string | null; mode?: 'by_index' | 'by_name' };
export function appendIPC(
  conn: import('@duckdb/node-bindings').Connection,
  table: string,
  ipcBuffer: Uint8Array,
  opt?: AppendIPCOptions
): Promise<void>;
```

**Native implementation notes:**

* Vendor minimal **nanoarrow** files into `node-arrow-ipc` package (e.g., `third_party/nanoarrow/{nanoarrow.c, nanoarrow_ipc.c, nanoarrow.h, nanoarrow_ipc.h}`).
* `openIPCFromBuffer`:

  * Create nanoarrow `ArrowArrayStream*` over the provided `Buffer`. Store `Napi::Reference<Napi::Buffer<uint8_t>>` inside a small holder attached to the stream to **pin** memory.
  * Return an External + type tag with finalizer calling `stream->release`.
* `ipcGetSchema`:

  * Calls `get_schema` into an `ArrowSchema*`. Return as External (finalizer releases).
* `ipcGetNext`:

  * Calls `get_next`. If end, return `null`. Else External `ArrowArray*` (finalizer releases), with buffers referencing the original pinned buffer (zero‑copy for uncompressed).
* `closeIPC`:

  * Releases stream and unpins buffer.

**JS `appendIPC` (in `index.ts`):**

```ts
import duckdb from '@duckdb/node-bindings';
export async function appendIPC(conn: duckdb.Connection, table: string, buf: Uint8Array, opt?: AppendIPCOptions) {
  const stream = openIPCFromBuffer(buf);
  try {
    const schema = ipcGetSchema(stream);
    const converted = duckdb.schema_from_arrow(conn, schema);
    try {
      const app = duckdb.appender_create_ext(conn, opt?.catalog ?? null, opt?.schema ?? null, table);
      // If opt.mode === 'by_name', optionally switch to appender_create_query(...) (see §3.4)
      for (;;) {
        const arr = ipcGetNext(stream);
        if (!arr) break;
        const chunk = duckdb.data_chunk_from_arrow(conn, arr, converted);
        duckdb.append_data_chunk(app, chunk);
      }
      duckdb.appender_close_sync(app);
      duckdb.appender_flush_sync(app);
    } finally {
      duckdb.destroy_arrow_converted_schema(converted);
    }
  } finally {
    closeIPC(stream);
  }
}
```

**`binding.gyp` (for this package):**

```gyp
{
  "targets": [{
    "target_name": "arrow_ipc_addon",
    "sources": [
      "src/arrow_ipc_addon.cpp",
      "src/third_party/nanoarrow/nanoarrow.c",
      "src/third_party/nanoarrow/nanoarrow_ipc.c"
    ],
    "include_dirs": ["<!(node -p \"require('node-addon-api').include\")", "src/third_party/nanoarrow"],
    "dependencies": ["<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except_all"],
    "cflags_c": ["-std=c99"]
  }]
}
```

**Architectural choice:** keep nanoarrow isolated to this package so core remains dependency‑free.

### 3.3 B2 (pure JS, apache-arrow) — fallback

If you want a no‑native add‑on:

* **No `binding.gyp`**. `index.ts` depends on `apache-arrow`.
* Implementation:

  * Use `Table.from([ipcBuffer])` or `RecordBatchReader.from(ipcBuffer)`.
  * For each `RecordBatch`:

    * Build **`ArrowSchemaDesc`** and **`ArrowArrayDesc`** by mapping apache-arrow JS types to C‑Data `format` + buffers (validity/offsets/data).
    * Call **core** builders `arrow_c_schema_create` / `arrow_c_array_create`.
    * Use `schema_from_arrow` + `data_chunk_from_arrow` + `append_data_chunk`.
* **Zero‑copy:** If apache-arrow JS exposes underlying `ArrayBuffer`s for uncompressed fields, the builders will reference them without copying. Compressed IPC incurs decompress copies (unavoidable).

> You can ship both B1 and B2: at runtime, prefer native if built, else fall back to JS.

### 3.4 (Optional) Name‑based column mapping

If you want `mode: 'by_name'` (Arrow column order ≠ table order):

* Expose **`appender_create_query`** in core (small wrapper) to create an appender with an explicit column list/order:

  * **Where:** `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts` + native glue in `duckdb_node_bindings.cpp`.
  * **Signature:**

    ```ts
    export function appender_create_query(
      connection: Connection,
      query: string,                // "INSERT INTO <schema>.<table>(a,b,c) VALUES (?)" — used internally, see below
      column_count: number,
      types: readonly LogicalType[],
      table_name: string,
      column_names: readonly string[]
    ): Appender;
    ```
  * **Simpler alternative:** just **emit `INSERT INTO … SELECT * FROM _arrow_temp`** route is overkill here; prefer by‑index for v1. Many users can pre‑order columns on the JS side.

---

## 4) Data structures & mapping (A+B)

* **ArrowSchemaDesc → ArrowSchema**

  * `format`: the C‑Data format string; caller’s responsibility (e.g., `"i"` = int32, `"g"` = float64, `"u:1"` = bit, `"+l"` = list, `"+s"` = struct with children, `"z"` = binary, `"u"` = utf8, `"w"` = large_utf8, etc.).
  * `children`: required for nested types; order matches columns/field order.

* **ArrowArrayDesc → ArrowArray**

  * `buffers`: obey C‑Data layout for the `format`. Example:

    * int32: `[validity, /*no offsets*/, data]` → `buffers.length = 2` (validity, data).
    * utf8:  `[validity, offsets(Int32Array), data(Uint8Array)]`.
    * list:  `[validity, offsets]` + one **child** array.
  * `null_count`, `offset`, `length` as per batch.

* **PinnedBuffers:** we pin **ArrayBuffers** backing each `ArrayBufferView` passed in `buffers` so DuckDB can read them safely. Release occurs when you call `arrow_c_array_release()`.

* **Ownership flow (critical):**

  1. Build `ArrowSchema`/`ArrowArray`.
  2. `schema_from_arrow()` produces `ArrowConvertedSchema`.
  3. `data_chunk_from_arrow()` returns a `DataChunk` that **retains ownership of ArrowArray’s underlying data** (per DuckDB’s new API).
  4. **Only after `append_data_chunk()` returns** it’s safe to call `arrow_c_array_release()` (our holder frees pinning and calls array’s release).

---

## 5) Exact code insertion points

* **`bindings/src/duckdb_node_bindings.cpp`**

  * **Add**: type tags, holders, builders, wrapper functions (§2.3 A–G).
  * **Modify**: `DuckDBNodeAddon` constructor to `exports.Set(...)` new functions (keep near other exports for coherence).

* **`bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts`**

  * **Add**: opaque types + new function signatures + builder types (§2.1).

* **`api/src/DuckDBDataChunk.ts`**

  * **Add**: `fromArrow()` static (optional convenience).

* **`api/src/appendArrowCData.ts`**

  * **Add**: convenience helper (pure TS; optional).

* **`bindings/pkgs/@duckdb/node-arrow-ipc/*`** (new package)

  * For **B1**: native `arrow_ipc_addon.cpp` + `binding.gyp` + `index.ts`.
  * For **B2**: just `index.ts` (no native).

* **Workspace/CI**: add package to `pnpm-workspace.yaml` + adjust GH workflow matrix to build B1 on supported platforms.

---

## 6) Example signatures & minimal pseudo

**Core builders:**

```cpp
Napi::Value ArrowCSchemaCreate(const Napi::CallbackInfo&); // (desc: object) -> External<ArrowSchema>
Napi::Value ArrowCSchemaRelease(const Napi::CallbackInfo&); // (schema: External)
Napi::Value ArrowCArrayCreate(const Napi::CallbackInfo&);  // (desc: object) -> External<ArrowArray>
Napi::Value ArrowCArrayRelease(const Napi::CallbackInfo&); // (array: External)
```

**C‑API wrappers:**

```cpp
Napi::Value SchemaFromArrow(const Napi::CallbackInfo&);     // (conn, schema) -> External<duckdb_arrow_converted_schema>
Napi::Value DataChunkFromArrow(const Napi::CallbackInfo&);  // (conn, array, converted) -> External<duckdb_data_chunk>
Napi::Value DestroyConvertedSchema(const Napi::CallbackInfo&); // (converted) -> void
```

**B1 nanoarrow IPC exports:**

```cpp
Napi::Value OpenIPCFromBuffer(const Napi::CallbackInfo&); // (buffer) -> External<ArrowArrayStreamHolder>
Napi::Value IpcGetSchema(const Napi::CallbackInfo&);      // (stream) -> External<ArrowSchema>
Napi::Value IpcGetNext(const Napi::CallbackInfo&);        // (stream) -> External<ArrowArray> | null
Napi::Value CloseIPC(const Napi::CallbackInfo&);          // (stream) -> void
```

---

## 7) Dependencies / imports

* **Core:** none new (keeps `@duckdb/node-bindings` dependency‑free from Arrow).
* **Add‑on B1:** vendored nanoarrow C sources (no external npm deps). Use `node-addon-api`.
* **Add‑on B2:** `apache-arrow` npm package (runtime only), no native build.

---

## 8) Configuration updates

* **`pnpm-workspace.yaml`**: include new add‑on package path.
* **GitHub Actions**:

  * Extend job to build `@duckdb/node-arrow-ipc` only when present (skip on unsupported platforms if B1).
* **`binding.gyp` (core)**: **no changes** for A (builders implemented inside existing native target).
* **`binding.gyp` (add‑on)**: as in §3.2.
* **`package.json` (core)**: add the new type exports in `types` if you re‑export at top-level.
* **`package.json` (add‑on)**:

  * If B1: `"gypfile": true`, `scripts.build` to run `node-gyp rebuild`.
  * If B2: no native build steps.

---

## 9) Risks, side effects, design notes

* **GC safety**: All ArrowArray `buffers` must pin backing `ArrayBuffer`s until `arrow_c_array_release()`. Forgetting to release → memory held (not leaked at native level, but GC roots stay).
* **Format strings**: The core does **not** validate Arrow C‑Data `format` deeply. Mis‑specified descriptors → undefined behavior. Document responsibility on caller (A) / on add‑on (B).
* **Compressed IPC**: Zero‑copy only when uncompressed; otherwise the reader (B1/B2) will decompress (alloc/copy).
* **By‑name mapping**: Defer unless needed; by‑index is trivial and fastest. If implemented, prefer a thin name‑order reconciliation on the JS side rather than `appender_create_query`.
* **Dictionary / extension types**: DuckDB handles many via `duckdb_schema_from_arrow`. Ensure that B2 mapping to `format` is faithful (if you ship B2).
* **Large offsets (64‑bit)**: Ensure B1/B2 pass proper offsets TypedArray width to buffers in `ArrowArrayDesc`.

---

## 10) Example end‑to‑end flows

### A: Caller brings `apache-arrow` (or any) and builds C‑Data

```ts
// user-land (no add-on):
import duckdb from '@duckdb/node-bindings';

const schemaDesc: ArrowSchemaDesc = { format: "i", name: "id" }; // ... build full schema
const batchDesc: ArrowArrayDesc  = {
  length, null_count: 0,
  buffers: [null, new Int32Array(buf, off, len)]
};

const cSchema = duckdb.arrow_c_schema_create(schemaDesc);
const cArray  = duckdb.arrow_c_array_create(batchDesc);

const converted = duckdb.schema_from_arrow(conn, cSchema);
const chunk = duckdb.data_chunk_from_arrow(conn, cArray, converted);
duckdb.append_data_chunk(app, chunk);

duckdb.arrow_c_array_release(cArray);
duckdb.destroy_arrow_converted_schema(converted);
duckdb.arrow_c_schema_release(cSchema);
```

### B1: Add‑on convenience from IPC `Buffer`

```ts
import { appendIPC } from '@duckdb/node-arrow-ipc';
await appendIPC(conn, 'my_table', ipcBuffer, { schema: 'public', mode: 'by_index' });
```

---

## 11) What not to implement now (but leave hooks for)

* Write path (`duckdb_data_chunk_to_arrow`, `duckdb_to_arrow_schema`) – symmetric, out of current scope.
* Arrow options plumbing (`duckdb_arrow_options`) – only needed for “DuckDB → Arrow”.
* Appender `create_query`—only if you truly need name based mapping at v1.

---

## 12) Acceptance checklist

* [ ] Core exports present (`arrow_c_*`, `schema_from_arrow`, `data_chunk_from_arrow`, `destroy_arrow_converted_schema`).
* [ ] Builders pin/unpin buffers; release callbacks free all allocations and clear `release`.
* [ ] Add‑on package compiles on Linux/macOS/Windows (B1) or installs without native steps (B2).
* [ ] `appendIPC` appends batches to table with zero‑copy on uncompressed IPC.

This plan keeps **core dependency‑free**, delivers a **zero‑copy path** for advanced users (A), and offers an **opt‑in, ergonomic IPC path** (B) that you can implement with either native nanoarrow (faster) or pure JS (simpler).


Below is a **complete, implementation‑ready plan** for **Option A (core: Arrow C‑Data bridge, zero deps)** + **Option B (optional add‑on: IPC reader via nanoarrow)**. It’s organized by package, files, exported APIs, data flow, lifetimes, and build config.

---

## A) Core (`@duckdb/node-bindings`) — Arrow C‑Data bridge (no Arrow dependency)

### A1. Goals

* Expose new DuckDB Arrow C‑API:

  * `duckdb_schema_from_arrow`
  * `duckdb_data_chunk_from_arrow`
  * `duckdb_destroy_arrow_converted_schema`
* Provide **minimal constructors** for Arrow C‑Data (`ArrowSchema`, `ArrowArray`) that accept **typed arrays from JS** and build C‑Data structs **without** parsing IPC.
* Ensure **zero‑copy** when caller provides pre‑materialized typed arrays (e.g., from `apache-arrow` JS).
* Add optional helper for name‑based column mapping via `duckdb_appender_create_query`.

### A2. Files to change / add

**Modify**

* `bindings/src/duckdb_node_bindings.cpp`

  * Add new type tags, creators, finalizers, and exports (see A4).
  * Add wrappers for DuckDB Arrow C‑API.
  * (Optional) wrap `duckdb_appender_create_query`.

* `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts`

  * Add opaque types & method signatures (see A3).

**Add**

* `bindings/src/arrow_c_data_node.hpp`
* `bindings/src/arrow_c_data_node.cpp`

  * Implements C‑Data builders, JS ↔ native shape marshaling, pinning of ArrayBuffers.

> **No** change to binding.gyp for A (we don’t add nanoarrow here).

### A3. Public TS surface (core)

Opaque handles:

```ts
export interface ArrowSchema { __arrow_c_data: 'ArrowSchema'; }
export interface ArrowArray  { __arrow_c_data: 'ArrowArray'; }
export interface ArrowConvertedSchema { __duckdb_type: 'duckdb_arrow_converted_schema'; }
```

Minimal descriptions for C‑Data creation (pure TS; no Arrow dep):

```ts
export type BufferRef = { data: ArrayBufferView | null }; // null for unused buffers
export type SchemaDesc = {
  format: string;                // Arrow format string
  name?: string | null;
  flags?: number;                // ArrowSchema.flags (optional)
  metadata?: Record<string,string>;
  children?: SchemaDesc[];
  dictionary?: SchemaDesc | null;
};
export type ArrayDesc = {
  length: number;
  null_count: number;
  offset?: number;
  buffers: BufferRef[];          // as required by 'format'
  children?: ArrayDesc[];
  dictionary?: ArrayDesc | null;
};
```

New core exports:

```ts
// Build C‑Data from JS descriptions (pins any ArrayBufferViews for lifetime)
export function arrow_c_schema_create(desc: SchemaDesc): ArrowSchema;
export function arrow_c_schema_release(schema: ArrowSchema): void;

export function arrow_c_array_create(desc: ArrayDesc, pinned: ArrayBufferView[]): ArrowArray;
export function arrow_c_array_release(array: ArrowArray): void;

// DuckDB Arrow C‑API wrappers (read path)
export function schema_from_arrow(conn: Connection, schema: ArrowSchema): ArrowConvertedSchema;
export function data_chunk_from_arrow(conn: Connection, array: ArrowArray, converted: ArrowConvertedSchema): DataChunk;
export function destroy_arrow_converted_schema(converted: ArrowConvertedSchema): void;

// Optional: name‑based mapping appender
export function appender_create_query(
  connection: Connection,
  query: string,
  column_count: number,
  logical_types: readonly LogicalType[],
  table_name: string,
  column_names: readonly string[],
): Appender;
```

**Optional convenience in API layer (not required, but nice):**

* `api/src/DuckDBDataChunk.ts`: add:

```ts
public static fromArrow(
  connection: import('./DuckDBConnection').DuckDBConnection,
  array: import('@duckdb/node-bindings').ArrowArray,
  converted: import('@duckdb/node-bindings').ArrowConvertedSchema
): DuckDBDataChunk {
  const chunk = duckdb.data_chunk_from_arrow(connection.connection, array, converted);
  return new DuckDBDataChunk(chunk);
}
```

### A4. Native details (core)

**Type tags & finalizers** (modeled after existing ones in `duckdb_node_bindings.cpp`)

* New `napi_type_tag`s:

  * `ArrowSchemaTypeTag`, `ArrowArrayTypeTag`, `ArrowConvertedSchemaTypeTag`.
* Finalizers:

  * `FinalizeArrowSchema`: call `schema->release(schema)` if present; delete wrapper.
  * `FinalizeArrowArray`: call `array->release(array)`; delete wrapper.
  * `FinalizeArrowConvertedSchema`: call `duckdb_destroy_arrow_converted_schema(&conv)`; delete wrapper.

**C‑Data builders** (`arrow_c_data_node.cpp/hpp`)

* Build `ArrowSchema`:

  * Set `format`, `name`, `metadata` (serialized key/value), `flags`.
  * Recursively allocate child `ArrowSchema` entries and optional `dictionary`.
  * Provide a `release` that:

    * Recursively frees children/dictionary.
    * Frees metadata string buffer.
* Build `ArrowArray`:

  * Copy `length`, `null_count`, `offset`.
  * For each `buffers[i]`, set raw pointer to **pinned** `ArrayBufferView`’s `Data()` + byte offset; or `nullptr`.
  * Recursively build child arrays and optional dictionary.
  * Maintain a `std::vector<Napi::Reference<Napi::ArrayBuffer>>` (or `Napi::Reference<Napi::TypedArray>`) to **pin** each passed view’s `ArrayBuffer`.
  * `release`:

    * Clear pinned refs.
    * Recursively release children/dictionary.
* `arrow_c_array_create(desc, pinned)`:

  * Validate `pinned.length` covers all non‑null buffers in `desc`.
  * Store refs; install custom `release`.

**DuckDB Arrow C‑API wrappers**

* `SchemaFromArrow(conn, schema)` → `duckdb_schema_from_arrow`.
* `DataChunkFromArrow(conn, array, converted)` → `duckdb_data_chunk_from_arrow`.
* `DestroyArrowConvertedSchema(converted)` → calls destroy.
* **Error handling**: use `duckdb_error_data_has_error(...)` + `duckdb_error_data_message(...)` (add tiny helper) and throw JS `Error`. Ensure to destroy `error_data` (if API requires).

**Exports registration** (`DuckDBNodeAddon`):

```cpp
exports.Set("arrow_c_schema_create", Napi::Function::New(env, ArrowCSchemaCreate));
exports.Set("arrow_c_schema_release", Napi::Function::New(env, ArrowCSchemaRelease));
exports.Set("arrow_c_array_create", Napi::Function::New(env, ArrowCArrayCreate));
exports.Set("arrow_c_array_release", Napi::Function::New(env, ArrowCArrayRelease));

exports.Set("schema_from_arrow", Napi::Function::New(env, SchemaFromArrow));
exports.Set("data_chunk_from_arrow", Napi::Function::New(env, DataChunkFromArrow));
exports.Set("destroy_arrow_converted_schema", Napi::Function::New(env, DestroyArrowConvertedSchema));

exports.Set("appender_create_query", Napi::Function::New(env, AppenderCreateQuery)); // optional
```

### A5. Data & lifetime semantics (core)

* **Zero‑copy**: pointers in `ArrowArray.buffers` point to caller’s typed arrays. They are pinned via `Napi::Reference`, so V8 cannot GC them while DuckDB converts/appends.
* **Order of operations**:

  1. Caller builds `ArrowSchema` → `schema_from_arrow()` → `ArrowConvertedSchema`.
  2. For each batch: build `ArrowArray` → `data_chunk_from_arrow()` → `append_data_chunk(app)` → **then** `arrow_c_array_release()`.
  3. After all: `duckdb.appender_close_sync` / `flush` and `destroy_arrow_converted_schema`.
  4. `arrow_c_schema_release()` when finished mapping schema.
* **Compressed data**: N/A to core; buffers are already materialized by the caller.

---

## B) Optional add‑on package (`@duckdb/node-arrow-ipc`) — IPC reader via nanoarrow

### B1. Goals

* Keep **core** dependency‑free.
* Provide a **fast IPC reader** that yields Arrow C‑Data (`ArrowSchema`, `ArrowArray`) for buffers of Arrow IPC (stream/file).
* Enable **zero‑copy** for **uncompressed** IPC: Arrow buffers point directly into the original Node Buffer.
* Offer a high‑level **append** helper that uses core bridge + Appender.

### B2. Package layout

**New package:**

```
bindings/pkgs/@duckdb/node-arrow-ipc
├── package.json
├── binding.gyp
├── src
│   ├── nanoarrow/*.c, *.h                 # vendored minimal set (nanoarrow + nanoarrow_ipc)
│   ├── arrow_ipc_node.cpp                 # N-API glue
│   └── arrow_ipc_node.hpp
└── README.md
```

**`package.json` key points**

* `"name": "@duckdb/node-arrow-ipc"`
* `"peerDependencies": { "@duckdb/node-bindings": "*" }`
* Optional: `"gypfile": true`
* Scripts for `node-gyp`/`prebuildify` if you prebuild.

**`pnpm-workspace.yaml`**

* Add this package path.

### B3. binding.gyp (add‑on)

* Include nanoarrow sources:

  * `nanoarrow.c`, `nanoarrow_ipc.c` (and any minimal deps).
* `include_dirs`: `src/nanoarrow`
* No DuckDB link (we call back into `@duckdb/node-bindings` for conversion/append).

### B4. Public API (add‑on)

Opaque stream type:

```ts
export interface ArrowArrayStream { __arrow_c_stream: 'ArrowArrayStream'; }
```

IPC functions:

```ts
// Open an Arrow IPC stream from a Node Buffer / Uint8Array. Pins the buffer.
export function arrow_ipc_open_buffer(buffer: Uint8Array): ArrowArrayStream;

// Extract schema (C‑Data ArrowSchema). Caller must release via core’s arrow_c_schema_release().
export function arrow_array_stream_get_schema(stream: ArrowArrayStream): import('@duckdb/node-bindings').ArrowSchema;

// Pull next record batch. Returns null on EOS. Caller must release via core’s arrow_c_array_release().
export function arrow_array_stream_get_next(stream: ArrowArrayStream): import('@duckdb/node-bindings').ArrowArray | null;

// Close and release stream and pinned buffer(s).
export function arrow_array_stream_close(stream: ArrowArrayStream): void;
```

High‑level convenience (optional but recommended):

```ts
import { Connection, Appender, LogicalType } from '@duckdb/node-bindings';

export type AppendArrowIPCOptions = {
  catalog?: string | null;
  schema?: string | null;
  mode?: 'by_index' | 'by_name';
};

export function append_arrow_ipc(
  connection: Connection,
  table: string,
  ipc: Uint8Array,
  options?: AppendArrowIPCOptions
): Promise<void>;
```

### B5. Native details (add‑on)

**Stream holder struct**

* Holds:

  * `ArrowArrayStream stream;`
  * `Napi::Reference<Napi::Buffer<uint8_t>> pinned_ipc;` (or generic `TypedArray`)
  * Any nanoarrow reader state if required.
* `release`:

  * `stream.release(&stream);`
  * Clear `pinned_ipc`.

**`arrow_ipc_open_buffer`**

* Accept Node `Buffer` / `Uint8Array`.
* Pin backing `ArrayBuffer` via `Napi::Reference`.
* Initialize nanoarrow IPC reader from raw bytes (zero‑copy).
* Return External of `ArrowArrayStream` with finalizer.

**`get_schema`**

* Allocate `ArrowSchema*`, call `stream.get_schema(...)`.
* Return External `ArrowSchema` (finalizer releases).

**`get_next`**

* Allocate `ArrowArray*`, call `stream.get_next(...)`.
* If `release == nullptr` (end), return `null`.
* Return External `ArrowArray` (finalizer releases).
* **Zero‑copy**: `ArrowArray.buffers[i]` point into pinned IPC buffer (when uncompressed). For compressed IPC, nanoarrow will allocate & decompress (copy).

**`close`**

* Invoke `stream.release(...)` if not yet released; clear pin.

**`append_arrow_ipc` (AsyncWorker)**

* Steps (fast path):

  1. Open stream; `schema = get_schema`.
  2. `converted = schema_from_arrow(connection, schema)` (call **core**).
  3. Create `appender` via `appender_create_ext(...)`.

     * If `mode=='by_name'`, build `column_names` from Arrow schema and use `appender_create_query(...)` (exposed by core).
  4. Loop:

     * `batch = get_next(stream)` → `chunk = data_chunk_from_arrow(connection, batch, converted)` (core) → `append_data_chunk(appender, chunk)`.
  5. Close/flush appender; destroy `converted`; close stream.
* On any error, ensure cleanup and reject promise.

### B6. TypeScript glue in add‑on

* Re‑export `ArrowSchema`, `ArrowArray` from core types for user ergonomics.
* Provide a tiny helper to list Arrow column names from `ArrowSchema` (optional; can be derived via C‑Data `name` fields inside the schema). If needed, implement a native function `arrow_schema_list_names(schema): string[]`.

### B7. Lifetimes & dictionaries (add‑on)

* The nanoarrow stream typically keeps dictionaries alive across batches. Keep the **underlying IPC buffer pinned until stream close** to cover dictionary buffers as well.
* Each `ArrowArray` returned must be `release()`d by caller (we rely on core’s `arrow_c_array_release` finalizer; document this).

---

## C) Integration points in API package (`api/`)

**Optional ergonomic helpers** (pure TS; built on core/add‑on):

* `api/src/appendArrowIPC.ts` (only if you want a typed wrapper with `DuckDBConnection` class):

  * Accepts `DuckDBConnection`, `table`, `Uint8Array`, `{ mode }`.
  * Internally calls **add‑on** `append_arrow_ipc` or meshes low‑level steps if add‑on missing.

**Minimal change to existing code**

* `api/src/DuckDBDataChunk.ts`: add `fromArrow()` (A3).
* Do **not** pull nanoarrow into `api/`.

---

## D) Column mapping behavior

* Default **`by_index`**: Arrow column order must match DuckDB table order. Fastest.
* **`by_name`** (optional):

  * Use `appender_create_query()` with explicit column list in Arrow schema order:

    * `INSERT INTO <tbl> (<arrow_col_list>) VALUES ?` equivalent is handled by appender create‑query API (it creates an appender backed by a `SELECT` with desired order).
  * Requires core to export `appender_create_query` (A3).

---

## E) Error propagation & diagnostics

**Core**

* Wrap `duckdb_error_data` into JS `Error` with message; include error type if available.
* Validate `ArrayDesc` consistency (buffer counts vs. type `format`); throw early.

**Add‑on**

* Convert nanoarrow error codes to JS `Error` messages.
* When rejecting `append_arrow_ipc`, include which step failed (`schema_from_arrow`, `data_chunk_from_arrow`, `append_data_chunk`, etc.).

---

## F) Build & packaging

**Core**

* No new third‑party sources.
* Just C++ code for builders and wrappers.

**Add‑on**

* Vendor **only** minimal `nanoarrow` C files needed for IPC:

  * `nanoarrow.h`, `nanoarrow.c`, `nanoarrow_ipc.h`, `nanoarrow_ipc.c` (+ any tiny deps).
* `binding.gyp` compiles these; no external shared libs.

**Workspace**

* Add `bindings/pkgs/@duckdb/node-arrow-ipc` to `pnpm-workspace.yaml`.

**Runtime**

* Users who don’t install the add‑on can still use the core C‑Data bridge with their own JS Arrow implementation (`apache-arrow`) to produce `SchemaDesc`/`ArrayDesc`.

---

## G) Example usage

### G1. Power user with `apache-arrow` JS (no add‑on; pure A)

```ts
import duckdb from '@duckdb/node-bindings';

// Build SchemaDesc / ArrayDesc from user’s JS Arrow objects:
const schemaDesc: SchemaDesc = {/* format/name/children/... from user's types */};
const arrays: {desc: ArrayDesc, pins: ArrayBufferView[]}[] = /* user-prepared */;

const cSchema = duckdb.arrow_c_schema_create(schemaDesc);
const converted = duckdb.schema_from_arrow(conn, cSchema);

const app = duckdb.appender_create_ext(conn, null, null, 'dest');

for (const {desc, pins} of arrays) {
  const cArr = duckdb.arrow_c_array_create(desc, pins);
  const chunk = duckdb.data_chunk_from_arrow(conn, cArr, converted);
  duckdb.append_data_chunk(app, chunk);
  duckdb.arrow_c_array_release(cArr);
}

duckdb.appender_close_sync(app);
duckdb.appender_flush_sync(app);
duckdb.destroy_arrow_converted_schema(converted);
duckdb.arrow_c_schema_release(cSchema);
```

### G2. Convenient IPC append (B)

```ts
import ipc from '@duckdb/node-arrow-ipc';
import duckdb from '@duckdb/node-bindings';

await ipc.append_arrow_ipc(conn, 'dest_table', fs.readFileSync('data.arrow'), { mode: 'by_index' });
```

---

## H) Side effects / impacts

* **Core binary size**: negligible increase (custom C‑Data builders).
* **Add‑on binary size**: modest (nanoarrow IPC only).
* **Performance**:

  * A: zero‑copy when arrays are pre‑materialized; no IPC parsing.
  * B: zero‑copy for uncompressed IPC; copies only for compression/decompression by nanoarrow.

---

## I) Implementation checklist (sequenced)

1. **Core**

   * Add TS opaque types + signatures (A3).
   * Implement `arrow_c_data_node.*` (builders, release, pinning).
   * Wrap DuckDB Arrow C‑API; add error helpers.
   * Export functions in `DuckDBNodeAddon`.
   * (Optional) expose `appender_create_query`.
   * Add `DuckDBDataChunk.fromArrow()` (API layer).

2. **Add‑on**

   * Scaffold `@duckdb/node-arrow-ipc` package.
   * Vendor minimal nanoarrow IPC sources.
   * Implement stream holder, open/get_schema/get_next/close.
   * Implement `append_arrow_ipc` (AsyncWorker) calling back into core.
   * Author d.ts referencing core’s Arrow types.

3. **Docs**

   * Core README: “Arrow C‑Data bridge” usage + lifetimes.
   * Add‑on README: IPC flow + zero‑copy notes + compressed IPC caveats.

---

## J) Critical design decisions (locked)

* **No Arrow deps in core**. All parsing burden optionalized in add‑on.
* **Zero‑copy** guaranteed where data is already in typed arrays (A) or IPC is uncompressed (B).
* **Explicit lifetimes** via `*_release()` functions and N-API finalizers.
* **Name‑based mapping** available only if core exports `appender_create_query`; otherwise default to by‑index.

This plan gives you a lean, dependency‑free core with a robust path for advanced users (A), plus an opt‑in, high‑performance IPC experience (B) that doesn’t bloat the main bindings.

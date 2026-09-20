# Versioned Figma extractor

This is the headless NT-11 step-1 extractor. It captures one explicitly named Figma file
version, optional selected-node payloads, vector geometry, component/style metadata,
prototype interactions, image-fill references, and optional reference renders. It does
not normalize into `MockupIR` or write NML.

The library is `app/lib/figma`. The CLI is bundled without adding a runtime dependency:

```sh
node figma-extractor/build.mjs
node figma-extractor/dist/nootles-figma-extract.mjs --help
```

The CLI starts with networking disabled. A cache hit can be materialized offline:

```sh
node figma-extractor/dist/nootles-figma-extract.mjs \
  --file-key FILE_KEY --version VERSION_ID --nodes 1:2,3:4 \
  --cache .nt11-cache --output .nt11-extractions/VERSION_ID
```

A live run requires both `--allow-network` and `FIGMA_ACCESS_TOKEN`. That mechanical latch
does not replace the workspace rule: obtain explicit operator approval for the exact run,
file, endpoints, and maximum calls first. Never put the token on the command line.
With file + selected-node + render endpoints and retry budget `R`, the API-call ceiling is
`3 × (R + 1)`; each non-null render adds one signed-asset download with no retry. Omitted
selected nodes or renders reduce that ceiling, and a cache hit makes zero requests.

```sh
FIGMA_ACCESS_TOKEN=... node figma-extractor/dist/nootles-figma-extract.mjs \
  --allow-network --file-key FILE_KEY --version VERSION_ID --nodes 1:2,3:4 \
  --cache .nt11-cache --output .nt11-extractions/VERSION_ID
```

`snapshot.json` and `report.json` are canonical JSON. Render URLs expire, so the extractor
downloads them immediately, hashes the bytes, stores them under `assets/`, and records only
the content address. Caller-dependent/current-file metadata is omitted from the stable
snapshot with each original JSON pointer listed under `snapshot.volatile.omitted`. Unknown
nonvolatile response fields are preserved. Existing output or cache bytes are never
silently replaced, and new directories/files default to owner-only permissions.

The variable-definition endpoint is intentionally not called because Figma does not offer
a version parameter for it. Bound variable aliases in the pinned document are retained and
reported; resolving definitions belongs in a future contract that can prove provenance.

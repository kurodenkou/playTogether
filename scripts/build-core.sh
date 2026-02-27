#!/usr/bin/env bash
# =============================================================================
# build-core.sh — Compile a libretro core to WebAssembly for LibretroAdapter
# =============================================================================
#
# PREREQUISITES
# ─────────────
#   • Emscripten SDK 3.x activated in the current shell:
#       git clone https://github.com/emscripten-core/emsdk.git
#       cd emsdk && ./emsdk install latest && ./emsdk activate latest
#       source ./emsdk_env.sh        # add emcc / em++ / emmake to PATH
#
#   • GNU make, git
#   • cmake  (only for mGBA)
#
# USAGE
# ─────
#   ./scripts/build-core.sh <core-id>     compile a single core
#   ./scripts/build-core.sh --list        print available core IDs
#   ./scripts/build-core.sh --all         compile every supported core
#
# OUTPUT
# ──────
#   public/cores/<core-id>/core.js    Emscripten module glue (global Module)
#   public/cores/<core-id>/core.wasm  WebAssembly binary
#   public/cores/<core-id>/core.json  Metadata  { id, name, system }
#
# Compiled cores are served statically at /cores/<id>/core.js and picked
# up automatically by GET /api/cores and the in-game dropdown.
#
# HOW THE EMSCRIPTEN FLAGS WORK
# ──────────────────────────────
#   ALLOW_TABLE_GROWTH=1          lets _addFn() grow the WASM function table
#                                 so JS callbacks can be registered without
#                                 RESERVED_FUNCTION_POINTERS at build time.
#   ALLOW_MEMORY_GROWTH=1         heap grows on demand (cores vary 16–128 MB).
#   MODULARIZE=0                  emits a global Module = {...} rather than a
#                                 factory function; matches loadCore() design.
#   ENVIRONMENT=web               strips Node.js / Worker shims, smaller output.
#   --no-entry                    no main(); libretro cores are libraries.
#   EXPORTED_RUNTIME_METHODS      addFunction + UTF8ToString used by adapter.
#   EXPORTED_FUNCTIONS            the full libretro C API + malloc/free.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$SCRIPT_DIR/cores-src"     # git checkouts (gitignored)
OUT_ROOT="$REPO_ROOT/public/cores"  # served by Express static

mkdir -p "$SRC_DIR" "$OUT_ROOT"

# ── Supported cores ────────────────────────────────────────────────────────────
# Format: CORE_ID → (repo_url | display_name | system | build_variant)
# build_variant: "make" (default) | "cmake"

declare -A CORE_REPO CORE_NAME CORE_SYSTEM CORE_BUILD

CORE_REPO[fceumm]="https://github.com/libretro/libretro-fceumm.git"
CORE_NAME[fceumm]="FCEUmm (NES)"
CORE_SYSTEM[fceumm]="nes"
CORE_BUILD[fceumm]="make_static_override"

CORE_REPO[nestopia]="https://github.com/libretro/nestopia.git"
CORE_NAME[nestopia]="Nestopia (NES)"
CORE_SYSTEM[nestopia]="nes"
CORE_BUILD[nestopia]="make"

CORE_REPO[gambatte]="https://github.com/libretro/gambatte-libretro.git"
CORE_NAME[gambatte]="Gambatte (GB / GBC)"
CORE_SYSTEM[gambatte]="gb"
CORE_BUILD[gambatte]="make_static_override"

CORE_REPO[mgba]="https://github.com/libretro/mgba.git"
CORE_NAME[mgba]="mGBA (GBA / GB / GBC)"
CORE_SYSTEM[mgba]="gba"
CORE_BUILD[mgba]="cmake"

CORE_REPO[genesis_plus_gx]="https://github.com/libretro/Genesis-Plus-GX.git"
CORE_NAME[genesis_plus_gx]="Genesis Plus GX (MD / SMS / GG)"
CORE_SYSTEM[genesis_plus_gx]="megadrive"
CORE_BUILD[genesis_plus_gx]="make_static_override"

CORE_REPO[picodrive]="https://github.com/libretro/picodrive.git"
CORE_NAME[picodrive]="PicoDrive (MD / 32X / CD)"
CORE_SYSTEM[picodrive]="megadrive"
CORE_BUILD[picodrive]="make"

CORE_REPO[snes9x2005]="https://github.com/libretro/snes9x2005.git"
CORE_NAME[snes9x2005]="Snes9x 2005 (SNES)"
CORE_SYSTEM[snes9x2005]="snes"
CORE_BUILD[snes9x2005]="make"

CORE_REPO[beetle_pce_fast]="https://github.com/libretro/beetle-pce-fast-libretro.git"
CORE_NAME[beetle_pce_fast]="Beetle PCE Fast (PC Engine)"
CORE_SYSTEM[beetle_pce_fast]="pce"
CORE_BUILD[beetle_pce_fast]="make_static_override"

CORE_REPO[gearboy]="https://github.com/libretro/gearboy.git"
CORE_NAME[gearboy]="Gearboy (GB / GBC)"
CORE_SYSTEM[gearboy]="gb"
CORE_BUILD[gearboy]="gearboy"

CORE_REPO[fbalpha2012_cps1]="https://github.com/libretro/fbalpha2012_cps1.git"
CORE_NAME[fbalpha2012_cps1]="FB Alpha 2012 CPS-1 (Arcade)"
CORE_SYSTEM[fbalpha2012_cps1]="arcade"
CORE_BUILD[fbalpha2012_cps1]="make"

CORE_REPO[n64wasm]="https://github.com/libretro/mupen64plus-libretro-nx.git"
CORE_NAME[n64wasm]="n64wasm (Nintendo 64)"
CORE_SYSTEM[n64wasm]="n64"
CORE_BUILD[n64wasm]="n64wasm"

# ── Per-core Makefile overrides ────────────────────────────────────────────────
# CORE_MAKEDIR: subdirectory within the cloned repo that contains the Makefile.
#               Empty = repo root (the default for most cores).
declare -A CORE_MAKEDIR
CORE_MAKEDIR[nestopia]="libretro"          # libretro port lives in libretro/
CORE_MAKEDIR[gearboy]="platforms/libretro" # libretro port lives in platforms/libretro/

# CORE_MAKEFILE: Makefile filename to pass to -f.
#                Default is "Makefile"; override for cores that use Makefile.libretro.
declare -A CORE_MAKEFILE
CORE_MAKEFILE[fceumm]="Makefile.libretro"
CORE_MAKEFILE[gambatte]="Makefile.libretro"
CORE_MAKEFILE[genesis_plus_gx]="Makefile.libretro"
CORE_MAKEFILE[picodrive]="Makefile.libretro"
CORE_MAKEFILE[fbalpha2012_cps1]="makefile.libretro"  # note lowercase 'm'

# CORE_MEMORY: INITIAL_MEMORY (bytes) passed to emcc for each core.
# Default is 64 MB (67108864). N64 cores need a larger initial heap because
# the emulated system itself has 4–8 MB RAM plus plugin buffers; 256 MB gives
# comfortable headroom for the mupen64plus dynarec and texture cache.
declare -A CORE_MEMORY
CORE_MEMORY[n64wasm]="268435456"   # 256 MB

# CORE_LINK_EXTRA: additional emcc/wasm-ld flags appended verbatim to the
# link_core emcc command for specific cores (space-separated).
# n64wasm: export emscripten_GetProcAddress so the JS frontend can delegate
# retro_hw_render_callback.get_proc_address to it.  GLideN64 calls
# rglgen_resolve_symbols() with this callback to obtain WASM table indices for
# every GL entry point it uses; without it all function pointers are null and
# the core traps on the first GL call.
# --export-if-defined is safe: silently skipped if the symbol is absent.
declare -A CORE_LINK_EXTRA
CORE_LINK_EXTRA[n64wasm]='-Wl,--export-if-defined=emscripten_GetProcAddress'

# CORE_EXTRA_EXPORTS: additional symbols appended to EXPORTED_FUNCTIONS for
# specific cores.  Each value is a comma-prefixed JSON fragment so it can be
# spliced before the closing ']' of EXPORTED_FN.
# n64wasm: _emscripten_GetProcAddress must appear in EXPORTED_FUNCTIONS so
# Emscripten's JS glue creates Module._emscripten_GetProcAddress — the JS
# wrapper that the frontend uses to resolve GL function-table indices.
declare -A CORE_EXTRA_EXPORTS
CORE_EXTRA_EXPORTS[n64wasm]=',"_emscripten_GetProcAddress"'

# ── emcc exported functions (standard libretro C API + allocator) ──────────────
EXPORTED_FN='["_retro_init","_retro_deinit","_retro_get_system_info","_retro_get_system_av_info","_retro_set_environment","_retro_set_video_refresh","_retro_set_input_poll","_retro_set_input_state","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_reset","_retro_run","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_load_game","_retro_unload_game","_malloc","_free"]'

# ── Helpers ────────────────────────────────────────────────────────────────────

die()  { echo "❌  $*" >&2; exit 1; }
info() { echo "▶   $*"; }
ok()   { echo "✓   $*"; }

list_cores() {
    echo "Supported core IDs:"
    for id in $(echo "${!CORE_REPO[@]}" | tr ' ' '\n' | sort); do
        printf "  %-22s  %s  [%s]\n" "$id" "${CORE_NAME[$id]}" "${CORE_SYSTEM[$id]}"
    done
}

# ── Pre-flight checks ──────────────────────────────────────────────────────────

check_emscripten() {
    if ! command -v emcc &>/dev/null; then
        die "emcc not found. Activate emsdk first:
    git clone https://github.com/emscripten-core/emsdk.git
    cd emsdk && ./emsdk install latest && ./emsdk activate latest
    source ./emsdk_env.sh"
    fi
    local ver
    ver=$(emcc --version 2>&1 | head -1)
    info "Emscripten: $ver"
}

# ── Clone or update the core source ────────────────────────────────────────────

fetch_source() {
    local id="$1"
    local repo="${CORE_REPO[$id]}"
    local dest="$SRC_DIR/$id"

    if [[ -d "$dest/.git" ]]; then
        info "Updating $id…"
        git -C "$dest" pull --ff-only --quiet
    else
        info "Cloning $id…"
        git clone --depth=1 "$repo" "$dest" --quiet
    fi
}

# ── Find the compiled library after emmake ─────────────────────────────────────
# Emscripten outputs .a (emar archive) or .bc (older bitcode) depending on version.
# Both can be linked with emcc.

find_library() {
    local src="$1"
    # depth 5 covers repos with nested Makefile dirs (platforms/libretro/, etc.)
    local f
    f=$(find "$src" -maxdepth 5 \
        \( -name "*_libretro*.bc" -o -name "*_libretro*.a" \
           -o -name "*_libretro_emscripten*.bc" -o -name "*_libretro_emscripten*.a" \) \
        -not -path "*/node_modules/*" \
        | sort | head -1)
    [[ -z "$f" ]] && { echo ""; return; }

    # Some Makefiles (e.g. beetle_pce_fast) produce an ar static archive but
    # mis-name it *.bc.  emcc uses the extension to decide how to parse the
    # input: a .bc file is fed to clang as LLVM bitcode, so it fails with
    # "expected integer" when the real content starts with "!<arch>".
    # Detect this mismatch and rename to .a so emcc treats it as an archive.
    if [[ "$f" == *.bc ]] && head -c 7 "$f" 2>/dev/null | grep -q '^!<arch>'; then
        local fixed="${f%.bc}.a"
        mv "$f" "$fixed"
        f="$fixed"
    fi

    echo "$f"
}

# ── Build a make-based core ────────────────────────────────────────────────────

build_make() {
    local id="$1"
    local src="$SRC_DIR/$id"

    # Resolve which subdirectory and Makefile filename to use for this core.
    local subdir="${CORE_MAKEDIR[$id]:-}"
    local makefile="${CORE_MAKEFILE[$id]:-Makefile}"
    local builddir="$src${subdir:+/$subdir}"

    info "Building $id with emmake (${subdir:-.}/$makefile)…"
    # Clean prior artifacts so the Makefile runs from scratch.
    emmake make -C "$builddir" -f "$makefile" platform=emscripten clean 2>/dev/null || true
    emmake make -C "$builddir" -f "$makefile" platform=emscripten -j"$(nproc 2>/dev/null || echo 4)"
}

# ── Build mGBA (CMake-based) ───────────────────────────────────────────────────

build_cmake_mgba() {
    local src="$SRC_DIR/mgba"
    local build="$src/build-emscripten"

    info "Building mGBA with CMake + Emscripten…"
    rm -rf "$build"
    mkdir -p "$build"

    # strdup / strlcpy are POSIX/BSD extensions not visible in strict C99 mode.
    # Emscripten's musl string.h gates strdup behind _GNU_SOURCE.  Rather than
    # relying on CMake to propagate a -D flag through mGBA's internal targets,
    # we create a tiny compat header and force-include it via -include so that
    # every translation unit sees the declaration before its own #includes.
    local compat_h="$build/mgba_strcompat.h"
    printf '#ifndef _GNU_SOURCE\n#define _GNU_SOURCE\n#endif\n#include <string.h>\n' \
        > "$compat_h"

    # emcmake sets CMAKE_TOOLCHAIN_FILE and all Emscripten env vars
    # automatically.  Locating the toolchain file by path is fragile across
    # Emscripten versions (the cmake/ tree moved in 3.x).
    #
    # BUILD_LIBRETRO is intentionally OFF: when ON, mGBA's cmake declares an
    # add_library(mgba_libretro SHARED ...) target which wasm-ld 3.x rejects.
    # Whether BUILD_LIBRETRO=ON is even respected varies across mGBA fork
    # revisions (some forks reset it to OFF when EMSCRIPTEN is detected).
    # We bypass all of this by compiling src/platform/libretro/libretro.c
    # explicitly with emcc in the step below.
    emcmake cmake -S "$src" -B "$build" \
        -DBUILD_LIBRETRO=OFF \
        -DBUILD_SDL=OFF \
        -DBUILD_QT=OFF \
        -DBUILD_STATIC=ON \
        -DBUILD_TESTING=OFF \
        -DUSE_EPOXY=OFF \
        -DENABLE_SCRIPTING=OFF \
        -DUSE_LUA=OFF \
        -DENABLE_FFMPEG=OFF \
        -DENABLE_SQLITE3=OFF \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_FLAGS="-D_GNU_SOURCE -include $compat_h" \
        -DCMAKE_CXX_FLAGS="-D_GNU_SOURCE -include $compat_h"

    # Build the mGBA core library.  With all frontends disabled the only
    # target is the static 'mgba' archive.  Allow failure from any stray target.
    cmake --build "$build" -j"$(nproc 2>/dev/null || echo 4)" 2>&1 || true

    # ── Compile the libretro frontend glue explicitly ─────────────────────────
    # cmake configure (above) generates headers (mgba-version.h, config.h …)
    # into $build and $build/include/ that libretro.c needs via -I.
    # libretro.h may live next to libretro.c or inside a third-party tree.
    local libretro_c="$src/src/platform/libretro/libretro.c"
    [[ -f "$libretro_c" ]] || \
        die "mgba: src/platform/libretro/libretro.c not found — check clone"

    local libretro_h_dirs=()
    for candidate in \
            "$src/src/platform/libretro" \
            "$src/third-party/libretro-common/include" \
            "$src/libretro-common/include"; do
        [[ -d "$candidate" ]] && libretro_h_dirs+=("-I$candidate")
    done

    info "Compiling mGBA libretro interface (libretro.c)…"
    local libretro_o="$build/libretro_glue.o"
    emcc -c "$libretro_c" \
        -I"$src/include" \
        -I"$src/src" \
        -I"$build" \
        -I"$build/include" \
        "${libretro_h_dirs[@]}" \
        -D_GNU_SOURCE \
        -D__LIBRETRO__ \
        -O2 \
        -o "$libretro_o" \
        || die "mgba: libretro.c compilation failed — check include errors above"

    # Pack every compiled object (core + libretro glue) into a static archive.
    local archive="$src/mgba_libretro_emscripten.a"
    local objects
    mapfile -t objects < <(find "$build" -name "*.o" \
        -not -path "*/CMakeFiles/CMakeTmp/*" | sort)
    [[ ${#objects[@]} -gt 0 ]] || \
        die "mgba: no .o files found after cmake build — check cmake output above"

    info "Archiving ${#objects[@]} mGBA object(s) with emar…"
    rm -f "$archive"
    emar rcs "$archive" "${objects[@]}"
    [[ -f "$archive" ]] || die "mgba: emar archive step failed"
}

# ── Link to JS + WASM ─────────────────────────────────────────────────────────

link_core() {
    local id="$1"
    local bc="$2"
    local out="$OUT_ROOT/$id"

    mkdir -p "$out"
    info "Linking $id → public/cores/$id/core.js …"

    # Emscripten lazily compiles system libraries; ensure libz.a is cached
    # before linking so the explicit path below actually exists.
    embuilder build zlib

    # Pass the full path rather than -lz: emcc puts user-supplied -l flags
    # before the sysroot -L entries in the final wasm-ld invocation, so a
    # bare -lz fails to resolve.  Using the absolute path sidesteps ordering.
    local em_libz
    em_libz="$(em-config CACHE)/sysroot/lib/wasm32-emscripten/libz.a"

    local initial_mem="${CORE_MEMORY[$id]:-67108864}"
    local extra_link="${CORE_LINK_EXTRA[$id]:-}"

    # Merge core-specific extra symbols into the EXPORTED_FUNCTIONS JSON array.
    # CORE_EXTRA_EXPORTS values are comma-prefixed fragments, e.g. ',"_foo"'.
    local extra_exports="${CORE_EXTRA_EXPORTS[$id]:-}"
    local efn="${EXPORTED_FN%]}${extra_exports}]"

    emcc "$bc" -o "$out/core.js" \
        -O2 \
        --no-entry \
        -s WASM=1 \
        -s ALLOW_TABLE_GROWTH=1 \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s "INITIAL_MEMORY=$initial_mem" \
        -s MODULARIZE=0 \
        -s ENVIRONMENT=web \
        -s DISABLE_EXCEPTION_CATCHING=1 \
        -s EXPORTED_RUNTIME_METHODS='["addFunction","UTF8ToString","HEAP8","HEAP16","HEAP32","HEAPU8","HEAPU16","HEAPU32","HEAPF32","HEAPF64"]' \
        -s "EXPORTED_FUNCTIONS=$efn" \
        ${extra_link:+$extra_link} \
        "$em_libz"

    # Write metadata consumed by GET /api/cores and the UI dropdown.
    cat > "$out/core.json" <<JSON
{
  "id": "$id",
  "name": "${CORE_NAME[$id]}",
  "system": "${CORE_SYSTEM[$id]}"
}
JSON
    ok "Built: public/cores/$id/core.js  ($(du -sh "$out/core.js" | cut -f1))"
    ok "       public/cores/$id/core.wasm ($(du -sh "$out/core.wasm" | cut -f1))"
}

# ── Build cores where libretro-common is gated on STATIC_LINKING != 1 ──────────
# Several cores (gambatte, beetle_pce_fast, …) wrap their libretro-common
# sources in `ifneq ($(STATIC_LINKING), 1)` inside Makefile.common, but
# Makefile.libretro sets STATIC_LINKING = 1 for platform=emscripten, so the
# archive ends up missing filestream, file_path, compat_strl, stdstring, etc.
#
# Fix: pass STATIC_LINKING=0 on the command line to override the Makefile and
# compile every source including libretro-common.  The final link step will fail
# (emscripten shared-lib flags are wrong), but all *.o files are on disk.
# We then archive them ourselves with emar.

build_make_static_override() {
    local id="$1"
    local src="$SRC_DIR/$id"
    local subdir="${CORE_MAKEDIR[$id]:-}"
    local makefile="${CORE_MAKEFILE[$id]:-Makefile}"
    local builddir="$src${subdir:+/$subdir}"
    local archive="$src/${id}_libretro_emscripten.a"

    info "Building $id: emmake STATIC_LINKING=0 (compile all) + emar archive…"
    emmake make -C "$builddir" -f "$makefile" platform=emscripten \
        STATIC_LINKING=0 clean 2>/dev/null || true

    emmake make -C "$builddir" -f "$makefile" platform=emscripten \
        STATIC_LINKING=0 -j"$(nproc 2>/dev/null || echo 4)" 2>&1 || true

    local objects
    mapfile -t objects < <(find "$src" -name "*.o" \
        -not -path "*/node_modules/*" | sort)
    [[ ${#objects[@]} -gt 0 ]] || \
        die "$id: no .o files found — did the compilation step fail?"

    info "Archiving ${#objects[@]} $id object(s) with emar…"
    rm -f "$archive"
    emar rcs "$archive" "${objects[@]}"
    [[ -f "$archive" ]] || die "$id: emar archive step failed"
}

# ── Build gearboy (Emscripten 3.x compat) ─────────────────────────────────────
# Gearboy's platforms/libretro/Makefile links with `em++ --relocatable` to
# produce a .bc side-module.  Newer wasm-ld rejects --relocatable entirely.
#
# Workaround: run emmake as usual — the per-file compile rules (*.cpp → *.o)
# succeed; we suppress the final link failure with `|| true`.  Then we use
# `emar` to pack all the resulting WASM object files into a static archive,
# which the final `link_core` emcc step accepts normally.

build_gearboy() {
    local src="$SRC_DIR/gearboy"
    local builddir="$src/platforms/libretro"
    local archive="$builddir/gearboy_libretro_emscripten.a"

    info "Building gearboy: emmake (compile phase) + emar archive…"
    emmake make -C "$builddir" platform=emscripten clean 2>/dev/null || true

    # The link step will fail (--relocatable not supported by wasm-ld ≥ 3.x);
    # that is expected.  Individual .cpp → .o compilation should succeed.
    emmake make -C "$builddir" platform=emscripten \
        -j"$(nproc 2>/dev/null || echo 4)" 2>&1 || true

    # Gather all WASM object files produced under the source tree.
    local objects
    mapfile -t objects < <(find "$src" -name "*.o" \
        -not -path "*/node_modules/*" | sort)
    [[ ${#objects[@]} -gt 0 ]] || \
        die "gearboy: no .o files found — did the compilation step fail?"

    info "Archiving ${#objects[@]} gearboy object(s) with emar…"
    emar rcs "$archive" "${objects[@]}"
    [[ -f "$archive" ]] || die "gearboy: emar archive step failed"
}

# ── Build mupen64plus-next (n64wasm) ─────────────────────────────────────────
# mupen64plus-libretro-nx requires special handling for three reasons:
#
#   1. The Makefile has no 'platform=emscripten' case; passing it causes the
#      libretro interface translation unit (retro_init, retro_run, …) to be
#      compiled under a code-path that omits those symbols.  Omitting the flag
#      lets emmake's CC=emcc / CXX=em++ override take effect directly.
#
#   2. The x86/x86-64 JIT dynarec is incompatible with WebAssembly.
#      HAVE_DYNAREC=0 and WITH_DYNAREC= disable both the compile-time enable
#      flag and the architecture-selection variable used by the Makefile.
#
#   3. STATIC_LINKING=1 tells the Makefile to target a .a static archive and
#      skip the shared-lib (.so) link step that wasm-ld cannot satisfy.
#      For this core the libretro symbols are NOT gated behind STATIC_LINKING,
#      so there is no missing-symbol risk from using it (unlike gambatte etc.).

build_n64wasm() {
    local src="$SRC_DIR/n64wasm"
    local archive="$src/n64wasm_libretro_emscripten.a"

    info "Building n64wasm: emmake HAVE_DYNAREC=0 STATIC_LINKING=1 + emar archive…"
    emmake make -C "$src" clean 2>/dev/null || true

    # mupen64plus-core/src/api/debugger.c uses tentative (common) symbol
    # declarations (e.g. bare `int op;`) which WebAssembly does not support.
    # Emscripten rejects them with "common symbols are not yet implemented for
    # Wasm", causing make to abort before libretro.cpp is compiled — which is
    # why retro_init etc. end up missing from the archive.
    #
    # EMCC_CFLAGS is appended by emcc to every compilation regardless of what
    # the Makefile sets for CFLAGS, making it the safest injection point.
    # -fno-common turns tentative definitions into explicit BSS allocations,
    # which are fully supported by wasm-ld.
    EMCC_CFLAGS="-fno-common" emmake make -C "$src" \
        HAVE_DYNAREC=0 \
        WITH_DYNAREC= \
        STATIC_LINKING=1 \
        -j"$(nproc 2>/dev/null || echo 4)" 2>&1 || true

    local objects
    mapfile -t objects < <(find "$src" -name "*.o" \
        -not -path "*/node_modules/*" | sort)
    [[ ${#objects[@]} -gt 0 ]] || \
        die "n64wasm: no .o files found — did the compilation step fail?"

    info "Archiving ${#objects[@]} n64wasm object(s) with emar…"
    rm -f "$archive"
    emar rcs "$archive" "${objects[@]}"
    [[ -f "$archive" ]] || die "n64wasm: emar archive step failed"

    # Five symbols are referenced by the archive but absent in a
    # HAVE_DYNAREC=0 + software-only build, causing wasm-ld to abort:
    #
    #   glReadBuffer      – OpenGL ES 3.0 function in glsm.c; never reached
    #                       because the frontend returns false for
    #                       RETRO_ENVIRONMENT_SET_HW_RENDER.
    #   sem_timedwait     – POSIX timed semaphore in opengl_Wrapper.c;
    #                       absent from Emscripten libc; same dead HW-render
    #                       code path.
    #   dynarec_jump_to   – JIT entry point in r4300_core.c; compiled in even
    #   dyna_jump           with HAVE_DYNAREC=0 but never executed when the
    #   dyna_stop           pure interpreter is active.
    #
    # Compile minimal no-op stubs and append them to the archive so wasm-ld
    # can resolve all symbols without suppressing real undefined-symbol errors.
    local stubs_c="$src/n64wasm_stubs.c"
    cat > "$stubs_c" <<'STUBS'
/* n64wasm_stubs.c — dead-code stubs for a HAVE_DYNAREC=0, SW-render build.
 * None of these are reachable at runtime:
 *   - glReadBuffer / sem_timedwait: only live behind SET_HW_RENDER, which
 *     the JS frontend rejects.
 *   - dynarec_*: only live when the JIT is active; HAVE_DYNAREC=0 keeps
 *     execution in the interpreter.
 */
#include <stdint.h>

void glReadBuffer(unsigned int mode)                         { (void)mode; }
int  sem_timedwait(void *sem, const void *abstime)           { (void)sem; (void)abstime; return -1; }
void dynarec_jump_to(uint32_t addr)                          { (void)addr; }
void dyna_jump(void)                                         {}
void dyna_stop(int exc)                                      { (void)exc; }
STUBS

    local stubs_o="$src/n64wasm_stubs.o"
    emcc -O2 -c "$stubs_c" -o "$stubs_o" \
        || die "n64wasm: stub compilation failed"
    emar r "$archive" "$stubs_o" \
        || die "n64wasm: failed to add stubs to archive"
    info "Appended n64wasm stubs (glReadBuffer, sem_timedwait, dynarec symbols)"
}

# ── Compile one core end-to-end ────────────────────────────────────────────────

build_core() {
    local id="$1"
    [[ -v CORE_REPO[$id] ]] || die "Unknown core: '$id'. Run --list to see options."

    fetch_source "$id"

    case "${CORE_BUILD[$id]}" in
        cmake)
            case "$id" in
                mgba) build_cmake_mgba ;;
                *)    die "No cmake build handler for '$id'" ;;
            esac
            ;;
        make_static_override)
            build_make_static_override "$id"
            ;;
        gearboy)
            build_gearboy
            ;;
        n64wasm)
            build_n64wasm
            ;;
        *)
            build_make "$id"
            ;;
    esac

    local bc
    bc=$(find_library "$SRC_DIR/$id")
    [[ -n "$bc" ]] || die "Could not find compiled library for '$id' after build.
Hint: check the emmake output above; the .bc / .a filename may differ."

    link_core "$id" "$bc"
}

# ── Entry point ────────────────────────────────────────────────────────────────

case "${1:-}" in
    --list)
        list_cores
        ;;
    --all)
        check_emscripten
        for id in $(echo "${!CORE_REPO[@]}" | tr ' ' '\n' | sort); do
            echo ""
            echo "════════════════════════════════════════"
            echo "  $id — ${CORE_NAME[$id]}"
            echo "════════════════════════════════════════"
            build_core "$id" || echo "⚠  $id failed — continuing"
        done
        echo ""
        ok "Done. Run the server and open /api/cores to verify."
        ;;
    "")
        echo "Usage: $0 <core-id>  |  --list  |  --all"
        list_cores
        exit 1
        ;;
    *)
        check_emscripten
        build_core "$1"
        ;;
esac

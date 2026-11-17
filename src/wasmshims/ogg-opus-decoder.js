// Workers shim: preloads the WRAPPER decoder with a precompiled wasm module.
// Wrangler imports each `.wasm` here as a compiled WebAssembly.Module. The
// underlying packages then instantiate with `WebAssembly.instantiate(module,
// imports)` — no dynamic codegen, which workerd forbids.
import { OpusDecoder } from "opus-decoder";
import opusWasmModule from "../../vendor/wasm-bin/opus.wasm";

OpusDecoder.module = opusWasmModule;

export { OggOpusDecoder, OggOpusDecoderWebWorker } from "ogg-opus-decoder";

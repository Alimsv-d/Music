// Workers shim: preloads the decoder with a precompiled wasm module (see
// ogg-opus-decoder.js shim for the explanation).
import { MPEGDecoder } from "mpg123-decoder";
import mp3WasmModule from "../../vendor/wasm-bin/mp3.wasm";

MPEGDecoder.module = mp3WasmModule;

export { MPEGDecoder } from "mpg123-decoder";

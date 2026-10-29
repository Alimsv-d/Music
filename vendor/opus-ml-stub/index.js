// Stub: the real opus-ml package ships an 8 MB neural-net WASM model that is
// imported dynamically by ogg-opus-decoder ONLY when `{ enableMachineLearning:
// true }` is passed to the decoder constructor. The bot never enables it, so
// these named exports are unreachable. Vendored as a lightweight replacement
// to keep the Worker bundle below the 3 MB free-plan limit.
export default {};
export const OpusMLDecoder = undefined;
export const OpusMLDecoderWebWorker = undefined;

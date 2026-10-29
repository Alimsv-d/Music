// Replaces @eshaz/web-worker in the Workers bundle: the real package evaluates
// `module.exports = Worker` at module load, but the Workers runtime has no
// Worker constructor (CF error 10021). Our decoders run inline WASM and never
// spawn workers, so the stub only satisfies the import.
export default class StubWorker {
  constructor() {
    throw new Error("@eshaz/web-worker is stubbed for the Workers bundle");
  }
}

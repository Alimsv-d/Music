import fs from "fs";
import { WASMAudioDecoderCommon } from "@wasm-audio-decoders/common";
import EmscriptenWasmOpus from "../node_modules/opus-decoder/src/EmscriptenWasm.js";
import EmscriptenWasmMpg from "../node_modules/mpg123-decoder/src/EmscriptenWasm.js";

new WASMAudioDecoderCommon();
for (const [Ems, name] of [[EmscriptenWasmOpus, "opus"], [EmscriptenWasmMpg, "mp3"]]) {
  new Ems(WASMAudioDecoderCommon);
  const bytes = await WASMAudioDecoderCommon.inflateDynEncodeString(Ems.wasm);
  fs.writeFileSync(`/home/aliwsubnitro/opencode_tmp/wasmext/${name}.wasm`, bytes);
  console.log(name, bytes.length, bytes.slice(0, 4).join(","));
}

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const wasmSource = (bytes) => `const b = Uint8Array.from(atob("${Buffer.from(bytes).toString("base64")}"), (c) => c.charCodeAt(0));
export default new WebAssembly.Module(b);
`;

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith(".wasm")) {
		const parent = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
		const target = specifier.startsWith(".")
			? new URL(specifier, parent)
			: new URL("file://" + path.resolve(specifier));
		return { shortCircuit: true, url: target.href, format: "module" };
	}
	if (specifier === "node:module") return nextResolve(specifier, context);
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.endsWith(".wasm")) {
		const bytes = new Uint8Array(await fs.promises.readFile(fileURLToPath(url)));
		return { format: "module", shortCircuit: true, source: wasmSource(bytes) };
	}
	return nextLoad(url, context);
}

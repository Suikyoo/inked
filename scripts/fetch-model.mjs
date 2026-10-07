// Downloads the pinned embedding model and the ONNX runtime WASM into <outDir> and writes manifest.json.
// Usage: node scripts/fetch-model.mjs <outDir> [--pin]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = 'Xenova/bge-small-en-v1.5';
export const MODEL = 'bge-small-en-v1.5';
export const REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
/** sha256 of each FILES entry at REVISION; regenerate with --pin when REVISION changes. */
export const PINNED = {
  'config.json': 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  'onnx/model_quantized.onnx': '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
};
/** The ORT runtime pair transformers.js loads (the default onnxruntime-web entry is the JSEP build). */
export const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function manifestFor({ revision, ortVersion, files }) {
  const rev8 = revision.slice(0, 8);
  return { model: MODEL, id: `${MODEL}@${rev8}`, revision, modelPath: `${rev8}/`, ortPath: `ort-${ortVersion}/`, files };
}

async function main() {
  const [outDir, flag] = process.argv.slice(2);
  if (!outDir) throw new Error('usage: fetch-model.mjs <outDir> [--pin]');
  const pin = flag === '--pin';
  const rev8 = REVISION.slice(0, 8);
  const files = [];
  const hashes = {};
  for (const f of FILES) {
    const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${f}`);
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hex = sha256(buf);
    hashes[f] = hex;
    if (!pin && PINNED[f] !== hex) throw new Error(`${f}: sha256 ${hex} does not match the pinned value`);
    const rel = `${rev8}/${MODEL}/${f}`;
    mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    writeFileSync(path.join(outDir, rel), buf);
    files.push({ path: rel, sha256: hex, bytes: buf.length });
  }
  if (pin) {
    console.log(JSON.stringify(hashes, null, 2));
    return;
  }
  const require = createRequire(new URL('../web/package.json', import.meta.url));
  // The package exports map hides package.json; its resolved entry sits in <pkg>/dist.
  const ortDir = path.dirname(path.dirname(require.resolve('onnxruntime-web')));
  const ortVersion = JSON.parse(readFileSync(path.join(ortDir, 'package.json'), 'utf8')).version;
  for (const name of ORT_FILES) {
    const rel = `ort-${ortVersion}/${name}`;
    mkdirSync(path.join(outDir, `ort-${ortVersion}`), { recursive: true });
    copyFileSync(path.join(ortDir, 'dist', name), path.join(outDir, rel));
    const buf = readFileSync(path.join(outDir, rel));
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifestFor({ revision: REVISION, ortVersion, files }), null, 2));
  console.log(`model ${MODEL}@${rev8} and ORT ${ortVersion} written to ${outDir}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

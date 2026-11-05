import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const COMPRESSIBLE = /\.(js|css|html|svg)$/;

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

for (const path of walk(DIST).filter((file) => COMPRESSIBLE.test(file))) {
  const content = readFileSync(path);
  writeFileSync(`${path}.br`, brotliCompressSync(content));
  writeFileSync(`${path}.gz`, gzipSync(content, { level: 9 }));
}

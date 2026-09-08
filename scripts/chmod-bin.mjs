import { chmodSync, existsSync } from 'node:fs';
const bin = new URL('../dist/cli.js', import.meta.url);
if (existsSync(bin)) chmodSync(bin, 0o755);

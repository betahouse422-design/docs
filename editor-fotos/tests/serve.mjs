// Servidor para desarrollo y pruebas. Uso: node tests/serve.mjs [puerto] [--lan] [--buzon=carpeta]
// (la implementación está en tools/servidor.mjs)
import { fileURLToPath } from 'node:url';
import { startServer, cli } from '../tools/servidor.mjs';

export { startServer };

if (process.argv[1] === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));

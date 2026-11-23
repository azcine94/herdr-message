import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function compileElectronMain() {
  const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [tscBin, '-p', 'tsconfig.electron.json'], {
      cwd: rootDir,
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`Electron TypeScript build failed with code ${code}`));
    });
  });
}

async function main() {
  await compileElectronMain();

  const viteServer = await createServer({
    root: rootDir,
    configFile: path.join(rootDir, 'vite.config.ts'),
  });
  await viteServer.listen();

  const address = viteServer.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5179;
  const devUrl = `http://localhost:${port}`;

  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronBinary = require('electron');
  const child = spawn(String(electronBinary), ['.'], {
    cwd: rootDir,
    stdio: 'inherit',
    env,
  });

  const shutdown = async () => {
    await viteServer.close().catch(() => {});
  };

  child.on('exit', async (code) => {
    await shutdown();
    process.exit(code ?? 0);
  });

  process.on('SIGINT', async () => {
    child.kill();
    await shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Entry point for `node --test test/` on Node builds that resolve the
// directory argument as a module instead of discovering test files inside it.
// `test/package.json` points its `main` here. The file lives outside `test/`,
// so bare `node --test` discovery never runs the tests twice.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

// One test file that fails to IMPORT must not hide every file after it: each
// module is loaded on its own and a load failure becomes one failing test.
const { test } = await import('node:test');
for (const file of testFiles) {
  try {
    await import(pathToFileURL(join(testDirectory, file)).href);
  } catch (error) {
    test(`load ${file}`, () => {
      throw error;
    });
  }
}

import fs from 'node:fs';

/** The package version, read from package.json (two levels up from src/core or dist/core). */
export function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const liveSpecs = [
  'tests/e2e/live.spec.js',
  'tests/e2e/live-matrix.spec.js',
  'tests/e2e/live-hardware.spec.js'
];

describe('optional live-test harness', () => {
  it.each(liveSpecs)('%s imports only current built artifacts', (spec) => {
    const source = fs.readFileSync(spec, 'utf8');
    const artifacts = [...source.matchAll(/fs\.readFile\('([^']+)'/g)].map((match) => match[1]);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact).toBe('dist/userscript/Grocery Price Per Unit.user.js');
      expect(fs.existsSync(artifact), `Missing live-test artifact: ${artifact}`).toBe(true);
    }
    expect(source).toContain('addInitScript');
    expect(source).not.toContain('addScriptTag');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const workflowPath = '.github/workflows/release-userscript.yml';

describe('userscript release workflow', () => {
  it('builds, verifies, and publishes the package version from a main-branch push', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('npm run check');
    expect(workflow).toContain('npm run userscript:verify');
    expect(workflow).toContain("require('./package.json').version");
    expect(workflow).toContain('gh release create "$TAG"');
    expect(workflow).toContain('Grocery-Price-Per-Unit.user.js.sha256');
  });
});

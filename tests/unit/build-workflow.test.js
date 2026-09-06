import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const workflowPath = '.github/workflows/build-userscript.yml';

describe('userscript build workflow', () => {
  it('builds, verifies, and commits the userscript from a main-branch push', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('paths-ignore: [dist/**]');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('npm run check');
    expect(workflow).toContain('npm run userscript:verify');
    expect(workflow).toContain('git add dist/Grocery-Price-Per-Unit.user.js');
    expect(workflow).toContain('chore: build userscript [skip ci]');
    expect(workflow).not.toContain('gh release');
  });
});

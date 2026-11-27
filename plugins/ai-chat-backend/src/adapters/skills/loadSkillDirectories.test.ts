/*
 * Copyright 2026 The backstage-plugin-ai-chat Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mockServices } from '@backstage/backend-test-utils';
import type { StepContext } from '@kwkevinchan/ai-chat-harness';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDirectories, mergeSkills } from './loadSkillDirectories';
import { MAX_SKILL_FILE_BYTES } from './skillMarkdown';

function stepCtx(signal = new AbortController().signal): StepContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    agentId: 'default',
    step: 1,
    principal: { userRef: 'user:default/alice' },
    signal,
  };
}

describe('loadSkillsFromDirectories (X-04, D-22)', () => {
  const createdDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ai-chat-skills-'));
    createdDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads valid SKILL.md metadata, skips hidden/empty folders, and reads body lazily on load()', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'SKILL.md'), 'ignored');
    await mkdir(join(root, 'empty-dir'));
    await writeFile(join(root, 'README.md'), 'not a subdir');

    const skillDir = join(root, 'deploy-failure');
    await mkdir(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    await writeFile(
      skillPath,
      `\uFEFF---\r\nname: deploy-failure\r\ndescription: >-\r\n  Diagnose failed\r\n  deployments cleanly.\r\nlicense: Apache-2.0\r\nmetadata:\r\n  team: sre\r\n---\r\n# Initial Body\r\nCheck pod events first.\r\n`,
    );

    const logger = mockServices.logger.mock();
    const skills = await loadSkillsFromDirectories([root], logger);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('deploy-failure');
    expect(skills[0].description).toBe('Diagnose failed deployments cleanly.');

    // Updating the file before calling load() confirms startup did not cache body content.
    await writeFile(
      skillPath,
      `---\nname: deploy-failure\ndescription: Diagnose failed deployments cleanly.\n---\n# Lazy Loaded Body\nUpdated steps.`,
    );
    await expect(skills[0].load(stepCtx())).resolves.toBe(
      '# Lazy Loaded Body\nUpdated steps.',
    );
  });

  it('logs a warning and throws a sanitized error when SKILL.md vanishes before load()', async () => {
    const root = await makeTempDir();
    const skillDir = join(root, 'volatile-skill');
    await mkdir(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    await writeFile(
      skillPath,
      '---\nname: volatile-skill\ndescription: Disappears.\n---\nBody',
    );

    const logger = mockServices.logger.mock();
    const [skill] = await loadSkillsFromDirectories([root], logger);
    await rm(skillPath);

    await expect(skill.load(stepCtx())).rejects.toThrow(
      'Could not load skill volatile-skill.',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to load skill volatile-skill',
      expect.any(Object),
    );
  });

  it('rejects missing directory, non-directory entry, malformed frontmatter, mismatched name, empty body, and oversize files', async () => {
    const logger = mockServices.logger.mock();
    const missing = join(tmpdir(), 'definitely-missing-skills-dir-xyz');
    await expect(loadSkillsFromDirectories([missing], logger)).rejects.toThrow(
      /cannot be read/,
    );

    const fileInstead = join(await makeTempDir(), 'not-a-dir.txt');
    await writeFile(fileInstead, 'hi');
    await expect(
      loadSkillsFromDirectories([fileInstead], logger),
    ).rejects.toThrow(/is not a directory/);

    const badRoot = await makeTempDir();
    await mkdir(join(badRoot, 'bad-frontmatter'));
    await writeFile(join(badRoot, 'bad-frontmatter', 'SKILL.md'), '# No FM');
    await expect(loadSkillsFromDirectories([badRoot], logger)).rejects.toThrow(
      /must start with YAML frontmatter/,
    );

    const mismatchRoot = await makeTempDir();
    await mkdir(join(mismatchRoot, 'dir-a'));
    await writeFile(
      join(mismatchRoot, 'dir-a', 'SKILL.md'),
      '---\nname: dir-b\ndescription: Mismatch\n---\nBody',
    );
    await expect(
      loadSkillsFromDirectories([mismatchRoot], logger),
    ).rejects.toThrow(/must match directory name 'dir-a'/);

    const emptyBodyRoot = await makeTempDir();
    await mkdir(join(emptyBodyRoot, 'empty-body'));
    await writeFile(
      join(emptyBodyRoot, 'empty-body', 'SKILL.md'),
      '---\nname: empty-body\ndescription: Empty body\n---\n   \n',
    );
    await expect(
      loadSkillsFromDirectories([emptyBodyRoot], logger),
    ).rejects.toThrow(/body must not be empty/);

    const hugeRoot = await makeTempDir();
    await mkdir(join(hugeRoot, 'huge-skill'));
    await writeFile(
      join(hugeRoot, 'huge-skill', 'SKILL.md'),
      `---\nname: huge-skill\ndescription: Too large\n---\n${'x'.repeat(
        MAX_SKILL_FILE_BYTES + 10,
      )}`,
    );
    await expect(loadSkillsFromDirectories([hugeRoot], logger)).rejects.toThrow(
      /exceeds maximum size/,
    );
  });

  it('rejects duplicate skill ids across directories and between directory and modules', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    for (const dir of [dirA, dirB]) {
      await mkdir(join(dir, 'dup-skill'));
      await writeFile(
        join(dir, 'dup-skill', 'SKILL.md'),
        '---\nname: dup-skill\ndescription: Dup\n---\nBody',
      );
    }
    const logger = mockServices.logger.mock();
    await expect(
      loadSkillsFromDirectories([dirA, dirB], logger),
    ).rejects.toThrow('skill dup-skill is already defined');

    const loadedA = await loadSkillsFromDirectories([dirA], logger);
    expect(() =>
      mergeSkills(loadedA, [
        { id: 'dup-skill', description: 'From module', load: () => 'x' },
      ]),
    ).toThrow('skill dup-skill is already defined');
  });
});

describe('loadSkillsFromDirectories with symbolic links', () => {
  const createdDirs: string[] = [];
  const skillText = (name: string) =>
    `---\nname: ${name}\ndescription: Linked skill.\n---\nOutside body`;

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ai-chat-skills-link-'));
    createdDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a skill directory that links outside the configured directory', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await mkdir(join(outside, 'linked'));
    await writeFile(join(outside, 'linked', 'SKILL.md'), skillText('linked'));
    await symlink(join(outside, 'linked'), join(root, 'linked'), 'dir');

    await expect(
      loadSkillsFromDirectories([root], mockServices.logger.mock()),
    ).rejects.toThrow(/linked: resolves outside the skills directory/);
  });

  it('refuses a SKILL.md that links outside the configured directory', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, 'SKILL.md'), skillText('linked'));
    await mkdir(join(root, 'linked'));
    await symlink(join(outside, 'SKILL.md'), join(root, 'linked', 'SKILL.md'));

    await expect(
      loadSkillsFromDirectories([root], mockServices.logger.mock()),
    ).rejects.toThrow(
      /linked\/SKILL\.md: resolves outside the skills directory/,
    );
  });

  it('accepts links that stay inside the configured directory', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared', 'body.md'), skillText('linked'));
    await mkdir(join(root, 'linked'));
    await symlink(
      join(root, 'shared', 'body.md'),
      join(root, 'linked', 'SKILL.md'),
    );

    const skills = await loadSkillsFromDirectories(
      [root],
      mockServices.logger.mock(),
    );
    expect(skills.map(skill => skill.id)).toEqual(['linked']);
    await expect(skills[0].load(stepCtx())).resolves.toBe('Outside body');
  });

  it('does not read a SKILL.md that was linked outside after startup', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await mkdir(join(root, 'linked'));
    const skillFile = join(root, 'linked', 'SKILL.md');
    await writeFile(skillFile, skillText('linked'));
    await writeFile(join(outside, 'SKILL.md'), skillText('linked'));
    const logger = mockServices.logger.mock();
    const [skill] = await loadSkillsFromDirectories([root], logger);

    await unlink(skillFile);
    await symlink(join(outside, 'SKILL.md'), skillFile);

    await expect(skill.load(stepCtx())).rejects.toThrow(
      'Could not load skill linked.',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to load skill linked',
      expect.objectContaining({
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'resolves outside its directory',
    );
  });
});

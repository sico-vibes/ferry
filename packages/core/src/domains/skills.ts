import { SkillManager } from '@ferry/extensions';
import { SkillIdSchema, SkillSchema } from '@ferry/shared';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

export function createSkillManager(services: FerryServices, projectPath: string): SkillManager {
  const enabled = services.settings.get('skill-enabled');
  const saved =
    typeof enabled === 'object' && enabled !== null ? (enabled as Record<string, unknown>) : {};
  return new SkillManager({
    projectPath,
    userSkillsPath: services.paths.skills,
    getEnabled: (skill) =>
      typeof saved[skill.name] === 'boolean' ? (saved[skill.name] as boolean) : undefined,
    onEnabledChange: (skill, value) => {
      services.settings.put('skill-enabled', { ...saved, [skill.name]: value });
    },
  });
}

export function register(host: CoreHost, services: FerryServices): void {
  let manager: SkillManager | undefined;
  const getManager = async () => {
    manager ??= createSkillManager(services, services.workspaces.list()[0]?.path ?? process.cwd());
    await manager.load();
    return manager;
  };
  host.registerDomain('skills', {
    async list() {
      return (await getManager()).list().map((skill) => SkillSchema.parse(skill));
    },
    async setEnabled(rawId: unknown, rawEnabled: unknown) {
      const id = SkillIdSchema.parse(rawId);
      if (typeof rawEnabled !== 'boolean')
        throw rpcDomainError(-32010, 'validation', 'Enabled must be a boolean');
      const skills = await getManager();
      const skill = skills.list().find((item) => item.id === id);
      if (!skill) throw rpcDomainError(-32044, 'not_found', `Skill not found: ${id}`);
      await skills.setEnabled(skill.name, rawEnabled);
      return SkillSchema.parse(skills.list().find((item) => item.id === id));
    },
  });
}

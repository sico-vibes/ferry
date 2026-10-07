import { SkillManager } from '@ferry/extensions';
import { SkillIdSchema, SkillSchema } from '@ferry/shared';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const managers = new WeakMap<FerryServices, Map<string, SkillManager>>();

export function removeSkillManager(services: FerryServices, projectPath: string): void {
  managers.get(services)?.delete(projectPath);
}

export function createSkillManager(services: FerryServices, projectPath: string): SkillManager {
  let workspaceManagers = managers.get(services);
  if (!workspaceManagers) {
    workspaceManagers = new Map();
    managers.set(services, workspaceManagers);
  }
  const existing = workspaceManagers.get(projectPath);
  if (existing) return existing;
  const saved = () => {
    const enabled = services.settings.get('skill-enabled');
    return typeof enabled === 'object' && enabled !== null
      ? (enabled as Record<string, unknown>)
      : {};
  };
  const manager = new SkillManager({
    projectPath,
    userSkillsPath: services.paths.skills,
    getEnabled: (skill) =>
      typeof saved()[skill.name] === 'boolean' ? (saved()[skill.name] as boolean) : undefined,
    onEnabledChange: (skill, value) => {
      services.settings.put('skill-enabled', { ...saved(), [skill.name]: value });
    },
  });
  workspaceManagers.set(projectPath, manager);
  return manager;
}

export function register(host: CoreHost, services: FerryServices): void {
  const getManager = async () => {
    const manager = createSkillManager(
      services,
      services.workspaces.list()[0]?.path ?? process.cwd(),
    );
    await manager.load();
    return manager;
  };
  host.onShutdown(() => {
    managers.delete(services);
  });
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

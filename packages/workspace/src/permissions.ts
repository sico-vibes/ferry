import path from 'node:path';
import { z } from 'zod';

export const PermissionModeSchema = z.enum(['ask', 'auto_edit', 'full_auto']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const PermissionRuleSchema = z.object({
  effect: z.enum(['allow', 'ask', 'deny']),
  tool: z.string(),
  pattern: z.string().optional(),
  level: z.enum(['project', 'user']),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}
export const ActionSchema = z.object({
  tool: z.string().min(1),
  path: z.string().optional(),
  command: z.string().optional(),
});
export type Action = z.infer<typeof ActionSchema>;
const credentialPattern =
  /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|[^\\/]+\.(?:pem|key|p12|pfx|jks)|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials(?:\.[^\\/]*)?|secrets?\.[^\\/]*|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.aws[\\/]credentials|\.azure[\\/][^\\/]+|\.kube[\\/]config|\.docker[\\/]config\.json|\.config[\\/]gh[\\/]hosts\.yml|\.config[\\/]gcloud[\\/]application_default_credentials\.json|\.ssh[\\/]known_hosts)(?:$|[\\/])/i;
const destructiveCommand = [
  /\bremove-item\b(?=.*-recurse)(?=.*(?:[a-z]:\\(?:$|\s)|\\\\|\/))/i,
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\bdel\b(?=.*\/s)(?=.*\/q)(?:\s+\/\w+)*\s+(?:[a-z]:\\windows|[a-z]:\\|\\\\)/i,
  /\bgit\s+push\b(?=.*(?:--force|-f\b))/i,
  /\b(?:iex|invoke-expression)\s*\(?\s*(?:iwr|invoke-webrequest)\b/i,
  /\breg(?:\.exe)?\s+(?:add|delete|import)\b/i,
  /\b(?:set-itemproperty|new-itemproperty|remove-itemproperty)\b.*\b(hklm|hkcu|registry::)/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-encodedcommand\b/i,
];
export function classifyDangerousCommand(command: string, workspace: string): string | undefined {
  const segments = command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) continue;
    for (const rule of destructiveCommand)
      if (rule.test(segment)) return `Dangerous command segment: ${segment}`;
    if (/\bcurl\b/i.test(segment) && /\b(sh|bash)\b/i.test(segments[index + 1] ?? ''))
      return `Download piped to shell: ${segment}`;
    if (/\bremove-item\b/i.test(segment) && /-recurse/i.test(segment)) {
      const target =
        /(?:^|\s)([a-z]:\\(?:[^\s]*)?|\\\\[^\s]+|\/[^\s]*|\.\.?|\$env:[\w]+|\$[\w]+)/i.exec(
          segment,
        )?.[1];
      if (
        target &&
        (target.startsWith('$') || !withinWorkspace(path.resolve(workspace, target), workspace))
      )
        return `Destructive path is outside workspace: ${target}`;
    }
    const rm =
      /\brm\b(?=[^\n]*(?:-[^\s]*r|\s-r\b))(?=[^\n]*(?:-[^\s]*f|\s-f\b))(?:\s+-[^\s]+)*\s+([^\s]+)/i.exec(
        segment,
      )?.[1];
    if (rm && /^(?:\/|[a-z]:\\|\\\\)/i.test(rm) && !withinWorkspace(rm, workspace))
      return `Destructive path is outside workspace: ${rm}`;
  }
  return undefined;
}
export function evaluatePermission(
  action: Action,
  options: { mode: PermissionMode; rules?: PermissionRule[]; workspace: string },
): PermissionDecision {
  if (action.path && credentialPattern.test(action.path))
    return { decision: 'deny', reason: 'Credential and secret files are protected' };
  if (action.command) {
    const danger = classifyDangerousCommand(action.command, options.workspace);
    if (danger) {
      return options.mode === 'full_auto'
        ? { decision: 'deny', reason: danger }
        : { decision: 'ask', reason: `Danger warning: ${danger}` };
    }
  }
  const rules = options.rules ?? [];
  // Project rules override user rules; within a level, the last matching rule wins.
  const matching = rules.filter(
    (rule) =>
      (rule.tool === '*' || rule.tool === action.tool) &&
      (!rule.pattern || match(rule.pattern, action.command ?? action.path ?? '')),
  );
  matching.sort((a, b) => (a.level === 'project' ? 1 : 0) - (b.level === 'project' ? 1 : 0));
  const selected = matching.at(-1);
  if (selected)
    return {
      decision: selected.effect,
      reason: `${selected.level} rule ${selected.effect} for ${selected.tool}`,
    };
  if (
    action.tool === 'read_file' ||
    action.tool === 'list_dir' ||
    action.tool === 'glob' ||
    action.tool === 'grep' ||
    action.tool === 'git_status' ||
    action.tool === 'git_diff'
  )
    return { decision: 'allow', reason: 'Read-only workspace operation' };
  if (options.mode === 'full_auto') return { decision: 'allow', reason: 'Full-auto mode' };
  if (
    options.mode === 'auto_edit' &&
    ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file'].includes(action.tool)
  )
    return { decision: 'allow', reason: 'Workspace edit allowed by auto-edit mode' };
  return {
    decision: 'ask',
    reason:
      options.mode === 'ask' ? 'Ask mode requires confirmation' : 'Command requires confirmation',
  };
}
function withinWorkspace(target: string, workspace: string): boolean {
  if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) return true;
  const relative = path.win32.relative(path.win32.resolve(workspace), path.win32.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}
function match(pattern: string, value: string): boolean {
  if (pattern.endsWith('*'))
    return value.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  return pattern.toLowerCase() === value.toLowerCase();
}

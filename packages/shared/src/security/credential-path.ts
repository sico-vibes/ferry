const credentialPattern =
  /(^|[\\/])(?:\.env[^\\/]*|[^\\/]+\.(?:pem|key|p12|pfx|jks)|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials(?:\.[^\\/]*)?|secrets?\.[^\\/]*|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.aws[\\/](?:credentials|config)|\.azure[\\/][^\\/]+|\.kube[\\/]config|\.docker[\\/]config\.json|\.config[\\/]gh[\\/]hosts\.yml|\.config[\\/]gcloud[\\/]application_default_credentials\.json|\.ssh[\\/](?:known_hosts|id_[^\\/]+)|\.gnupg[\\/][^\\/]+|keyrings?[\\/][^\\/]+)(?:$|[\\/])/i;

export function isProtectedWorkspacePath(value: string): boolean {
  return credentialPattern.test(value);
}
